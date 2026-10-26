/**
 * Data access for connection health, alerts and the health outbox
 * (migration 0008, AFE-13). The decision logic lives in the server's health
 * service; this module only reads and writes rows. See docs/connection-health.md.
 *
 * Every function takes a tenant id, except the scheduler queries named
 * `...AcrossTenants` (operator/worker maintenance, docs/security/rules.md R5.2).
 */
import type pg from "pg";
import type { Connection, ConnectionStatus, ObservationGap } from "@afe/core";

type Db = Pick<pg.Pool | pg.PoolClient, "query">;

export const CONNECTION_HEALTH_STATES = [
  "healthy",
  "degraded",
  "unreachable",
  "rate_limited",
  "unauthorized",
  "revoked",
  "unknown",
] as const;
export type ConnectionHealthState = (typeof CONNECTION_HEALTH_STATES)[number];

export type BackfillStatus = "pending" | "succeeded" | "failed" | "unsupported";

export interface ConnectionHealth {
  tenantId: string;
  connectionId: string;
  state: ConnectionHealthState;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorReason: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextAttemptAt: Date | null;
  openGapId: string | null;
  openGapStartedAt: Date | null;
  openGapReason: string | null;
  alertedAt: Date | null;
  lastBackfillGapId: string | null;
  lastBackfillStatus: BackfillStatus | null;
  lastBackfillAt: Date | null;
  lastBackfillError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields the health service may change. */
export type ConnectionHealthPatch = Partial<
  Omit<ConnectionHealth, "tenantId" | "connectionId" | "createdAt" | "updatedAt">
>;

const FIELD_COLUMNS: Record<keyof ConnectionHealthPatch, string> = {
  state: "state",
  lastSuccessAt: "last_success_at",
  lastAttemptAt: "last_attempt_at",
  lastFailureAt: "last_failure_at",
  lastErrorReason: "last_error_reason",
  lastError: "last_error",
  consecutiveFailures: "consecutive_failures",
  nextAttemptAt: "next_attempt_at",
  openGapId: "open_gap_id",
  openGapStartedAt: "open_gap_started_at",
  openGapReason: "open_gap_reason",
  alertedAt: "alerted_at",
  lastBackfillGapId: "last_backfill_gap_id",
  lastBackfillStatus: "last_backfill_status",
  lastBackfillAt: "last_backfill_at",
  lastBackfillError: "last_backfill_error",
};

const HEALTH_COLUMNS = `h.tenant_id AS h_tenant_id, h.connection_id AS h_connection_id,
  h.state AS h_state, h.last_success_at AS h_last_success_at,
  h.last_attempt_at AS h_last_attempt_at, h.last_failure_at AS h_last_failure_at,
  h.last_error_reason AS h_last_error_reason, h.last_error AS h_last_error,
  h.consecutive_failures AS h_consecutive_failures, h.next_attempt_at AS h_next_attempt_at,
  h.open_gap_id AS h_open_gap_id, h.open_gap_started_at AS h_open_gap_started_at,
  h.open_gap_reason AS h_open_gap_reason, h.alerted_at AS h_alerted_at,
  h.last_backfill_gap_id AS h_last_backfill_gap_id,
  h.last_backfill_status AS h_last_backfill_status, h.last_backfill_at AS h_last_backfill_at,
  h.last_backfill_error AS h_last_backfill_error, h.created_at AS h_created_at,
  h.updated_at AS h_updated_at`;

const CONNECTION_COLUMNS = `c.tenant_id AS c_tenant_id, c.id AS c_id, c.source AS c_source,
  c.external_id AS c_external_id, c.name AS c_name, c.status AS c_status,
  c.status_reason AS c_status_reason, c.config AS c_config, c.created_at AS c_created_at,
  c.updated_at AS c_updated_at`;

type Row = Record<string, unknown>;

function toHealth(r: Row): ConnectionHealth | null {
  if (r.h_tenant_id == null) return null;
  return {
    tenantId: r.h_tenant_id as string,
    connectionId: r.h_connection_id as string,
    state: r.h_state as ConnectionHealthState,
    lastSuccessAt: r.h_last_success_at as Date | null,
    lastAttemptAt: r.h_last_attempt_at as Date | null,
    lastFailureAt: r.h_last_failure_at as Date | null,
    lastErrorReason: r.h_last_error_reason as string | null,
    lastError: r.h_last_error as string | null,
    consecutiveFailures: r.h_consecutive_failures as number,
    nextAttemptAt: r.h_next_attempt_at as Date | null,
    openGapId: r.h_open_gap_id as string | null,
    openGapStartedAt: r.h_open_gap_started_at as Date | null,
    openGapReason: r.h_open_gap_reason as string | null,
    alertedAt: r.h_alerted_at as Date | null,
    lastBackfillGapId: r.h_last_backfill_gap_id as string | null,
    lastBackfillStatus: r.h_last_backfill_status as BackfillStatus | null,
    lastBackfillAt: r.h_last_backfill_at as Date | null,
    lastBackfillError: r.h_last_backfill_error as string | null,
    createdAt: r.h_created_at as Date,
    updatedAt: r.h_updated_at as Date,
  };
}

function toConnection(r: Row): Connection {
  return {
    tenantId: r.c_tenant_id as string,
    id: r.c_id as string,
    source: r.c_source as string,
    externalId: r.c_external_id as string,
    name: r.c_name as string,
    status: r.c_status as ConnectionStatus,
    statusReason: r.c_status_reason as string | null,
    config: r.c_config as Connection["config"],
    createdAt: r.c_created_at as Date,
    updatedAt: r.c_updated_at as Date,
  };
}

export interface ConnectionWithHealth {
  connection: Connection;
  /** null until the connection was first observed, probed or reported on. */
  health: ConnectionHealth | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates the health row if missing and locks it (FOR UPDATE) for the rest of
 * the caller's transaction. Serialises all state changes of one connection.
 * Returns null if the connection does not exist in this tenant.
 */
export async function lockConnectionHealth(
  client: pg.PoolClient,
  tenantId: string,
  connectionId: string,
): Promise<{ connection: Connection; health: ConnectionHealth } | null> {
  if (!UUID_RE.test(connectionId)) return null;
  await client.query(
    `INSERT INTO connection_health (tenant_id, connection_id)
     SELECT tenant_id, id FROM connections WHERE tenant_id = $1 AND id = $2
     ON CONFLICT (tenant_id, connection_id) DO NOTHING`,
    [tenantId, connectionId],
  );
  const { rows } = await client.query<Row>(
    `SELECT ${HEALTH_COLUMNS}, ${CONNECTION_COLUMNS}
       FROM connection_health h
       JOIN connections c ON c.tenant_id = h.tenant_id AND c.id = h.connection_id
      WHERE h.tenant_id = $1 AND h.connection_id = $2
      FOR UPDATE OF h`,
    [tenantId, connectionId],
  );
  const row = rows[0];
  if (!row) return null;
  return { connection: toConnection(row), health: toHealth(row)! };
}

export async function updateConnectionHealth(
  db: Db,
  tenantId: string,
  connectionId: string,
  patch: ConnectionHealthPatch,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [tenantId, connectionId];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = FIELD_COLUMNS[key as keyof ConnectionHealthPatch];
    if (!column) throw new Error(`unknown connection health field ${key}`);
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  await db.query(
    `UPDATE connection_health SET ${[...sets, "updated_at = now()"].join(", ")}
      WHERE tenant_id = $1 AND connection_id = $2`,
    params,
  );
}

/**
 * Fast path for a successful observation of a connection without an open
 * gap: one statement, no row lock held across other work. Returns false
 * (and changes nothing) when a gap is open or the connection does not exist;
 * the caller then takes the locking slow path.
 *
 * `nextAttemptAt` null leaves the probe schedule unchanged.
 */
export async function recordSuccessWithoutGap(
  db: Db,
  tenantId: string,
  connectionId: string,
  at: Date,
  nextAttemptAt: Date | null,
): Promise<boolean> {
  if (!UUID_RE.test(connectionId)) return false;
  const { rowCount } = await db.query(
    `INSERT INTO connection_health AS h (tenant_id, connection_id, state, last_success_at,
                                         last_attempt_at, next_attempt_at)
     SELECT tenant_id, id, 'healthy', $3, $3, $4 FROM connections
      WHERE tenant_id = $1 AND id = $2
     ON CONFLICT (tenant_id, connection_id) DO UPDATE
       SET state = 'healthy',
           consecutive_failures = 0,
           last_success_at = GREATEST(h.last_success_at, EXCLUDED.last_success_at),
           last_attempt_at = GREATEST(h.last_attempt_at, EXCLUDED.last_attempt_at),
           next_attempt_at = COALESCE($4, h.next_attempt_at),
           updated_at = now()
       WHERE h.open_gap_id IS NULL`,
    [tenantId, connectionId, at, nextAttemptAt],
  );
  return (rowCount ?? 0) > 0;
}

export async function getConnectionHealth(
  db: Db,
  tenantId: string,
  connectionId: string,
): Promise<ConnectionWithHealth | null> {
  if (!UUID_RE.test(connectionId)) return null;
  const { rows } = await db.query<Row>(
    `SELECT ${HEALTH_COLUMNS}, ${CONNECTION_COLUMNS}
       FROM connections c
       LEFT JOIN connection_health h ON h.tenant_id = c.tenant_id AND h.connection_id = c.id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, connectionId],
  );
  return rows[0] ? { connection: toConnection(rows[0]), health: toHealth(rows[0]) } : null;
}

export async function listConnectionsWithHealth(
  db: Db,
  tenantId: string,
): Promise<ConnectionWithHealth[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${HEALTH_COLUMNS}, ${CONNECTION_COLUMNS}
       FROM connections c
       LEFT JOIN connection_health h ON h.tenant_id = c.tenant_id AND h.connection_id = c.id
      WHERE c.tenant_id = $1
      ORDER BY c.created_at, c.id`,
    [tenantId],
  );
  return rows.map((r) => ({ connection: toConnection(r), health: toHealth(r) }));
}

/**
 * Scheduler query (all tenants): active connections whose next probe is due
 * (never probed, or next_attempt_at <= now).
 */
export async function listConnectionsDueForProbeAcrossTenants(
  db: Db,
  now: Date,
  limit = 500,
): Promise<ConnectionWithHealth[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${HEALTH_COLUMNS}, ${CONNECTION_COLUMNS}
       FROM connections c
       LEFT JOIN connection_health h ON h.tenant_id = c.tenant_id AND h.connection_id = c.id
      WHERE c.status = 'active'
        AND (h.next_attempt_at IS NULL OR h.next_attempt_at <= $1)
      ORDER BY h.next_attempt_at NULLS FIRST, c.tenant_id, c.id
      LIMIT $2`,
    [now, limit],
  );
  return rows.map((r) => ({ connection: toConnection(r), health: toHealth(r) }));
}

/**
 * Scheduler query (all tenants): connections with a gap open since before
 * `openedBefore` and no alert raised yet. Disconnected connections are
 * excluded (the user turned them off).
 */
export async function listBlindConnectionsAcrossTenants(
  db: Db,
  openedBefore: Date,
  limit = 500,
): Promise<ConnectionWithHealth[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${HEALTH_COLUMNS}, ${CONNECTION_COLUMNS}
       FROM connection_health h
       JOIN connections c ON c.tenant_id = h.tenant_id AND c.id = h.connection_id
      WHERE h.open_gap_id IS NOT NULL
        AND h.open_gap_started_at <= $1
        AND h.alerted_at IS NULL
        AND c.status <> 'disconnected'
      ORDER BY h.open_gap_started_at
      LIMIT $2`,
    [openedBefore, limit],
  );
  return rows.map((r) => ({ connection: toConnection(r), health: toHealth(r) }));
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface AlertRecord {
  tenantId: string;
  id: string;
  connectionId: string;
  kind: string;
  gapId: string | null;
  blindSince: Date | null;
  message: string;
  openedAt: Date;
  resolvedAt: Date | null;
  openedNotifiedAt: Date | null;
  resolvedNotifiedAt: Date | null;
  notifyAttempts: number;
  lastNotifyError: string | null;
}

const ALERT_COLUMNS = `tenant_id, id, connection_id, kind, gap_id, blind_since, message, opened_at, resolved_at,
  opened_notified_at, resolved_notified_at, notify_attempts, last_notify_error`;

function toAlert(r: Row): AlertRecord {
  return {
    tenantId: r.tenant_id as string,
    id: r.id as string,
    connectionId: r.connection_id as string,
    kind: r.kind as string,
    gapId: r.gap_id as string | null,
    blindSince: r.blind_since as Date | null,
    message: r.message as string,
    openedAt: r.opened_at as Date,
    resolvedAt: r.resolved_at as Date | null,
    openedNotifiedAt: r.opened_notified_at as Date | null,
    resolvedNotifiedAt: r.resolved_notified_at as Date | null,
    notifyAttempts: r.notify_attempts as number,
    lastNotifyError: r.last_notify_error as string | null,
  };
}

/**
 * Opens an alert. Idempotent: returns null if an alert with this id exists,
 * or another alert of the same kind is already open for the connection.
 */
export async function openAlert(
  db: Db,
  tenantId: string,
  alert: {
    id: string;
    connectionId: string;
    kind: string;
    gapId: string | null;
    blindSince: Date | null;
    message: string;
    openedAt: Date;
  },
): Promise<AlertRecord | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO alerts (tenant_id, id, connection_id, kind, gap_id, blind_since, message, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING ${ALERT_COLUMNS}`,
    [
      tenantId,
      alert.id,
      alert.connectionId,
      alert.kind,
      alert.gapId,
      alert.blindSince,
      alert.message,
      alert.openedAt,
    ],
  );
  return rows[0] ? toAlert(rows[0]) : null;
}

/** Resolves every open alert of the connection; returns the resolved alerts. */
export async function resolveOpenAlerts(
  db: Db,
  tenantId: string,
  connectionId: string,
  at: Date,
): Promise<AlertRecord[]> {
  const { rows } = await db.query<Row>(
    `UPDATE alerts SET resolved_at = GREATEST($3, opened_at), notify_attempts = 0
      WHERE tenant_id = $1 AND connection_id = $2 AND resolved_at IS NULL
      RETURNING ${ALERT_COLUMNS}`,
    [tenantId, connectionId, at],
  );
  return rows.map(toAlert);
}

export async function listAlerts(
  db: Db,
  tenantId: string,
  options: { connectionId?: string; openOnly?: boolean; limit?: number } = {},
): Promise<AlertRecord[]> {
  if (options.connectionId !== undefined && !UUID_RE.test(options.connectionId)) return [];
  const { rows } = await db.query<Row>(
    `SELECT ${ALERT_COLUMNS} FROM alerts
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR connection_id = $2)
        AND (NOT $3 OR resolved_at IS NULL)
      ORDER BY opened_at DESC, id
      LIMIT $4`,
    [tenantId, options.connectionId ?? null, options.openOnly ?? false, options.limit ?? 100],
  );
  return rows.map(toAlert);
}

/** Worker query (all tenants): alerts whose open/resolve notification is not delivered yet. */
export async function listAlertsPendingNotificationAcrossTenants(
  db: Db,
  maxAttempts: number,
  limit = 100,
): Promise<AlertRecord[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${ALERT_COLUMNS} FROM alerts
      WHERE notify_attempts < $1
        AND (opened_notified_at IS NULL
             OR (resolved_at IS NOT NULL AND resolved_notified_at IS NULL))
      ORDER BY opened_at
      LIMIT $2`,
    [maxAttempts, limit],
  );
  return rows.map(toAlert);
}

