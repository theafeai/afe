import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Connection, ConnectionStatus, JsonObject } from "@afe/core";

type Db = pg.Pool | pg.PoolClient;

interface ConnectionRow {
  tenant_id: string;
  id: string;
  source: string;
  external_id: string;
  name: string;
  status: ConnectionStatus;
  status_reason: string | null;
  config: JsonObject;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "tenant_id, id, source, external_id, name, status, status_reason, config, created_at, updated_at";

function toConnection(r: ConnectionRow): Connection {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    name: r.name,
    status: r.status,
    statusReason: r.status_reason,
    config: r.config,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface UpsertConnectionInput {
  source: string;
  externalId: string;
  name: string;
  status?: ConnectionStatus;
  config?: JsonObject;
  /** Non-secret settings owned by another feature which reconnecting must preserve atomically. */
  preserveConfigKeys?: string[];
}

/**
 * Creates the connection, or updates name/config/status of the existing one
 * with the same (tenant, source, externalId). Reconnecting a disconnected
 * connection keeps its id, so its event history stays linked.
 */
export async function upsertConnection(
  db: Db,
  tenantId: string,
  input: UpsertConnectionInput,
): Promise<Connection> {
  const { rows } = await db.query<ConnectionRow>(
    `INSERT INTO connections (tenant_id, id, source, external_id, name, status, config)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, source, external_id) DO UPDATE
       SET name = EXCLUDED.name,
           config = EXCLUDED.config || (SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(connections.config) WHERE key=ANY($8::text[])),
           status = EXCLUDED.status,
           status_reason = NULL, updated_at = now()
     RETURNING ${COLUMNS}`,
    [
      tenantId,
      randomUUID(),
      input.source,
      input.externalId,
      input.name,
      input.status ?? "pending",
      input.config ?? {},
      input.preserveConfigKeys ?? [],
    ],
  );
  return toConnection(rows[0]!);
}

export async function getConnection(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Connection | null> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function findConnectionByExternalId(
  db: Db,
  tenantId: string,
  source: string,
  externalId: string,
): Promise<Connection | null> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections
     WHERE tenant_id = $1 AND source = $2 AND external_id = $3`,
    [tenantId, source, externalId],
  );
  return rows[0] ? toConnection(rows[0]) : null;
}

/**
 * Looks a connection up across all tenants by its source identity. Only for
 * inbound webhooks, which identify the connection before the tenant is known
 * (e.g. GitHub sends the installation id). The caller must then act only
 * within the returned connection's tenant.
 */
export async function resolveConnectionBySourceIdentity(
  db: Db,
  source: string,
  externalId: string,
): Promise<Connection[]> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections WHERE source = $1 AND external_id = $2`,
    [source, externalId],
  );
  return rows.map(toConnection);
}

export interface ListConnectionsOptions {
  source?: string;
  statuses?: ConnectionStatus[];
}

export async function listConnections(
  db: Db,
  tenantId: string,
  options: ListConnectionsOptions = {},
): Promise<Connection[]> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections
     WHERE tenant_id = $1
       AND ($2::text IS NULL OR source = $2)
       AND ($3::text[] IS NULL OR status = ANY($3))
     ORDER BY created_at, id`,
    [tenantId, options.source ?? null, options.statuses ?? null],
  );
  return rows.map(toConnection);
}

/** Every active connection across tenants, for schedulers (polling, health). */
export async function listActiveConnections(db: Db, source?: string): Promise<Connection[]> {
  const { rows } = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections
     WHERE status = 'active' AND ($1::text IS NULL OR source = $1)
     ORDER BY tenant_id, created_at, id`,
    [source ?? null],
  );
  return rows.map(toConnection);
}

export async function setConnectionStatus(
  db: Db,
  tenantId: string,
  id: string,
  status: ConnectionStatus,
  reason: string | null = null,
): Promise<Connection | null> {
  const { rows } = await db.query<ConnectionRow>(
    `UPDATE connections SET status = $3, status_reason = $4, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [tenantId, id, status, reason],
  );
  return rows[0] ? toConnection(rows[0]) : null;
}

/** Shallow-merges `patch` into the connection's non-secret config. */
export async function updateConnectionConfig(
  db: Db,
  tenantId: string,
  id: string,
  patch: JsonObject,
): Promise<Connection | null> {
  const { rows } = await db.query<ConnectionRow>(
    `UPDATE connections SET config = config || $3::jsonb, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    [tenantId, id, patch],
  );
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function attachConnectionCredential(
  db: Db,
  tenantId: string,
  connectionId: string,
  role: string,
  credentialId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO connection_credentials (tenant_id, connection_id, role, credential_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, connection_id, role) DO UPDATE SET credential_id = EXCLUDED.credential_id`,
    [tenantId, connectionId, role, credentialId],
  );
}

/** Credential ids attached to a connection, by role. */
export async function getConnectionCredentialIds(
  db: Db,
  tenantId: string,
  connectionId: string,
): Promise<Record<string, string>> {
  const { rows } = await db.query<{ role: string; credential_id: string }>(
    `SELECT role, credential_id FROM connection_credentials
     WHERE tenant_id = $1 AND connection_id = $2`,
    [tenantId, connectionId],
  );
  return Object.fromEntries(rows.map((r) => [r.role, r.credential_id]));
}
