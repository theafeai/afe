/**
 * PostgreSQL implementation of the ArgoCD capture state store (AFE-10,
 * migration 0010). Every statement is scoped by tenant and connection
 * (docs/security/rules.md R5). `withApp` holds a transaction-level advisory
 * lock per application so the watch and reconciliation (possibly in different
 * worker processes) never process the same application concurrently.
 */
import type pg from "pg";
import type {
  AppCaptureState,
  AppUpdate,
  CaptureStateStore,
  ConnectionCaptureState,
} from "@afe/connector-argocd";

interface CursorRow {
  baseline_at: Date;
  resource_version: string | null;
  last_stream_event_at: Date | null;
  last_reconciled_at: Date | null;
}

function toConnectionState(r: CursorRow): ConnectionCaptureState {
  return {
    baselineAt: r.baseline_at.toISOString(),
    ...(r.resource_version ? { resourceVersion: r.resource_version } : {}),
    ...(r.last_stream_event_at ? { lastStreamEventAt: r.last_stream_event_at.toISOString() } : {}),
    ...(r.last_reconciled_at ? { lastReconciledAt: r.last_reconciled_at.toISOString() } : {}),
  };
}

export function createPgCaptureStateStore(
  pool: pg.Pool,
  tenantId: string,
  connectionId: string,
): CaptureStateStore {
  return {
    async getConnectionState() {
      const { rows } = await pool.query<CursorRow>(
        `SELECT baseline_at, resource_version, last_stream_event_at, last_reconciled_at
         FROM argocd_capture_cursors WHERE tenant_id = $1 AND connection_id = $2`,
        [tenantId, connectionId],
      );
      return rows[0] ? toConnectionState(rows[0]) : null;
    },

    async initConnectionState(baselineAt) {
      await pool.query(
        `INSERT INTO argocd_capture_cursors (tenant_id, connection_id, baseline_at)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, connection_id) DO NOTHING`,
        [tenantId, connectionId, baselineAt],
      );
      const state = await this.getConnectionState();
      if (!state) throw new Error("argocd capture cursor could not be created");
      return state;
    },

    async updateConnectionState(patch) {
      await pool.query(
        `UPDATE argocd_capture_cursors SET
           resource_version = COALESCE($3, resource_version),
           last_stream_event_at = COALESCE($4, last_stream_event_at),
           last_reconciled_at = COALESCE($5, last_reconciled_at),
           updated_at = now()
         WHERE tenant_id = $1 AND connection_id = $2`,
        [
          tenantId,
          connectionId,
          patch.resourceVersion ?? null,
          patch.lastStreamEventAt ?? null,
          patch.lastReconciledAt ?? null,
        ],
      );
    },

    async withApp<T>(
      uid: string,
      fn: (prev: AppCaptureState | null) => Promise<AppUpdate<T>>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `argocd-app:${tenantId}:${connectionId}:${uid}`,
        ]);
        const { rows } = await client.query<{ state: AppCaptureState }>(
          `SELECT state FROM argocd_application_states
           WHERE tenant_id = $1 AND connection_id = $2 AND app_uid = $3`,
          [tenantId, connectionId, uid],
        );
        const { next, result, persist } = await fn(rows[0]?.state ?? null);
        if (persist !== false || !rows[0]) {
          await client.query(
            `INSERT INTO argocd_application_states
               (tenant_id, connection_id, app_uid, name, app_namespace, state, deleted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (tenant_id, connection_id, app_uid) DO UPDATE SET
               name = EXCLUDED.name, app_namespace = EXCLUDED.app_namespace,
               state = EXCLUDED.state, deleted_at = EXCLUDED.deleted_at, updated_at = now()`,
            [
              tenantId,
              connectionId,
              uid,
              next.name,
              next.appNamespace ?? null,
              next,
              next.deletedAt ?? null,
            ],
          );
        }
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },

    async listLiveApps() {
      const { rows } = await pool.query<{ state: AppCaptureState }>(
        `SELECT state FROM argocd_application_states
         WHERE tenant_id = $1 AND connection_id = $2 AND deleted_at IS NULL
         ORDER BY app_uid`,
        [tenantId, connectionId],
      );
      return rows.map((r) => r.state);
    },
  };
}
