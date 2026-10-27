/**
 * PostgreSQL bookkeeping for in-cluster ArgoCD agents (AFE-28, migration
 * 0018): one `argocd_agents` row per agent connection, and the staging table
 * of accepted batches. Every statement is scoped by tenant and connection
 * (docs/security/rules.md R5), except `findAgentForAuth`, which resolves an
 * agent id before the tenant is known (like webhook installation lookups).
 *
 * Also holds the small helpers the pull-mode ArgoCD module uses to leave
 * agent connections alone (`isAgentConnection`) and to delegate their health
 * probe and backfill, so the two modules do not import each other.
 */
import type pg from "pg";
import type { Connection, JsonObject, ProbeResult } from "@afe/core";
import { CONNECTOR_SOURCE } from "@afe/connector-argocd";

type Db = pg.Pool | pg.PoolClient;

/** `connections.config.mode` of an agent connection. */
export const AGENT_MODE = "agent" as const;

export function isAgentConnection(c: Pick<Connection, "source" | "config">): boolean {
  return c.source === CONNECTOR_SOURCE && c.config?.mode === AGENT_MODE;
}

export interface AgentRow {
  tenantId: string;
  connectionId: string;
  lastHeartbeatAt: Date | null;
  lastHeartbeat: JsonObject | null;
  lastBatchAt: Date | null;
  runId: string | null;
  lastSequence: number;
  droppedTotal: number;
  awaitingSnapshot: boolean;
  awaitingSince: Date | null;
  awaitingReason: string | null;
  awaitingRunId: string | null;
  awaitingDroppedTotal: number;
  resyncRequested: boolean;
  resyncSentAt: Date | null;
  lastSnapshotCompletedAt: Date | null;
  silenceReportedAt: Date | null;
  previousSecretExpiresAt: Date | null;
}

interface Row {
  tenant_id: string;
  connection_id: string;
  last_heartbeat_at: Date | null;
  last_heartbeat: JsonObject | null;
  last_batch_at: Date | null;
  run_id: string | null;
  last_sequence: string;
  dropped_total: string;
  awaiting_snapshot: boolean;
  awaiting_since: Date | null;
  awaiting_reason: string | null;
  awaiting_run_id: string | null;
  awaiting_dropped_total: string;
  resync_requested: boolean;
  resync_sent_at: Date | null;
  last_snapshot_completed_at: Date | null;
  silence_reported_at: Date | null;
  previous_secret_expires_at: Date | null;
}

const toRow = (r: Row): AgentRow => ({
  tenantId: r.tenant_id,
  connectionId: r.connection_id,
  lastHeartbeatAt: r.last_heartbeat_at,
  lastHeartbeat: r.last_heartbeat,
  lastBatchAt: r.last_batch_at,
  runId: r.run_id,
  lastSequence: Number(r.last_sequence),
  droppedTotal: Number(r.dropped_total),
  awaitingSnapshot: r.awaiting_snapshot,
  awaitingSince: r.awaiting_since,
  awaitingReason: r.awaiting_reason,
  awaitingRunId: r.awaiting_run_id,
  awaitingDroppedTotal: Number(r.awaiting_dropped_total),
  resyncRequested: r.resync_requested,
  resyncSentAt: r.resync_sent_at,
  lastSnapshotCompletedAt: r.last_snapshot_completed_at,
  silenceReportedAt: r.silence_reported_at,
  previousSecretExpiresAt: r.previous_secret_expires_at,
});

const COLS = `a.tenant_id, a.connection_id, a.last_heartbeat_at, a.last_heartbeat, a.last_batch_at,
  a.run_id, a.last_sequence, a.dropped_total, a.awaiting_snapshot, a.awaiting_since,
  a.awaiting_reason, a.awaiting_run_id, a.awaiting_dropped_total, a.resync_requested,
  a.resync_sent_at, a.last_snapshot_completed_at, a.silence_reported_at,
  a.previous_secret_expires_at`;

