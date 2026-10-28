import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { TOOL_PERMISSION_MODES, type ToolPolicy } from "@afe/core";

export interface LocalUser {
  id: string;
  username: string;
  disabled: boolean;
  email: string | null;
  credentialVersion: number;
}
const columns = 'id, username, email, disabled, credential_version AS "credentialVersion"';
function digest(secret: string): string {
  return createHash("sha256").update("afe-local-user-v1\0").update(secret).digest("hex");
}
export function issueLocalCredential(id: string, tenantId: string) {
  const secret = randomBytes(32).toString("base64url");
  return {
    token: `afe_user.${Buffer.from(tenantId).toString("base64url")}.${id}.${secret}`,
    digest: digest(secret),
  };
}

/** Returns a credential once. Listing users never returns credentials or hashes. */
export async function createLocalUser(
  pool: pg.Pool | pg.PoolClient,
  tenantId: string,
  username: string,
) {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalized)) throw new Error("invalid username");
  const id = randomUUID();
  const issued = issueLocalCredential(id, tenantId);
  const result = await pool.query<LocalUser>(
    `INSERT INTO users (tenant_id, id, username, credential_digest) VALUES ($1,$2,$3,$4) RETURNING ${columns}`,
    [tenantId, id, normalized, issued.digest],
  );
  return { user: result.rows[0]!, token: issued.token };
}
export async function listLocalUsers(pool: pg.Pool, tenantId: string): Promise<LocalUser[]> {
  const result = await pool.query<LocalUser>(
    `SELECT ${columns} FROM users WHERE tenant_id=$1 ORDER BY username`,
    [tenantId],
  );
  return result.rows;
}
export async function authenticateLocalUser(pool: pg.Pool, tenantId: string, token: string) {
  const match =
    /^afe_user\.([A-Za-z0-9_-]+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
      token,
    );
  if (!match || Buffer.from(match[1]!, "base64url").toString("utf8") !== tenantId) return null;
  const result = await pool.query<LocalUser>(
    `SELECT ${columns} FROM users WHERE tenant_id=$1 AND id=$2 AND credential_digest=$3 AND NOT disabled`,
    [tenantId, match[2], digest(match[3]!)],
  );
  return result.rows[0] ?? null;
}
/** Rotation invalidates the old credential and increments the session revocation version. */
export async function resetLocalCredential(pool: pg.Pool, tenantId: string, id: string) {
  const issued = issueLocalCredential(id, tenantId);
  const result = await pool.query(
    `UPDATE users SET credential_digest=$3, credential_version=credential_version+1
     WHERE tenant_id=$1 AND id=$2 RETURNING id`,
    [tenantId, id, issued.digest],
  );
  return result.rowCount ? issued.token : null;
}
export async function setLocalUserDisabled(
  pool: pg.Pool,
  tenantId: string,
  id: string,
  disabled: boolean,
) {
  const result = await pool.query(
    `UPDATE users SET disabled=$3, credential_version=credential_version+1
     WHERE tenant_id=$1 AND id=$2 RETURNING id`,
    [tenantId, id, disabled],
  );
  return Boolean(result.rowCount);
}
export async function setUserToolPolicy(
  pool: pg.Pool,
  tenantId: string,
  userId: string,
  tool: string,
  policy: ToolPolicy,
) {
  if (
    !TOOL_PERMISSION_MODES.includes(policy.mode) ||
    !tool ||
    tool.length > 100 ||
    !Array.isArray(policy.custom) ||
    policy.custom.some(
      (g) =>
        typeof g.resource !== "string" || !g.resource || typeof g.action !== "string" || !g.action,
    )
  ) {
    throw new Error("invalid tool policy");
  }
  await pool.query(
    `INSERT INTO user_tool_permissions (tenant_id,user_id,tool,mode,custom_grants)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,user_id,tool)
     DO UPDATE SET mode=EXCLUDED.mode, custom_grants=EXCLUDED.custom_grants`,
    [
      tenantId,
      userId,
      tool,
      policy.mode,
      JSON.stringify(
        policy.custom.map((g) => ({
          ...g,
          resource: g.resource.startsWith("repository:") ? g.resource.toLowerCase() : g.resource,
        })),
      ),
    ],
  );
}
export async function getUserToolPolicy(
  pool: pg.Pool,
  tenantId: string,
  userId: string,
  tool: string,
): Promise<ToolPolicy> {
  const result = await pool.query<ToolPolicy>(
    `SELECT mode, custom_grants AS custom FROM user_tool_permissions WHERE tenant_id=$1 AND user_id=$2 AND tool=$3`,
    [tenantId, userId, tool],
  );
  return result.rows[0] ?? { mode: "none", custom: [] };
}

export async function getLocalUser(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<LocalUser | null> {
  const result = await pool.query<LocalUser>(
    `SELECT ${columns} FROM users WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  return result.rows[0] ?? null;
}
