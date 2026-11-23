import type pg from "pg";
import { bearerToken, type AuthProvider } from "@afe/core";
import { authenticateLocalUser, getExternalIdentityForUser, getLocalUser } from "@afe/db";

/** Principal kind (and session `via`) of users who signed in with GitHub. */
export const GITHUB_SIGN_IN_KIND = "github";

/** True while the user still has a GitHub identity and a linked GitHub account. */
export async function githubSignInLinked(
  pool: pg.Pool,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  if (!(await getExternalIdentityForUser(pool, tenantId, userId, "github"))) return false;
  const linked = await pool.query(
    "SELECT 1 FROM user_tool_accounts WHERE tenant_id=$1 AND user_id=$2 AND tool='github'",
    [tenantId, userId],
  );
  return Boolean(linked.rowCount);
}

/** The bootstrap/hosted provider retains its authority; local users are never admins. */
export function withLocalUsers(pool: pg.Pool, fallback: AuthProvider): AuthProvider {
  return {
    async authenticate(request) {
      const token = bearerToken(request.headers);
      if (!token?.startsWith("afe_user.")) return fallback.authenticate(request);
      if (token.length > 1024) return null;
      const tenantPart = token.split(".")[1];
      if (!tenantPart || !/^[A-Za-z0-9_-]+$/.test(tenantPart)) return null;
      const tenantId = Buffer.from(tenantPart, "base64url").toString("utf8");
      if (!tenantId || tenantId.length > 128) return null;
      const user = await authenticateLocalUser(pool, tenantId, token);
      return user
        ? {
            id: `local:${user.id}`,
            tenantId,
            roles: ["viewer"],
            kind: "local",
            name: user.username,
            localUserId: user.id,
            credentialVersion: user.credentialVersion,
          }
        : null;
    },
    async isActive(principal) {
      if (!principal.localUserId) return fallback.isActive ? fallback.isActive(principal) : true;
      const user = await getLocalUser(pool, principal.tenantId, principal.localUserId);
      if (!user || user.disabled || user.credentialVersion !== principal.credentialVersion)
        return false;
      // Sessions from Sign in with GitHub end when the GitHub identity is unlinked.
      if (principal.kind === GITHUB_SIGN_IN_KIND)
        return githubSignInLinked(pool, principal.tenantId, principal.localUserId);
      return true;
    },
  };
}