/** Creates the agent row, or resets it when an agent connection is registered again. */
export async function resetAgentRow(db: Db, tenantId: string, connectionId: string): Promise<void> {
  await db.query(
    `INSERT INTO argocd_agents (tenant_id, connection_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, connection_id) DO UPDATE SET
       last_heartbeat_at = NULL, last_heartbeat = NULL, last_batch_at = NULL, run_id = NULL,
       last_sequence = 0, dropped_total = 0, awaiting_snapshot = false, awaiting_since = NULL,
       awaiting_reason = NULL, awaiting_run_id = NULL, awaiting_dropped_total = 0,
       resync_requested = false, resync_sent_at = NULL, silence_reported_at = NULL,
       previous_secret_expires_at = NULL, updated_at = now()`,
    [tenantId, connectionId],
  );
}

export async function getAgentRow(
  db: Db,
  tenantId: string,
  connectionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AgentRow | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLS} FROM argocd_agents a WHERE a.tenant_id = $1 AND a.connection_id = $2
     ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [tenantId, connectionId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listAgentRows(db: Db, tenantId: string): Promise<AgentRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLS} FROM argocd_agents a WHERE a.tenant_id = $1 ORDER BY a.created_at`,
    [tenantId],
  );
  return rows.map(toRow);
}

/**
 * Resolves an agent id (its connection id) across tenants, for request
 * authentication only. Returns the tenant; the caller must then act only
 * within it. Only active agent connections are returned.
 */
export async function findAgentForAuth(
  db: Db,
  connectionId: string,
): Promise<{ tenantId: string; previousSecretExpiresAt: Date | null } | null> {
  const { rows } = await db.query<{ tenant_id: string; previous_secret_expires_at: Date | null }>(
    `SELECT a.tenant_id, a.previous_secret_expires_at
       FROM argocd_agents a
       JOIN connections c ON c.tenant_id = a.tenant_id AND c.id = a.connection_id
      WHERE a.connection_id = $1 AND c.status = 'active' AND c.source = $2
        AND c.config->>'mode' = $3`,
    [connectionId, CONNECTOR_SOURCE, AGENT_MODE],
  );
  return rows[0]
    ? { tenantId: rows[0].tenant_id, previousSecretExpiresAt: rows[0].previous_secret_expires_at }
    : null;
}

/** Agents of active connections whose last heartbeat is older than `before` and not yet reported. */
export async function listSilentAgentsAcrossTenants(db: Db, before: Date): Promise<AgentRow[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLS} FROM argocd_agents a
       JOIN connections c ON c.tenant_id = a.tenant_id AND c.id = a.connection_id
      WHERE c.status = 'active' AND a.last_heartbeat_at IS NOT NULL
        AND a.last_heartbeat_at < $1
        AND (a.silence_reported_at IS NULL OR a.silence_reported_at < a.last_heartbeat_at)
      ORDER BY a.tenant_id, a.connection_id`,
    [before],
  );
  return rows.map(toRow);
}

/** Connections with staged batches (for the sweeper). */
export async function listConnectionsWithPendingBatches(
  db: Db,
): Promise<{ tenantId: string; connectionId: string }[]> {
  const { rows } = await db.query<{ tenant_id: string; connection_id: string }>(
    `SELECT DISTINCT tenant_id, connection_id FROM argocd_agent_batches ORDER BY 1, 2`,
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, connectionId: r.connection_id }));
}

export interface AgentRowPatch {
  lastHeartbeatAt?: Date;
  lastHeartbeat?: JsonObject;
  lastBatchAt?: Date;
  runId?: string;
  lastSequence?: number;
  droppedTotal?: number;
  awaitingSnapshot?: boolean;
  awaitingSince?: Date | null;
  awaitingReason?: string | null;
  awaitingRunId?: string | null;
  awaitingDroppedTotal?: number;
  resyncRequested?: boolean;
  resyncSentAt?: Date | null;
  lastSnapshotCompletedAt?: Date;
  silenceReportedAt?: Date | null;
  previousSecretExpiresAt?: Date | null;
}

const PATCH_COLUMNS: Record<keyof AgentRowPatch, string> = {
  lastHeartbeatAt: "last_heartbeat_at",
  lastHeartbeat: "last_heartbeat",
  lastBatchAt: "last_batch_at",
  runId: "run_id",
  lastSequence: "last_sequence",
  droppedTotal: "dropped_total",
  awaitingSnapshot: "awaiting_snapshot",
  awaitingSince: "awaiting_since",
  awaitingReason: "awaiting_reason",
  awaitingRunId: "awaiting_run_id",
  awaitingDroppedTotal: "awaiting_dropped_total",
  resyncRequested: "resync_requested",
  resyncSentAt: "resync_sent_at",
  lastSnapshotCompletedAt: "last_snapshot_completed_at",
  silenceReportedAt: "silence_reported_at",
  previousSecretExpiresAt: "previous_secret_expires_at",
};

