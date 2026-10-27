/**
 * PostgreSQL storage for Vercel capture state (AFE-12, migration 0011):
 * the per-connection poll cursor and the last production deployment per
 * project, with its recent changes (AFE-30, migration 0015). Every function is scoped by tenant and connection (R5.2).
 */
import type pg from "pg";
import {
  type OpenDeployment,
  type ProductionChangeRecord,
  type ProductionState,
  type VercelCaptureStore,
  type VercelPollState,
  parseProjectSelection,
} from "@afe/connector-vercel";

type Db = pg.Pool | pg.PoolClient;

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);
const ts = (n: number | null): Date | null => (n === null ? null : new Date(n));

export async function loadVercelPollState(
  db: Db,
  tenantId: string,
  connectionId: string,
): Promise<VercelPollState | null> {
  const { rows } = await db.query<{
    cursor: Date | null;
    open_deployments: OpenDeployment[];
    backfilled: unknown;
  }>(
    `SELECT cursor, open_deployments, backfilled FROM vercel_poll_state
     WHERE tenant_id = $1 AND connection_id = $2`,
    [tenantId, connectionId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    cursor: ms(r.cursor),
    openDeployments: Array.isArray(r.open_deployments) ? r.open_deployments : [],
    backfilled: parseProjectSelection(r.backfilled),
  };
}

export async function saveVercelPollState(
  db: Db,
  tenantId: string,
  connectionId: string,
  state: VercelPollState,
  polledAt: number,
): Promise<void> {
  await db.query(
    `INSERT INTO vercel_poll_state
       (tenant_id, connection_id, cursor, open_deployments, backfilled, last_polled_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tenant_id, connection_id) DO UPDATE SET
       cursor = EXCLUDED.cursor,
       open_deployments = EXCLUDED.open_deployments,
       backfilled = EXCLUDED.backfilled,
       last_polled_at = EXCLUDED.last_polled_at,
       updated_at = now()`,
    [
      tenantId,
      connectionId,
      ts(state.cursor),
      JSON.stringify(state.openDeployments),
      JSON.stringify(state.backfilled),
      new Date(polledAt),
    ],
  );
}

interface ProductionRow {
  deployment_id: string;
  deployment_created_at: Date | null;
  previous_deployment_id: string | null;
  previous_deployment_created_at: Date | null;
  last_seen_at: Date;
  changed_at: Date;
  changes: unknown;
}

function parseChanges(v: unknown): ProductionChangeRecord[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is ProductionChangeRecord =>
      !!c &&
      typeof c === "object" &&
      typeof (c as ProductionChangeRecord).key === "string" &&
      typeof (c as ProductionChangeRecord).to === "string" &&
      typeof (c as ProductionChangeRecord).at === "number",
  );
}

export async function getVercelProductionState(
  db: Db,
  tenantId: string,
  connectionId: string,
  projectId: string,
): Promise<ProductionState | null> {
  const { rows } = await db.query<ProductionRow>(
    `SELECT deployment_id, deployment_created_at, previous_deployment_id,
            previous_deployment_created_at, last_seen_at, changed_at, changes
     FROM vercel_production_state
     WHERE tenant_id = $1 AND connection_id = $2 AND project_id = $3`,
    [tenantId, connectionId, projectId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    deploymentId: r.deployment_id,
    deploymentCreatedAt: ms(r.deployment_created_at),
    previousDeploymentId: r.previous_deployment_id,
    previousDeploymentCreatedAt: ms(r.previous_deployment_created_at),
    lastSeenAt: r.last_seen_at.getTime(),
    changedAt: r.changed_at.getTime(),
    changes: parseChanges(r.changes),
  };
}

export async function putVercelProductionState(
  db: Db,
  tenantId: string,
  connectionId: string,
  projectId: string,
  s: ProductionState,
): Promise<void> {
  await db.query(
    `INSERT INTO vercel_production_state
       (tenant_id, connection_id, project_id, deployment_id, deployment_created_at,
        previous_deployment_id, previous_deployment_created_at, last_seen_at, changed_at, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, connection_id, project_id) DO UPDATE SET
       deployment_id = EXCLUDED.deployment_id,
       deployment_created_at = EXCLUDED.deployment_created_at,
       previous_deployment_id = EXCLUDED.previous_deployment_id,
       previous_deployment_created_at = EXCLUDED.previous_deployment_created_at,
       last_seen_at = EXCLUDED.last_seen_at,
       changed_at = EXCLUDED.changed_at,
       changes = EXCLUDED.changes`,
    [
      tenantId,
      connectionId,
      projectId,
      s.deploymentId,
      ts(s.deploymentCreatedAt),
      s.previousDeploymentId,
      ts(s.previousDeploymentCreatedAt),
      new Date(s.lastSeenAt),
      new Date(s.changedAt),
      JSON.stringify(s.changes),
    ],
  );
}

/** A `VercelCaptureStore` for one connection. */
export function pgVercelCaptureStore(
  pool: pg.Pool,
  tenantId: string,
  connectionId: string,
): VercelCaptureStore {
  return {
    loadPollState: () => loadVercelPollState(pool, tenantId, connectionId),
    savePollState: (state, polledAt) =>
      saveVercelPollState(pool, tenantId, connectionId, state, polledAt),
    async withProductionState(projectId, fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialises webhook and poll processing of the same project; the row
        // may not exist yet, so lock a key rather than the row.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `vercel.production:${tenantId}:${connectionId}:${projectId}`,
        ]);
        const current = await getVercelProductionState(client, tenantId, connectionId, projectId);
        const { next, result } = await fn(current);
        if (next) await putVercelProductionState(client, tenantId, connectionId, projectId, next);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Runs `fn` only if no other poll of this connection is running (session
 * advisory lock). Returns null when skipped.
 */
export async function withVercelPollLock<T>(
  pool: pg.Pool,
  tenantId: string,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();
  const key = `vercel.poll:${tenantId}:${connectionId}`;
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
      [key],
    );
    if (!rows[0]?.ok) return null;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
