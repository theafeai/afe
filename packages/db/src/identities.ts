/**
 * User identities at upstream providers, the per-user source access cache and
 * Sign in with GitHub settings (ADR 0020; migrations 0039-0041). Every function takes
 * the tenant id and puts it in every statement (docs/security/rules.md R5).
 */
import type pg from "pg";
import type { EventAccessRule } from "@afe/core";

type Db = pg.Pool | pg.PoolClient;

export type IdentityProvider = "github";

export interface ExternalIdentity {
  userId: string;
  provider: IdentityProvider;
  /** Provider's numeric account id, as a decimal string. Matching uses this only. */
  subject: string;
  /** Display only: logins can be renamed and reused. */
  login: string;
  provisioned: boolean;
  verifiedAt: string;
}

const identityColumns = `user_id AS "userId", provider, subject, login, provisioned,
  verified_at AS "verifiedAt"`;

/** A GitHub numeric id from an API response, or null when it is not a positive safe integer. */
export function githubSubject(id: unknown): string | null {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

export async function getExternalIdentityBySubject(
  db: Db,
  tenantId: string,
  provider: IdentityProvider,
  subject: string,
): Promise<ExternalIdentity | null> {
  const r = await db.query<ExternalIdentity>(
    `SELECT ${identityColumns} FROM user_external_identities
     WHERE tenant_id=$1 AND provider=$2 AND subject=$3`,
    [tenantId, provider, subject],
  );
  return r.rows[0] ?? null;
}

export async function getExternalIdentityForUser(
  db: Db,
  tenantId: string,
  userId: string,
  provider: IdentityProvider,
): Promise<ExternalIdentity | null> {
  const r = await db.query<ExternalIdentity>(
    `SELECT ${identityColumns} FROM user_external_identities
     WHERE tenant_id=$1 AND user_id=$2 AND provider=$3`,
    [tenantId, userId, provider],
  );
  return r.rows[0] ?? null;
}

/**
 * Binds `subject` to the user, replacing the user's previous identity for the
 * provider. Returns "conflict" (and changes nothing) when the upstream account is
 * already bound to another user of the tenant, except that it moves between two
 * administrator storage accounts (ADR 0012; see below). Call inside the transaction that
 * holds the user's row lock when linking.
 */
export async function bindExternalIdentity(
  db: pg.PoolClient,
  tenantId: string,
  userId: string,
  identity: { provider: IdentityProvider; subject: string; login: string; provisioned?: boolean },
): Promise<"bound" | "conflict"> {
  const owner = await db.query<{ user_id: string }>(
    `SELECT user_id FROM user_external_identities
     WHERE tenant_id=$1 AND provider=$2 AND subject=$3 FOR UPDATE`,
    [tenantId, identity.provider, identity.subject],
  );
  const previous = owner.rows[0]?.user_id;
  let moveFrom: string | null = null;
  if (previous && previous !== userId) {
    // Administrator storage accounts (ADR 0012) are not logins: an administrator
    // principal change (e.g. AFE_ADMIN_TOKEN rotation) creates a new storage
    // account and requires a fresh link. That fresh link, proven with a token for
    // the same GitHub account, takes the identity over from the old storage
    // account. Every other conflict (any managed user involved) is refused.
    const admins = await db.query<{ user_id: string }>(
      "SELECT user_id FROM github_admin_identities WHERE tenant_id=$1 AND user_id = ANY($2::uuid[])",
      [tenantId, [previous, userId]],
    );
    if (admins.rowCount !== 2) return "conflict";
    moveFrom = previous;
  }
  await db.query("SAVEPOINT bind_identity");
  try {
    if (moveFrom)
      await db.query(
        `DELETE FROM user_external_identities
         WHERE tenant_id=$1 AND provider=$2 AND subject=$3 AND user_id=$4`,
        [tenantId, identity.provider, identity.subject, moveFrom],
      );
    await db.query(
      `DELETE FROM user_external_identities
       WHERE tenant_id=$1 AND user_id=$2 AND provider=$3 AND subject<>$4`,
      [tenantId, userId, identity.provider, identity.subject],
    );
    const written = await db.query(
      `INSERT INTO user_external_identities (tenant_id,user_id,provider,subject,login,provisioned)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,provider,subject) DO UPDATE
       SET login=EXCLUDED.login, verified_at=now(),
           provisioned=user_external_identities.provisioned OR EXCLUDED.provisioned
       WHERE user_external_identities.user_id=EXCLUDED.user_id`,
      [
        tenantId,
        userId,
        identity.provider,
        identity.subject,
        identity.login,
        identity.provisioned ?? false,
      ],
    );
    if (!written.rowCount) {
      // A concurrent link bound the account to another user first.
      await db.query("ROLLBACK TO SAVEPOINT bind_identity");
      return "conflict";
    }
    await db.query("RELEASE SAVEPOINT bind_identity");
    return "bound";
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT bind_identity");
    if ((error as { code?: string }).code === "23505") return "conflict";
    throw error;
  }
}

/**
 * Backfill for links made before 0039: records the identity resolved with the
 * user's own token unless the user already has one or the account belongs to
 * someone else. Never moves an identity between users.
 */
export async function backfillExternalIdentity(
  db: Db,
  tenantId: string,
  userId: string,
  identity: { provider: IdentityProvider; subject: string; login: string },
): Promise<void> {
  await db.query(
    `INSERT INTO user_external_identities (tenant_id,user_id,provider,subject,login)
     SELECT $1,$2,$3,$4,$5 WHERE EXISTS (SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2)
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, identity.provider, identity.subject, identity.login],
  );
}

export async function deleteExternalIdentity(
  db: Db,
  tenantId: string,
  userId: string,
  provider: IdentityProvider,
): Promise<void> {
  await db.query(
    "DELETE FROM user_external_identities WHERE tenant_id=$1 AND user_id=$2 AND provider=$3",
    [tenantId, userId, provider],
  );
}

// --- Per-user source access cache (ADR 0020) --------------------------------

export interface CachedSourceAccess {
  rules: EventAccessRule[];
  fetchedAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The cached rules of the user's current credential for `tool`, or null. The
 * caller enforces the TTL; this never returns a row of another credential.
 */
export async function getUserSourceAccess(
  db: Db,
  tenantId: string,
  userId: string,
  tool: string,
  credentialId: string,
): Promise<CachedSourceAccess | null> {
  if (!UUID.test(credentialId)) return null;
  const r = await db.query<{ rules: EventAccessRule[]; fetched_at: Date }>(
    `SELECT rules, fetched_at FROM user_source_access
     WHERE tenant_id=$1 AND user_id=$2 AND tool=$3 AND credential_id=$4`,
    [tenantId, userId, tool, credentialId],
  );
  const row = r.rows[0];
  return row && Array.isArray(row.rules) ? { rules: row.rules, fetchedAt: row.fetched_at } : null;
}

/**
 * Stores freshly checked rules, but only while the same credential is still
 * linked, the user is enabled and the tool policy is still Source. A refresh
 * that raced an unlink, relink, disable or policy change therefore writes nothing.
 */
export async function putUserSourceAccess(
  db: Db,
  tenantId: string,
  userId: string,
  tool: string,
  credentialId: string,
  rules: readonly EventAccessRule[],
  fetchedAt: Date,
): Promise<boolean> {
  if (!UUID.test(credentialId)) return false;
  const r = await db.query(
    `INSERT INTO user_source_access (tenant_id,user_id,tool,credential_id,rules,fetched_at)
     SELECT $1,$2,$3,$4,$5::jsonb,$6
     WHERE EXISTS (SELECT 1 FROM user_tool_accounts a
                   WHERE a.tenant_id=$1 AND a.user_id=$2 AND a.tool=$3 AND a.credential_id=$4)
       AND EXISTS (SELECT 1 FROM users u WHERE u.tenant_id=$1 AND u.id=$2 AND NOT u.disabled)
       AND EXISTS (SELECT 1 FROM user_tool_permissions p
                   WHERE p.tenant_id=$1 AND p.user_id=$2 AND p.tool=$3 AND p.mode='source')
     ON CONFLICT (tenant_id,user_id,tool) DO UPDATE
     SET credential_id=EXCLUDED.credential_id, rules=EXCLUDED.rules, fetched_at=EXCLUDED.fetched_at`,
    [tenantId, userId, tool, credentialId, JSON.stringify(rules), fetchedAt],
  );
  return Boolean(r.rowCount);
}

/** Drops cached access for one user (all tools when `tool` is omitted). */
export async function deleteUserSourceAccess(
  db: Db,
  tenantId: string,
  userId: string,
  tool?: string,
): Promise<void> {
  await db.query(
    tool
      ? "DELETE FROM user_source_access WHERE tenant_id=$1 AND user_id=$2 AND tool=$3"
      : "DELETE FROM user_source_access WHERE tenant_id=$1 AND user_id=$2",
    tool ? [tenantId, userId, tool] : [tenantId, userId],
  );
}

/** Removes rows that can no longer be served (data minimisation). */
export async function purgeUserSourceAccessBefore(
  db: Db,
  tenantId: string,
  before: Date,
): Promise<number> {
  const r = await db.query("DELETE FROM user_source_access WHERE tenant_id=$1 AND fetched_at<$2", [
    tenantId,
    before,
  ]);
  return r.rowCount ?? 0;
}

// --- Sign in with GitHub (ADR 0020) -------------------------------------------

export interface GitHubSignInSettings {
  enabled: boolean;
  autoProvision: boolean;
  /** Lowercase organization logins. */
  allowedOrgs: string[];
  /** Always "viewer": auto-provisioned users are managed users, never admins. */
  defaultRole: "viewer";
}

export const DEFAULT_GITHUB_SIGN_IN: GitHubSignInSettings = {
  enabled: false,
  autoProvision: false,
  allowedOrgs: [],
  defaultRole: "viewer",
};

export async function getGitHubSignInSettings(
  db: Db,
  tenantId: string,
): Promise<GitHubSignInSettings> {
  const r = await db.query<GitHubSignInSettings>(
    `SELECT enabled, auto_provision AS "autoProvision", allowed_orgs AS "allowedOrgs",
       default_role AS "defaultRole" FROM github_sign_in WHERE tenant_id=$1`,
    [tenantId],
  );
  return r.rows[0] ?? { ...DEFAULT_GITHUB_SIGN_IN, allowedOrgs: [] };
}

export async function putGitHubSignInSettings(
  db: Db,
  tenantId: string,
  s: GitHubSignInSettings,
): Promise<void> {
  if (s.defaultRole !== "viewer") throw new Error("invalid default role");
  await db.query(
    `INSERT INTO github_sign_in (tenant_id,enabled,auto_provision,allowed_orgs,default_role,updated_at)
     VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (tenant_id) DO UPDATE
     SET enabled=EXCLUDED.enabled, auto_provision=EXCLUDED.auto_provision,
         allowed_orgs=EXCLUDED.allowed_orgs, default_role=EXCLUDED.default_role, updated_at=now()`,
    [tenantId, s.enabled, s.autoProvision, s.allowedOrgs, s.defaultRole],
  );
}

export async function createGitHubSignInState(
  db: Db,
  tenantId: string,
  state: { digest: string; browserBinding: string; nextPath: string; ttlSeconds: number },
): Promise<void> {
  await db.query("DELETE FROM github_sign_in_states WHERE tenant_id=$1 AND expires_at<now()", [
    tenantId,
  ]);
  await db.query(
    `INSERT INTO github_sign_in_states (tenant_id,digest,browser_binding,next_path,expires_at)
     VALUES ($1,$2,$3,$4,now()+make_interval(secs => $5))`,
    [tenantId, state.digest, state.browserBinding, state.nextPath, state.ttlSeconds],
  );
}

/** Single use: deletes the matching unexpired state and returns its `next` path. */
export async function consumeGitHubSignInState(
  db: Db,
  tenantId: string,
  digest: string,
  browserBinding: string,
): Promise<string | null> {
  const r = await db.query<{ next_path: string }>(
    `DELETE FROM github_sign_in_states
     WHERE tenant_id=$1 AND digest=$2 AND browser_binding=$3 AND expires_at>now()
     RETURNING next_path`,
    [tenantId, digest, browserBinding],
  );
  return r.rows[0]?.next_path ?? null;
}