export async function updateAgentRow(
  db: Db,
  tenantId: string,
  connectionId: string,
  patch: AgentRowPatch,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [tenantId, connectionId];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${PATCH_COLUMNS[k as keyof AgentRowPatch]} = $${values.length}`);
  }
  if (!sets.length) return;
  await db.query(
    `UPDATE argocd_agents SET ${sets.join(", ")}, updated_at = now()
     WHERE tenant_id = $1 AND connection_id = $2`,
    values,
  );
}

// --- staged batches ---------------------------------------------------------

export async function stageBatch(
  db: Db,
  tenantId: string,
  connectionId: string,
  batchId: string,
  body: JsonObject,
  receivedAt: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO argocd_agent_batches (tenant_id, connection_id, batch_id, body, received_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, connection_id, batch_id) DO NOTHING`,
    [tenantId, connectionId, batchId, body, receivedAt],
  );
}

export async function countPendingBatches(
  db: Db,
  tenantId: string,
  connectionId: string,
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM argocd_agent_batches WHERE tenant_id = $1 AND connection_id = $2`,
    [tenantId, connectionId],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface StagedBatch {
  id: string;
  batchId: string;
  receivedAt: Date;
  body: unknown;
  attempts: number;
}

export async function nextPendingBatches(
  db: Db,
  tenantId: string,
  connectionId: string,
  limit: number,
): Promise<StagedBatch[]> {
  const { rows } = await db.query<{
    id: string;
    batch_id: string;
    received_at: Date;
    body: unknown;
    attempts: number;
  }>(
    `SELECT id, batch_id, received_at, body, attempts FROM argocd_agent_batches
     WHERE tenant_id = $1 AND connection_id = $2 ORDER BY id LIMIT $3`,
    [tenantId, connectionId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    batchId: r.batch_id,
    receivedAt: r.received_at,
    body: r.body,
    attempts: r.attempts,
  }));
}

export async function deleteStagedBatch(db: Db, tenantId: string, id: string): Promise<void> {
  await db.query(`DELETE FROM argocd_agent_batches WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
  ]);
}

export async function markBatchAttempt(db: Db, tenantId: string, id: string): Promise<void> {
  await db.query(
    `UPDATE argocd_agent_batches SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
}

// --- health delegation (used by the pull-mode ArgoCD module) ----------------

export interface AgentHealthOptions {
  /** Heartbeats older than this count as missing (default 90 s). */
  heartbeatStaleMs?: number;
  now?: () => Date;
}

/**
 * Health probe of an agent connection: there is nothing to call (the agent
 * is behind a firewall), so the probe reads what the agent last reported.
 * It fails while heartbeats are missing and while a gap waits for a full
 * snapshot, so a probe success never closes a gap the agent has not covered.
 */
export async function probeAgentConnection(
  db: Db,
  connection: Connection,
  options: AgentHealthOptions = {},
): Promise<ProbeResult> {
  const row = await getAgentRow(db, connection.tenantId, connection.id);
  if (!row?.lastHeartbeatAt) {
    return { ok: false, reason: "unreachable", detail: "the agent has not connected yet" };
  }
  const now = (options.now ?? (() => new Date()))().getTime();
  if (now - row.lastHeartbeatAt.getTime() > (options.heartbeatStaleMs ?? 90_000)) {
    return {
      ok: false,
      reason: "unreachable",
      detail: `no heartbeat from the agent since ${row.lastHeartbeatAt.toISOString()}`,
    };
  }
  if (row.awaitingSnapshot) {
    return {
      ok: false,
      reason: "error",
      detail: `waiting for a full snapshot from the agent (${row.awaitingReason ?? "data may be missing"})`,
    };
  }
  return { ok: true };
}

/** Backfill of an agent connection: ask the agent for a full snapshot in its next heartbeat. */
export async function requestAgentResync(db: Db, connection: Connection): Promise<void> {
  await updateAgentRow(db, connection.tenantId, connection.id, { resyncRequested: true });
}
