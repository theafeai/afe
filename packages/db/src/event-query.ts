/**
 * Event query layer (AFE-14): filtered, keyset-paginated reads of the
 * `events` table and raw payload access. Every function is tenant-scoped
 * (rules R5).
 *
 * Filter semantics are defined once in `@afe/core` (`EventFilter`,
 * `eventMatchesFilter`); the SQL here must select exactly the same events.
 */
import {
  actionPrefix,
  canonicalJson,
  expandRefs,
  filterFingerprint,
  repositoryFilterKey,
  type CanonicalEvent,
  type EventFilter,
  type EventAccessRule,
} from "@afe/core";
import { EVENT_COLUMNS, rowToEvent, type EventRow, type Queryable } from "./event-store.ts";

export type EventOrder = "desc" | "asc";

export class InvalidCursorError extends Error {
  constructor(message = "invalid or mismatched cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/** Builds the WHERE fragments for a filter (alias `e`), appending bind values to `params`. */
export function eventFilterSql(filter: EventFilter, params: unknown[]): string[] {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  const any = (expr: string, values: string[] | undefined) => {
    if (values) where.push(`${expr} = ANY(${p(values)}::text[])`);
  };
  const contains = (key: string, values: string[]) =>
    values.map((v) => `e.correlation @> ${p(canonicalJson({ [key]: [v] }))}::jsonb`);
  const or = (parts: string[]) => where.push(`(${parts.join(" OR ")})`);
  const f = filter;

  any("e.source", f.sources);
  if (f.actions) {
    const exact = f.actions.filter((a) => !actionPrefix(a));
    const parts = f.actions
      .map(actionPrefix)
      .filter((x): x is string => x !== null)
      .map((prefix) => `e.action LIKE ${p(prefix.replace(/[\\%_]/g, "\\$&") + "%")} ESCAPE '\\'`);
    if (exact.length) parts.push(`e.action = ANY(${p(exact)}::text[])`);
    or(parts);
  }
  if (f.actors) {
    const ids = p(f.actors);
    const logins = p(f.actors.map((a) => a.toLowerCase()));
    or(
      ["e.actor", "e.actor -> 'onBehalfOf'", "e.actor -> 'triggeredBy'"].flatMap((ref) => [
        `${ref} ->> 'id' = ANY(${ids}::text[])`,
        `lower(${ref} ->> 'login') = ANY(${logins}::text[])`,
      ]),
    );
  }
  any("e.actor ->> 'id'", f.actorIds);
  any("lower(e.actor ->> 'login')", f.actorLogins);
  any("e.actor ->> 'type'", f.actorTypes);
  any("e.target ->> 'type'", f.targetTypes);
  any("e.target ->> 'id'", f.targetIds);
  any("e.target ->> 'name'", f.targetNames);
  if (f.environments) {
    or([
      `lower(e.target ->> 'environment') = ANY(${p(f.environments)}::text[])`,
      ...contains("environments", f.environments),
    ]);
  }
  if (f.repositories) {
    const keys = f.repositories.map(repositoryFilterKey).filter((k): k is string => k !== null);
    or([
      `lower(e.target ->> 'repository') = ANY(${p(f.repositories.map((r) => r.toLowerCase()))}::text[])`,
      ...contains("repositories", [...new Set(keys)]),
    ]);
  }
  any("e.target ->> 'project'", f.projects);
  any("e.target ->> 'application'", f.applications);
  any("e.target ->> 'cluster'", f.clusters);
  any("e.target ->> 'namespace'", f.namespaces);
  if (f.refs) {
    const refs = expandRefs(f.refs);
    or([`e.target ->> 'ref' = ANY(${p(refs)}::text[])`, ...contains("refs", refs)]);
  }
  any("e.trigger ->> 'type'", f.triggerTypes);
  any("e.outcome", f.outcomes);
  any("e.observation ->> 'method'", f.observationMethods);
  any("e.connection_id", f.connectionIds);
  any("e.source_event_id", f.sourceEventIds);
  if (f.commitShas) {
    or(
      f.commitShas.map((sha) =>
        sha.length === 40 || sha.length === 64
          ? `e.correlation @> ${p(canonicalJson({ commitShas: [sha] }))}::jsonb`
          : `EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.correlation -> 'commitShas') c
                      WHERE c LIKE ${p(`${sha}%`)})`,
      ),
    );
  }
  if (f.imageRefs) or(contains("imageRefs", f.imageRefs));
  if (f.imageDigests) or(contains("imageDigests", f.imageDigests));
  if (f.deploymentIds) or(contains("deploymentIds", f.deploymentIds));
  if (f.runIds) or(contains("runIds", f.runIds));
  if (f.pullRequests) or(contains("pullRequests", f.pullRequests));
  if (f.occurredFrom) where.push(`e.occurred_at >= ${p(f.occurredFrom)}::timestamptz`);
  if (f.occurredTo) where.push(`e.occurred_at < ${p(f.occurredTo)}::timestamptz`);
  if (f.recordedFrom) where.push(`e.recorded_at >= ${p(f.recordedFrom)}::timestamptz`);
  if (f.recordedTo) where.push(`e.recorded_at < ${p(f.recordedTo)}::timestamptz`);
  if (f.seqFrom !== undefined) where.push(`e.seq >= ${p(f.seqFrom)}`);
  if (f.seqTo !== undefined) where.push(`e.seq <= ${p(f.seqTo)}`);
  return where;
}

/** Resource authorization is an AND constraint, independent of caller-supplied filters. */
export function eventAccessSql(
  rules: readonly EventAccessRule[] | undefined,
  params: unknown[],
): string {
  if (rules === undefined) return "TRUE";
  if (rules.length === 0) return "FALSE";
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  return (
    "(" +
    rules
      .map((rule) => {
        const colon = rule.resource.indexOf(":");
        const kind = rule.resource.slice(0, colon),
          value = rule.resource.slice(colon + 1);
        const fields: Record<string, string> = {
          connection: "e.connection_id",
          repository: "lower(e.target ->> 'repository')",
          project: "e.target ->> 'project'",
          application: "e.target ->> 'application'",
        };
        const field = fields[kind];
        if (!field || !value) return "FALSE";
        return `(e.source = ${bind(rule.source)} AND ${field} = ${bind(kind === "repository" ? value.toLowerCase() : value)}${rule.connectionId ? ` AND e.connection_id = ${bind(rule.connectionId)}` : ""}${rule.targetId ? ` AND e.target ->> 'id' = ${bind(rule.targetId)}` : ""})`;
      })
      .join(" OR ") +
    ")"
  );
}

interface CursorState {
  /** occurredAt of the last row returned. */
  o: string;
  /** seq of the last row returned. */
  s: number;
  /** Snapshot: highest seq visible to this traversal. */
  h: number;
  /** Fingerprint of filter + order the cursor belongs to. */
  k: string;
}

function encodeCursor(c: CursorState): string {
  return Buffer.from(JSON.stringify({ v: 1, ...c })).toString("base64url");
}

function decodeCursor(cursor: string, fingerprint: string): CursorState {
  let c: Record<string, unknown>;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new InvalidCursorError();
  }
  const isSeq = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (
    c?.v !== 1 ||
    typeof c.o !== "string" ||
    Number.isNaN(Date.parse(c.o)) ||
    new Date(c.o).toISOString() !== c.o ||
    !isSeq(c.s) ||
    !isSeq(c.h) ||
    typeof c.k !== "string"
  ) {
    throw new InvalidCursorError();
  }
  // A cursor only continues the query it was issued for.
  if (c.k !== fingerprint) throw new InvalidCursorError("cursor belongs to a different query");
  return { o: c.o, s: c.s as number, h: c.h as number, k: c.k };
}

export interface QueryEventsOptions {
  access?: readonly EventAccessRule[];
  filter?: EventFilter;
  /** By occurredAt (ties broken by seq). Default "desc" (newest first). */
  order?: EventOrder;
  /** Default 100, clamped to 1..1000. */
  limit?: number;
  cursor?: string | null;
}

export interface QueryEventsPage {
  events: CanonicalEvent[];
  nextCursor: string | null;
  /**
   * The seq the traversal is pinned to: events stored after the first page
   * (seq > snapshotSeq) never appear in later pages, so pages are stable
   * under concurrent inserts. (Events purged by retention meanwhile simply
   * do not appear.)
   */
  snapshotSeq: number;
}

/** The tenant's highest allocated seq (0 when it has never stored an event). */
export async function getLatestSeq(db: Queryable, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ last_seq: string }>(
    "SELECT last_seq FROM event_sequences WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0] ? Number(rows[0].last_seq) : 0;
}

/**
 * Filtered keyset pagination over (occurredAt, seq). The cursor is opaque
 * base64url JSON bound to the filter and order (a cursor from another query
 * is rejected) and pinned to the seq snapshot of the first page. Tampering
 * with a cursor cannot widen access: the tenant and filter always come from
 * the request.
 */
export async function queryEvents(
  db: Queryable,
  tenantId: string,
  options: QueryEventsOptions = {},
): Promise<QueryEventsPage> {
  const filter = options.filter ?? {};
  const order: EventOrder = options.order === "asc" ? "asc" : "desc";
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
  const fingerprint = filterFingerprint(filter, {
    order,
    access: JSON.stringify(options.access ?? null),
  });
  const cursor = options.cursor ? decodeCursor(options.cursor, fingerprint) : null;
  const snapshotSeq = cursor ? cursor.h : await getLatestSeq(db, tenantId);

  const params: unknown[] = [tenantId];
  const where = [
    "e.tenant_id = $1",
    ...eventFilterSql(filter, params),
    eventAccessSql(options.access, params),
  ];
  params.push(snapshotSeq);
  where.push(`e.seq <= $${params.length}`);
  if (cursor) {
    params.push(cursor.o, cursor.s);
    where.push(
      `(e.occurred_at, e.seq) ${order === "desc" ? "<" : ">"} ($${params.length - 1}::timestamptz, $${params.length})`,
    );
  }
  params.push(limit + 1);
  const dir = order === "desc" ? "DESC" : "ASC";
  const { rows } = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e WHERE ${where.join(" AND ")}
      ORDER BY e.occurred_at ${dir}, e.seq ${dir} LIMIT $${params.length}`,
    params,
  );
  const events = rows.slice(0, limit).map(rowToEvent);
  const last = events.at(-1);
  return {
    events,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ o: last.occurredAt, s: last.seq, h: snapshotSeq, k: fingerprint })
        : null,
    snapshotSeq,
  };
}

export interface StoredRawPayload {
  id: string;
  source: string;
  contentType: string;
  sizeBytes: number;
  /** sha256 of the body, recorded when stored. */
  sha256: string;
  receivedAt: string;
  body: Buffer;
}

export async function getRawPayload(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<StoredRawPayload | null> {
  const { rows } = await db.query<{
    id: string;
    source: string;
    content_type: string;
    size_bytes: number;
    sha256: string;
    received_at: Date;
    body: Buffer;
  }>(
    `SELECT id, source, content_type, size_bytes, sha256, received_at, body
       FROM raw_payloads WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    source: r.source,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    receivedAt: r.received_at.toISOString(),
    body: r.body,
  };
}
