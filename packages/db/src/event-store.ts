/**
 * Event store: the only code that writes the `events` and `raw_payloads`
 * tables (migrations 0002, 0021). Events are immutable once written; the only
 * deletion is the retention purge (retention.ts). See ADR 0003, ADR 0008 and
 * docs/event-model.md.
 */
import {
  buildStoredEvent,
  isOutsideRetention,
  parseEventInput,
  rawPayloadBytes,
  sha256Hex,
  type CanonicalEvent,
  type CanonicalEventInputLike,
  type EventSink,
  type IngestResult,
  type RawPayloadRef,
  type RetentionPolicy,
} from "@afe/core";
import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Anything that can run a query: a pool or a checked-out client. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export const EVENT_COLUMNS = `
  e.id, e.tenant_id, e.seq, e.schema_version, e.source, e.source_event_id, e.connection_id,
  e.action, e.actor, e.target, e.trigger, e.outcome, e.occurred_at, e.observed_at,
  e.recorded_at, e.observation, e.correlation, e.data, e.raw_payload_id,
  e.raw_payload_sha256`;

export interface EventRow {
  id: string;
  tenant_id: string;
  seq: string;
  schema_version: number;
  source: string;
  source_event_id: string;
  connection_id: string | null;
  action: string;
  actor: CanonicalEvent["actor"];
  target: CanonicalEvent["target"];
  trigger: CanonicalEvent["trigger"];
  outcome: CanonicalEvent["outcome"];
  occurred_at: Date;
  observed_at: Date;
  recorded_at: Date;
  observation: CanonicalEvent["observation"];
  correlation: CanonicalEvent["correlation"];
  data: CanonicalEvent["data"];
  raw_payload_id: string | null;
  raw_payload_sha256: string | null;
}

export function rowToEvent(r: EventRow): CanonicalEvent {
  return {
    schemaVersion: r.schema_version as CanonicalEvent["schemaVersion"],
    id: r.id,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    source: r.source,
    sourceEventId: r.source_event_id,
    connectionId: r.connection_id,
    action: r.action,
    actor: r.actor,
    target: r.target,
    trigger: r.trigger,
    outcome: r.outcome,
    occurredAt: r.occurred_at.toISOString(),
    observedAt: r.observed_at.toISOString(),
    recordedAt: r.recorded_at.toISOString(),
    observation: r.observation,
    correlation: r.correlation,
    data: r.data,
    rawPayload:
      r.raw_payload_id === null
        ? null
        : { id: r.raw_payload_id, sha256: r.raw_payload_sha256 as string },
  };
}

export async function getEvent(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<CanonicalEvent | null> {
  const { rows } = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e WHERE e.tenant_id = $1 AND e.id = $2`,
    [tenantId, id],
  );
  return rows[0] ? rowToEvent(rows[0]) : null;
}

/** Looks an event up by its idempotency key. */
export async function findEventBySourceId(
  db: Queryable,
  tenantId: string,
  source: string,
  sourceEventId: string,
): Promise<CanonicalEvent | null> {
  const { rows } = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e
      WHERE e.tenant_id = $1 AND e.source = $2 AND e.source_event_id = $3`,
    [tenantId, source, sourceEventId],
  );
  return rows[0] ? rowToEvent(rows[0]) : null;
}

export interface IngestOptions {
  /** Events outside this policy's window are dropped (`status: "expired"`). Default: keep all. */
  retention?: RetentionPolicy;
  now?: () => Date;
}

/**
 * Validates and stores one event.
 *
 * Idempotent on (tenantId, source, sourceEventId): if the event already exists
 * (e.g. it arrived by polling before the webhook, or vice versa) nothing is
 * written and the stored event is returned with `status: "duplicate"`. The
 * first arrival wins: its observation method, observedAt and raw payload are
 * kept.
 *
 * An event whose occurredAt is already before the tenant's retention cutoff
 * is not stored (`status: "expired"`), so lookbacks and re-deliveries cannot
 * bring back events the retention purge removed.
 *
 * `seq` comes from the tenant's `event_sequences` row, which stays locked
 * until the transaction commits: a tenant's seq order is its commit order.
 * Different tenants do not block each other.
 *
 * Throws `EventValidationError` for invalid input.
 */
