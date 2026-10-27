/**
 * Retention purge (ADR 0008): deletes a tenant's events whose occurredAt is
 * before a cutoff, together with their raw payloads, in small batches so the
 * purge never holds long locks. Run by the `retention.purge` job.
 */
import type pg from "pg";
import type { Queryable } from "./event-store.ts";

export interface PurgeOptions {
  /** Events deleted per statement/transaction. Default 1000. */
  batchSize?: number;
  /** Upper bound of batches per call, so one run stays short. Default 100. */
  maxBatches?: number;
}

export interface PurgeResult {
  events: number;
  rawPayloads: number;
  /** True when maxBatches was reached and older events remain. */
  more: boolean;
}

/** Tenants that have stored events. */
export async function listTenantsWithEvents(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM event_sequences ORDER BY tenant_id",
  );
  return rows.map((r) => r.tenant_id);
}

/**
 * Deletes the tenant's events with occurred_at < cutoff and the raw payloads
 * they referenced, then raw payloads of the tenant received before the cutoff
 * that no event references (left over from interrupted writes).
 */
export async function purgeEventsBefore(
  pool: pg.Pool,
  tenantId: string,
  cutoff: Date,
  options: PurgeOptions = {},
): Promise<PurgeResult> {
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? 1000));
  const maxBatches = Math.max(1, Math.trunc(options.maxBatches ?? 100));
  const result: PurgeResult = { events: 0, rawPayloads: 0, more: false };

  for (let batch = 0; ; batch++) {
    if (batch >= maxBatches) {
      result.more = true;
      return result;
    }
    const client = await pool.connect();
    let deleted: number;
    try {
      await client.query("BEGIN");
      const ev = await client.query<{ raw_payload_id: string | null }>(
        `DELETE FROM events
          WHERE id IN (
            SELECT id FROM events
             WHERE tenant_id = $1 AND occurred_at < $2
             ORDER BY occurred_at
             LIMIT $3
             FOR UPDATE SKIP LOCKED)
        RETURNING raw_payload_id`,
        [tenantId, cutoff.toISOString(), batchSize],
      );
      deleted = ev.rowCount ?? 0;
      const rawIds = ev.rows.map((r) => r.raw_payload_id).filter((id): id is string => !!id);
      if (rawIds.length > 0) {
        const raw = await client.query(
          "DELETE FROM raw_payloads WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [tenantId, rawIds],
        );
        result.rawPayloads += raw.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    result.events += deleted;
    if (deleted < batchSize) break;
  }

  const orphans = await pool.query(
    `DELETE FROM raw_payloads r
      WHERE r.tenant_id = $1 AND r.received_at < $2
        AND NOT EXISTS (
          SELECT 1 FROM events e WHERE e.tenant_id = r.tenant_id AND e.raw_payload_id = r.id)`,
    [tenantId, cutoff.toISOString()],
  );
  result.rawPayloads += orphans.rowCount ?? 0;
  return result;
}
