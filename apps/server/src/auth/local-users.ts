import type pg from "pg";
import { bearerToken, type AuthProvider } from "@afe/core";
import { authenticateLocalUser, getLocalUser } from "@afe/db";

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
      return Boolean(
        user && !user.disabled && user.credentialVersion === principal.credentialVersion,
      );
    },
  };
}
