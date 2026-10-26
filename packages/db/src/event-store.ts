/**
 * Event store: the only code that writes the append-only `events` and
 * `raw_payloads` tables (migration 0002). See ADR 0003 and docs/event-model.md.
 */
import {
  buildChainedEvent,
  ChainVerifier,
  GENESIS_HASH,
  parseEventInput,
  rawPayloadBytes,
  sha256Hex,
  type CanonicalEvent,
  type CanonicalEventInputLike,
  type ChainVerification,
  type EventSink,
  type IngestResult,
  type RawPayloadRef,
} from "@afe/core";
import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Anything that can run a query: a pool or a checked-out client. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

const EVENT_COLUMNS = `
  e.id, e.tenant_id, e.seq, e.schema_version, e.source, e.source_event_id, e.connection_id,
  e.action, e.actor, e.target, e.trigger, e.outcome, e.occurred_at, e.observed_at,
  e.recorded_at, e.observation, e.correlation, e.data, e.raw_payload_id,
  e.raw_payload_sha256, e.prev_hash, e.hash`;

interface EventRow {
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
  prev_hash: string;
  hash: string;
}

function rowToEvent(r: EventRow): CanonicalEvent {
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
    prevHash: r.prev_hash,
    hash: r.hash,
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

/**
 * Validates and appends one event to the tenant's hash chain.
 *
 * Idempotent on (tenantId, source, sourceEventId): if the event already exists
 * (e.g. it arrived by polling before the webhook, or vice versa) nothing is
 * written and the stored event is returned with `inserted: false`. The first
 * arrival wins: its observation method, observedAt and raw payload are kept.
 *
 * Appends for one tenant are serialised by locking the tenant's row in
 * `event_chain_heads` (FOR UPDATE) for the duration of the transaction, so
 * concurrent ingestion always produces a gap-free, correctly linked chain.
 * Different tenants do not block each other.
 *
 * Throws `EventValidationError` for invalid input.
 */
export async function ingestEvent(
  pool: pg.Pool,
  tenantId: string,
  input: CanonicalEventInputLike,
): Promise<IngestResult> {
  const parsed = parseEventInput(input);

  // Fast path for duplicates: no lock needed.
  const existing = await findEventBySourceId(pool, tenantId, parsed.source, parsed.sourceEventId);
  if (existing) return { inserted: false, event: existing };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO event_chain_heads (tenant_id, seq, hash) VALUES ($1, 0, $2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, GENESIS_HASH],
    );
    const head = await client.query<{ seq: string; hash: string }>(
      "SELECT seq, hash FROM event_chain_heads WHERE tenant_id = $1 FOR UPDATE",
      [tenantId],
    );
    const { seq: headSeq, hash: headHash } = head.rows[0]!;

    // Re-check under the lock: a concurrent ingest of the same event may have
    // committed while we waited (READ COMMITTED sees it now).
    const dup = await findEventBySourceId(client, tenantId, parsed.source, parsed.sourceEventId);
    if (dup) {
      await client.query("COMMIT");
      return { inserted: false, event: dup };
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

    const event = buildChainedEvent({
      tenantId,
      seq: Number(headSeq) + 1,
      prevHash: headHash,
      input: parsed,
      rawPayload: rawRef,
    });

    await client.query(
      `INSERT INTO events (
         id, tenant_id, seq, schema_version, source, source_event_id, connection_id, action,
         actor, target, trigger, outcome, occurred_at, observed_at, recorded_at, observation,
         correlation, data, raw_payload_id, raw_payload_sha256, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
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
        event.prevHash,
        event.hash,
      ],
    );
    await client.query(
      "UPDATE event_chain_heads SET seq = $2, hash = $3, updated_at = now() WHERE tenant_id = $1",
      [tenantId, event.seq, event.hash],
    );
    await client.query("COMMIT");
    return { inserted: true, event };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Defensive: should not happen under the head lock, but if a unique key
    // race slips through, report the stored event as a duplicate.
    if ((err as { constraint?: string }).constraint === "events_source_event_key") {
      const stored = await findEventBySourceId(pool, tenantId, parsed.source, parsed.sourceEventId);
      if (stored) return { inserted: false, event: stored };
    }
    throw err;
  } finally {
    client.release();
  }
}

/** The PostgreSQL `EventSink` that connectors are given. */
export function createPgEventSink(pool: pg.Pool): EventSink {
  return { ingest: (tenantId, input) => ingestEvent(pool, tenantId, input) };
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
  /** Order by seq (log order). Default "asc". */
  order?: "asc" | "desc";
}

export interface EventPage {
  events: CanonicalEvent[];
  /** Pass as `cursor` to get the next page; null when there are no more. */
  nextCursor: string | null;
}

/**
 * Lists a tenant's events in log (seq) order, optionally filtered by
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

export interface VerifyTenantChainOptions {
  /** Rows read per query. Default 1000. */
  batchSize?: number;
  /** Also recompute SHA-256 of every referenced raw payload. Default true. */
  checkRawPayloads?: boolean;
}

/**
 * Verifies a tenant's whole audit log from the database: recomputes every
 * event hash, checks seq continuity and prevHash links, checks each raw
 * payload's bytes against the sha256 in its event, and compares the last event
 * with the stored chain head. Runs in one REPEATABLE READ snapshot so
 * concurrent appends do not cause false alarms. Returns the first break.
 */
export async function verifyTenantChain(
  pool: pg.Pool,
  tenantId: string,
  options: VerifyTenantChainOptions = {},
): Promise<ChainVerification> {
  const batchSize = options.batchSize ?? 1000;
  const checkRaw = options.checkRawPayloads ?? true;
  const verifier = new ChainVerifier({ tenantId });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let after = 0;
    let index = 0;
    for (;;) {
      const { rows } = await client.query<EventRow & { raw_actual: string | null }>(
        `SELECT ${EVENT_COLUMNS},
                ${checkRaw ? "encode(sha256(r.body), 'hex')" : "NULL::text"} AS raw_actual
           FROM events e
           LEFT JOIN raw_payloads r ON r.tenant_id = e.tenant_id AND r.id = e.raw_payload_id
          WHERE e.tenant_id = $1 AND e.seq > $2
          ORDER BY e.seq LIMIT $3`,
        [tenantId, after, batchSize],
      );
      for (const row of rows) {
        const event = rowToEvent(row);
        if (verifier.push(event)) return verifier.result();
        if (checkRaw && event.rawPayload && row.raw_actual !== event.rawPayload.sha256) {
          verifier.fail({
            kind: "raw_payload_mismatch",
            index,
            seq: event.seq,
            eventId: event.id,
            expected: event.rawPayload.sha256,
            actual: row.raw_actual,
            message:
              row.raw_actual === null
                ? "raw payload is missing"
                : "raw payload bytes do not match the hash recorded in the event",
          });
          return verifier.result();
        }
        index += 1;
        after = event.seq;
      }
      if (rows.length < batchSize) break;
    }

    const result = verifier.result();
    const head = await client.query<{ seq: string; hash: string }>(
      "SELECT seq, hash FROM event_chain_heads WHERE tenant_id = $1",
      [tenantId],
    );
    const h = head.rows[0];
    const headSeq = h ? Number(h.seq) : 0;
    const headHash = h ? h.hash : GENESIS_HASH;
    if (headSeq !== result.lastSeq || headHash !== result.lastHash) {
      verifier.fail({
        kind: "head_mismatch",
        seq: headSeq,
        eventId: null,
        expected: `${headSeq}:${headHash}`,
        actual: `${result.lastSeq}:${result.lastHash}`,
        message:
          headSeq > result.lastSeq
            ? `chain head is at seq ${headSeq} but the log ends at ${result.lastSeq}: events were removed from the end`
            : "chain head does not match the last event",
      });
    }
    return verifier.result();
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