export async function markAlertNotified(
  db: Db,
  tenantId: string,
  id: string,
  status: "opened" | "resolved",
  at: Date,
): Promise<void> {
  const column = status === "opened" ? "opened_notified_at" : "resolved_notified_at";
  await db.query(
    `UPDATE alerts SET ${column} = $3, last_notify_error = NULL
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, at],
  );
}

export async function recordAlertNotifyFailure(
  db: Db,
  tenantId: string,
  id: string,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE alerts SET notify_attempts = notify_attempts + 1, last_notify_error = left($3, 1024)
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error],
  );
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export interface HealthOutboxEntry {
  id: number;
  tenantId: string;
  connectionId: string;
  kind: "event" | "job";
  payload: Record<string, unknown>;
}

export async function addHealthOutboxEntry(
  db: Db,
  tenantId: string,
  connectionId: string,
  kind: "event" | "job",
  payload: object,
): Promise<void> {
  await db.query(
    `INSERT INTO health_outbox (tenant_id, connection_id, kind, payload) VALUES ($1, $2, $3, $4)`,
    [tenantId, connectionId, kind, JSON.stringify(payload)],
  );
}

/** Outbox entries of one connection, oldest first. */
export async function listHealthOutbox(
  db: Db,
  tenantId: string,
  connectionId: string,
): Promise<HealthOutboxEntry[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, tenant_id, connection_id, kind, payload FROM health_outbox
      WHERE tenant_id = $1 AND connection_id = $2 ORDER BY id`,
    [tenantId, connectionId],
  );
  return rows.map(toOutbox);
}

