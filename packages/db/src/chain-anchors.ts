/**
 * Chain anchor receipts and job state (migration 0016, ADR 0007). The stored
 * receipts are a convenience copy; verification re-checks their signatures
 * and prefers external anchor sources.
 */
import { randomUUID } from "node:crypto";
import type { AnchorReceipt } from "@afe/core";
import type { Queryable } from "./event-store.ts";

export interface StoredAnchorReceipt {
  id: string;
  publishedAt: string;
  receipt: AnchorReceipt;
}

interface ReceiptRow {
  id: string;
  published_at: Date;
  receipt: AnchorReceipt;
}

const toStored = (r: ReceiptRow): StoredAnchorReceipt => ({
  id: r.id,
  publishedAt: r.published_at.toISOString(),
  receipt: r.receipt,
});

export async function insertAnchorReceipt(
  db: Queryable,
  tenantId: string,
  receipt: AnchorReceipt,
): Promise<StoredAnchorReceipt> {
  if (receipt.checkpoint.tenantId !== tenantId) throw new Error("receipt for another tenant");
  const { rows } = await db.query<ReceiptRow>(
    `INSERT INTO chain_anchor_receipts
       (id, tenant_id, anchor_kind, seq, hash, checkpoint_created_at, receipt)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, published_at, receipt`,
    [
      randomUUID(),
      tenantId,
      receipt.anchor.kind,
      receipt.checkpoint.seq,
      receipt.checkpoint.hash,
      receipt.checkpoint.createdAt,
      JSON.stringify(receipt),
    ],
  );
  return toStored(rows[0]!);
}

export interface ListAnchorReceiptsOptions {
  /** Only receipts with seq <= this. */
  maxSeq?: number;
  /** Newest first; default 1000, max 10000. */
  limit?: number;
}

/** A tenant's stored receipts, newest checkpoint first. */
export async function listAnchorReceipts(
  db: Queryable,
  tenantId: string,
  options: ListAnchorReceiptsOptions = {},
): Promise<StoredAnchorReceipt[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 1000), 1), 10_000);
  const { rows } = await db.query<ReceiptRow>(
    `SELECT id, published_at, receipt FROM chain_anchor_receipts
      WHERE tenant_id = $1 AND ($2::bigint IS NULL OR seq <= $2)
      ORDER BY seq DESC, checkpoint_created_at DESC, published_at DESC
      LIMIT $3`,
    [tenantId, options.maxSeq ?? null, limit],
  );
  return rows.map(toStored);
}

/** Receipts of the newest stored checkpoint (one per anchor), optionally at or before `maxSeq`. */
export async function getLatestAnchorReceipts(
  db: Queryable,
  tenantId: string,
  maxSeq?: number,
): Promise<AnchorReceipt[]> {
  const { rows } = await db.query<ReceiptRow>(
    `SELECT id, published_at, receipt FROM chain_anchor_receipts
      WHERE tenant_id = $1
        AND (seq, checkpoint_created_at) = (
          SELECT seq, checkpoint_created_at FROM chain_anchor_receipts
           WHERE tenant_id = $1 AND ($2::bigint IS NULL OR seq <= $2)
           ORDER BY seq DESC, checkpoint_created_at DESC LIMIT 1)
      ORDER BY published_at`,
    [tenantId, maxSeq ?? null],
  );
  return rows.map((r) => r.receipt);
}

/** Hashes of a tenant's events at the given seqs (missing seqs are absent from the map). */
export async function getEventHashesBySeq(
  db: Queryable,
  tenantId: string,
  seqs: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (seqs.length === 0) return out;
  const { rows } = await db.query<{ seq: string; hash: string }>(
    "SELECT seq, hash FROM events WHERE tenant_id = $1 AND seq = ANY($2::bigint[])",
    [tenantId, [...seqs]],
  );
  for (const r of rows) out.set(Number(r.seq), r.hash);
  return out;
}

/** Every tenant's chain head (for the anchor job). */
export async function listChainHeadsAcrossTenants(
  db: Queryable,
): Promise<{ tenantId: string; seq: number; hash: string }[]> {
  const { rows } = await db.query<{ tenant_id: string; seq: string; hash: string }>(
    "SELECT tenant_id, seq, hash FROM event_chain_heads WHERE seq > 0 ORDER BY tenant_id",
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, seq: Number(r.seq), hash: r.hash }));
}

export interface ChainAnchorState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** Records an anchor run: `error` null for success. */
export async function recordAnchorAttempt(
  db: Queryable,
  tenantId: string,
  error: string | null,
  at: Date = new Date(),
): Promise<void> {
  await db.query(
    `INSERT INTO chain_anchor_state (tenant_id, last_attempt_at, last_success_at, last_error, last_error_at)
     VALUES ($1, $2::timestamptz, CASE WHEN $3::text IS NULL THEN $2::timestamptz END, $3, CASE WHEN $3::text IS NOT NULL THEN $2::timestamptz END)
     ON CONFLICT (tenant_id) DO UPDATE SET
       last_attempt_at = $2::timestamptz,
       last_success_at = CASE WHEN $3::text IS NULL THEN $2::timestamptz ELSE chain_anchor_state.last_success_at END,
       last_error = $3,
       last_error_at = CASE WHEN $3::text IS NOT NULL THEN $2::timestamptz ELSE chain_anchor_state.last_error_at END,
       updated_at = now()`,
    [tenantId, at.toISOString(), error === null ? null : error.slice(0, 1024)],
  );
}

export async function getAnchorState(
  db: Queryable,
  tenantId: string,
): Promise<ChainAnchorState | null> {
  const { rows } = await db.query<{
    last_attempt_at: Date | null;
    last_success_at: Date | null;
    last_error: string | null;
    last_error_at: Date | null;
  }>(
    "SELECT last_attempt_at, last_success_at, last_error, last_error_at FROM chain_anchor_state WHERE tenant_id = $1",
    [tenantId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    lastAttemptAt: r.last_attempt_at?.toISOString() ?? null,
    lastSuccessAt: r.last_success_at?.toISOString() ?? null,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at?.toISOString() ?? null,
  };
}
