import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createLocalUser, setUserToolPolicy } from "./users.ts";

export async function getGitHubAdminIdentity(
  pool: pg.Pool | pg.PoolClient,
  tenantId: string,
  principalId: string,
): Promise<string | null> {
  const result = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM github_admin_identities WHERE tenant_id=$1 AND principal_id=$2",
    [tenantId, principalId],
  );
  return result.rows[0]?.user_id ?? null;
}

/** Only call after administrator authorization and explicit personal linking. */
export async function ensureGitHubAdminIdentity(
  pool: pg.Pool,
  tenantId: string,
  principalId: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Concurrent first links must select the same account and credential lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify(["github-admin", tenantId, principalId]),
    ]);
    let userId = await getGitHubAdminIdentity(client, tenantId, principalId);
    if (!userId) {
      // Reuse encrypted account storage and exact user policies. No Afe login
      // credential is returned or retained; the existing admin session is used.
      const created = await createLocalUser(client, tenantId, `github-admin-${randomUUID()}`);
      userId = created.user.id;
      await client.query(
        "INSERT INTO github_admin_identities (tenant_id,principal_id,user_id) VALUES ($1,$2,$3)",
        [tenantId, principalId, userId],
      );
      await setUserToolPolicy(client, tenantId, userId, "github", { mode: "source", custom: [] });
    }
    await client.query("COMMIT");
    return userId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