/** Worker query (all tenants): undelivered outbox entries, oldest first. */
export async function listHealthOutboxAcrossTenants(
  db: Db,
  limit = 500,
): Promise<HealthOutboxEntry[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, tenant_id, connection_id, kind, payload FROM health_outbox ORDER BY id LIMIT $1`,
    [limit],
  );
  return rows.map(toOutbox);
}

export async function deleteHealthOutboxEntry(db: Db, tenantId: string, id: number): Promise<void> {
  await db.query("DELETE FROM health_outbox WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
}

function toOutbox(r: Row): HealthOutboxEntry {
  return {
    id: Number(r.id),
    tenantId: r.tenant_id as string,
    connectionId: r.connection_id as string,
    kind: r.kind as "event" | "job",
    payload: r.payload as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Gap history (read from the audit log)
// ---------------------------------------------------------------------------

export interface ObservationGapRecord extends ObservationGap {
  openedEventId: string | null;
  closedEventId: string | null;
}

/**
 * Observation gaps of a connection, reconstructed from its
 * observation_gap.opened/closed events, most recent first.
 */
export async function listObservationGaps(
  db: Db,
  tenantId: string,
  connectionId: string,
  limit = 100,
): Promise<ObservationGapRecord[]> {
  const { rows } = await db.query<{ id: string; action: string; gap: ObservationGap }>(
    `SELECT e.id, e.action, e.data -> 'gap' AS gap
       FROM events e
      WHERE e.tenant_id = $1 AND e.connection_id = $2
        AND e.action IN ('observation_gap.opened', 'observation_gap.closed')
      ORDER BY e.seq`,
    [tenantId, connectionId],
  );
  const gaps = new Map<string, ObservationGapRecord>();
  for (const r of rows) {
    const existing = gaps.get(r.gap.gapId);
    const rec: ObservationGapRecord = existing ?? {
      ...r.gap,
      endedAt: r.gap.endedAt ?? null,
      detail: r.gap.detail ?? null,
      openedEventId: null,
      closedEventId: null,
    };
    if (r.action === "observation_gap.opened") rec.openedEventId = r.id;
    else {
      rec.closedEventId = r.id;
      rec.endedAt = r.gap.endedAt ?? null;
    }
    gaps.set(r.gap.gapId, rec);
  }
  return [...gaps.values()]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, limit);
}
