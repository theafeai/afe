/**
 * Test/bench helper: stores many validated events quickly (one multi-row
 * INSERT per chunk instead of one transaction per event). Same columns and
 * seq allocation as `ingestEvent`; no raw payloads. Never used by the server.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { EVENT_SCHEMA_VERSION, parseEventInput, type CanonicalEventInputLike } from "@afe/core";

export async function bulkInsertEvents(
  pool: pg.Pool,
  tenantId: string,
  inputs: CanonicalEventInputLike[],
  chunk = 2000,
): Promise<number> {
  const parsed = inputs.map((i) => parseEventInput(i));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ last_seq: string }>(
      `INSERT INTO event_sequences (tenant_id, last_seq) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET last_seq = event_sequences.last_seq + $2
       RETURNING last_seq`,
      [tenantId, parsed.length],
    );
    let seq = Number(rows[0]!.last_seq) - parsed.length;
    const recordedAt = new Date().toISOString();
    for (let i = 0; i < parsed.length; i += chunk) {
      const rowsJson = parsed.slice(i, i + chunk).map((e) => ({
        id: randomUUID(),
        seq: ++seq,
        source: e.source,
        source_event_id: e.sourceEventId,
        connection_id: e.connectionId ?? null,
        action: e.action,
        actor: e.actor,
        target: e.target,
        trigger: e.trigger,
        outcome: e.outcome,
        occurred_at: e.occurredAt,
        observed_at: e.observedAt,
        observation: e.observation,
        correlation: e.correlation,
        data: e.data,
      }));
      await client.query(
        `INSERT INTO events (
           id, tenant_id, seq, schema_version, source, source_event_id, connection_id, action,
           actor, target, trigger, outcome, occurred_at, observed_at, recorded_at, observation,
           correlation, data)
         SELECT r.id, $1, r.seq, $2, r.source, r.source_event_id, r.connection_id, r.action,
                r.actor, r.target, r.trigger, r.outcome, r.occurred_at, r.observed_at, $3,
                r.observation, r.correlation, r.data
           FROM jsonb_to_recordset($4::jsonb) AS r(
             id uuid, seq bigint, source text, source_event_id text, connection_id text,
             action text, actor jsonb, target jsonb, trigger jsonb, outcome text,
             occurred_at timestamptz, observed_at timestamptz, observation jsonb,
             correlation jsonb, data jsonb)`,
        [tenantId, EVENT_SCHEMA_VERSION, recordedAt, JSON.stringify(rowsJson)],
      );
    }
    await client.query("COMMIT");
    return parsed.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
