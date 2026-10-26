/**
 * Audit query layer (AFE-14): filtered, keyset-paginated reads of the
 * append-only `events` table, raw payload access, chain head lookups and
 * consistent export snapshots. Every function is tenant-scoped (rules R5).
 *
 * Filter semantics are defined once in `@afe/core` (`EventFilter`,
 * `eventMatchesFilter`); the SQL here must select exactly the same events.
 */
import {
  actionPrefix,
  canonicalJson,
  expandRefs,
  filterFingerprint,
  GENESIS_HASH,
  repositoryFilterKey,
  sha256Hex,
  type CanonicalEvent,
  type ChainHead,
  type EventFilter,
  type ExportRecord,
} from "@afe/core";
import type pg from "pg";
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
   * The chain seq the traversal is pinned to: events appended after the first
   * page (seq > snapshotSeq) never appear in later pages, so pages are stable
   * under concurrent inserts.
   */
  snapshotSeq: number;
}

export async function getChainHead(db: Queryable, tenantId: string): Promise<ChainHead> {
  const { rows } = await db.query<{ seq: string; hash: string }>(
    "SELECT seq, hash FROM event_chain_heads WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]
    ? { seq: Number(rows[0].seq), hash: rows[0].hash }
    : { seq: 0, hash: GENESIS_HASH };
}

/**
 * Filtered keyset pagination over (occurredAt, seq). The cursor is opaque
 * base64url JSON bound to the filter and order (a cursor from another query
 * is rejected) and pinned to the chain snapshot of the first page. Tampering
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
  const fingerprint = filterFingerprint(filter, { order });
  const cursor = options.cursor ? decodeCursor(options.cursor, fingerprint) : null;
  const snapshotSeq = cursor ? cursor.h : (await getChainHead(db, tenantId)).seq;

  const params: unknown[] = [tenantId];
  const where = ["e.tenant_id = $1", ...eventFilterSql(filter, params)];
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

export async function getEventBySeq(
  db: Queryable,
  tenantId: string,
  seq: number,
): Promise<CanonicalEvent | null> {
  const { rows } = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.tenant_id = $1 AND e.seq = $2`,
    [tenantId, seq],
  );
  return rows[0] ? rowToEvent(rows[0]) : null;
}

export interface StoredRawPayload {
  id: string;
  source: string;
  contentType: string;
  sizeBytes: number;
  /** sha256 recorded when stored. */
  sha256: string;
  /** sha256 of the bytes as read now. */
  actualSha256: string;
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
    actualSha256: sha256Hex(r.body),
    receivedAt: r.received_at.toISOString(),
    body: r.body,
  };
}

export interface EventExportSnapshot {
  /** The chain head in the same snapshot as `records`. */
  chainHead: ChainHead;
  /** Matching events in ascending seq order. Iterate once; the snapshot closes when done. */
  records: AsyncGenerator<ExportRecord>;
  /** Releases the snapshot early (idempotent). */
  close(): Promise<void>;
}

/**
 * Opens a REPEATABLE READ, read-only snapshot and streams the events matching
 * `filter` in seq order, together with the chain head of that same snapshot,
 * so the export's proof is consistent however many events are appended
 * meanwhile.
 */
export async function openEventExport(
  pool: pg.Pool,
  tenantId: string,
  filter: EventFilter,
  options: { includeRawPayloads?: boolean; batchSize?: number } = {},
): Promise<EventExportSnapshot> {
  const batchSize = options.batchSize ?? 500;
  const client = await pool.connect();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  };
  let chainHead: ChainHead;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    chainHead = await getChainHead(client, tenantId);
  } catch (err) {
    await close();
    throw err;
  }

  async function* records(): AsyncGenerator<ExportRecord> {
    try {
      let after = 0;
      for (;;) {
        const params: unknown[] = [tenantId];
        const where = ["e.tenant_id = $1", ...eventFilterSql(filter, params)];
        params.push(after, chainHead.seq, batchSize);
        const n = params.length;
        const { rows } = await client.query<
          EventRow & { raw_body: Buffer | null; raw_content_type: string | null }
        >(
          `SELECT ${EVENT_COLUMNS},
                  ${options.includeRawPayloads ? "r.body" : "NULL::bytea"} AS raw_body,
                  r.content_type AS raw_content_type
             FROM events e
             LEFT JOIN raw_payloads r ON r.tenant_id = e.tenant_id AND r.id = e.raw_payload_id
            WHERE ${where.join(" AND ")} AND e.seq > $${n - 2} AND e.seq <= $${n - 1}
            ORDER BY e.seq LIMIT $${n}`,
          params,
        );
        for (const row of rows) {
          const event = rowToEvent(row);
          yield {
            event,
            rawPayload:
              row.raw_body && row.raw_content_type
                ? { contentType: row.raw_content_type, body: new Uint8Array(row.raw_body) }
                : null,
          };
          after = event.seq;
        }
        if (rows.length < batchSize) break;
      }
    } finally {
      await close();
    }
  }

  return { chainHead, records: records(), close };
}