export async function ingestEvent(
  pool: pg.Pool,
  tenantId: string,
  input: CanonicalEventInputLike,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const parsed = parseEventInput(input);

  // Fast path for duplicates: no lock needed.
  const existing = await findEventBySourceId(pool, tenantId, parsed.source, parsed.sourceEventId);
  if (existing) return { status: "duplicate", inserted: false, event: existing };

  const now = options.now?.() ?? new Date();
  const cutoff = options.retention ? await options.retention.cutoff(tenantId, now) : null;
  if (isOutsideRetention(parsed.occurredAt, cutoff)) {
    return { status: "expired", inserted: false, event: null };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const next = await client.query<{ last_seq: string }>(
      `INSERT INTO event_sequences (tenant_id, last_seq) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_seq = event_sequences.last_seq + 1
       RETURNING last_seq`,
      [tenantId],
    );
    const seq = Number(next.rows[0]!.last_seq);

    // Re-check under the lock: a concurrent ingest of the same event may have
    // committed while we waited (READ COMMITTED sees it now).
    const dup = await findEventBySourceId(client, tenantId, parsed.source, parsed.sourceEventId);
    if (dup) {
      await client.query("ROLLBACK");
      return { status: "duplicate", inserted: false, event: dup };
    }

    let rawRef: RawPayloadRef | null = null;
    if (parsed.rawPayload) {
      const body = rawPayloadBytes(parsed.rawPayload.body);
      rawRef = { id: randomUUID(), sha256: sha256Hex(body) };
      await client.query(
        `INSERT INTO raw_payloads (id, tenant_id, source, content_type, body, sha256, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          rawRef.id,
          tenantId,
          parsed.source,
          parsed.rawPayload.contentType,
          Buffer.from(body.buffer, body.byteOffset, body.byteLength),
          rawRef.sha256,
          body.byteLength,
        ],
      );
    }

    const event = buildStoredEvent({ tenantId, seq, input: parsed, rawPayload: rawRef });

    await client.query(
      `INSERT INTO events (
         id, tenant_id, seq, schema_version, source, source_event_id, connection_id, action,
         actor, target, trigger, outcome, occurred_at, observed_at, recorded_at, observation,
         correlation, data, raw_payload_id, raw_payload_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        event.id,
        event.tenantId,
        event.seq,
        event.schemaVersion,
        event.source,
        event.sourceEventId,
        event.connectionId,
        event.action,
        JSON.stringify(event.actor),
        JSON.stringify(event.target),
        JSON.stringify(event.trigger),
        event.outcome,
        event.occurredAt,
        event.observedAt,
        event.recordedAt,
        JSON.stringify(event.observation),
        JSON.stringify(event.correlation),
        JSON.stringify(event.data),
        event.rawPayload?.id ?? null,
        event.rawPayload?.sha256 ?? null,
      ],
    );
    await client.query("COMMIT");
    return { status: "inserted", inserted: true, event };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Defensive: should not happen under the sequence lock, but if a unique
    // key race slips through, report the stored event as a duplicate.
    if ((err as { constraint?: string }).constraint === "events_source_event_key") {
      const stored = await findEventBySourceId(pool, tenantId, parsed.source, parsed.sourceEventId);
      if (stored) return { status: "duplicate", inserted: false, event: stored };
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The PostgreSQL `EventSink` that connectors are given. With `retention`,
 * events outside the window are dropped at ingestion.
 */
export function createPgEventSink(pool: pg.Pool, options: IngestOptions = {}): EventSink {
  return { ingest: (tenantId, input) => ingestEvent(pool, tenantId, input, options) };
}

export interface ListEventsOptions {
  /** Only events with occurredAt >= from. */
  occurredFrom?: string | Date;
  /** Only events with occurredAt < to. */
  occurredTo?: string | Date;
  /** `nextCursor` from a previous page. */
  cursor?: string | null;
  /** Page size, default 100, max 1000. */
  limit?: number;
  /** Order by seq (storage order). Default "asc". */
  order?: "asc" | "desc";
}

export interface EventPage {
  events: CanonicalEvent[];
  /** Pass as `cursor` to get the next page; null when there are no more. */
  nextCursor: string | null;
}

/**
 * Lists a tenant's events in storage (seq) order, optionally filtered by
 * occurredAt range, with keyset pagination. Deliberately minimal; the full
 * query API is AFE-14.
 */
export async function listEvents(
  db: Queryable,
  tenantId: string,
  options: ListEventsOptions = {},
): Promise<EventPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
  const desc = options.order === "desc";
  const params: unknown[] = [tenantId];
  const where = ["e.tenant_id = $1"];
  if (options.occurredFrom !== undefined) {
    params.push(new Date(options.occurredFrom).toISOString());
    where.push(`e.occurred_at >= $${params.length}`);
  }
  if (options.occurredTo !== undefined) {
    params.push(new Date(options.occurredTo).toISOString());
    where.push(`e.occurred_at < $${params.length}`);
  }
  if (options.cursor) {
    params.push(decodeCursor(options.cursor));
    where.push(`e.seq ${desc ? "<" : ">"} $${params.length}`);
  }
  params.push(limit + 1);
  const { rows } = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events e WHERE ${where.join(" AND ")}
      ORDER BY e.seq ${desc ? "DESC" : "ASC"} LIMIT $${params.length}`,
    params,
  );
  const events = rows.slice(0, limit).map(rowToEvent);
  const last = events.at(-1);
  return {
    events,
    nextCursor: rows.length > limit && last ? encodeCursor(last.seq) : null,
  };
}

function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const { s } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s: unknown };
    if (typeof s === "number" && Number.isSafeInteger(s) && s >= 0) return s;
  } catch {
    // fall through
  }
  throw new Error("invalid cursor");
}
