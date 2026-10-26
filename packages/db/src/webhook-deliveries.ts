import type pg from "pg";
import type { DeliveryRecord, ReplayGuard } from "@afe/core/security";

type Db = pg.Pool | pg.PoolClient;

/**
 * Records an accepted webhook delivery. Returns true the first time a
 * (source, deliveryId) is seen and false on a replay. Atomic under concurrency
 * (primary-key conflict). Call only after the signature has been verified, and
 * ideally in the same transaction that stores the raw delivery, so a delivery
 * whose processing failed before commit can be redelivered.
 */
export async function recordDelivery(
  db: Db,
  tenantId: string | null,
  source: string,
  deliveryId: string,
  receivedAt: Date = new Date(),
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO webhook_deliveries (source, delivery_id, tenant_id, received_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source, delivery_id) DO NOTHING`,
    [source, deliveryId, tenantId, receivedAt],
  );
  return rowCount === 1;
}

/** A `ReplayGuard` backed by the `webhook_deliveries` table. */
export function createDbReplayGuard(db: Db): ReplayGuard {
  return {
    recordDelivery: (r: DeliveryRecord) =>
      recordDelivery(db, r.tenantId, r.source, r.deliveryId, r.receivedAt),
  };
}

/**
 * Deletes delivery records received before `cutoff`. Keep records for longer
 * than any provider's redelivery window (see docs/security/rules.md); payload
 * idempotency in the event store remains the final guard after pruning.
 */
export async function pruneWebhookDeliveries(db: Db, cutoff: Date): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM webhook_deliveries WHERE received_at < $1", [
    cutoff,
  ]);
  return rowCount ?? 0;
}
