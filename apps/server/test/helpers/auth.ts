import type { AuthProvider, Principal } from "@afe/core";

/**
 * Test-only AuthProvider for tests that are not about authentication: every
 * request is the admin of `tenantId`. Auth itself is covered by auth.test.ts.
 */
export function trustedTestAuth(tenantId = "default"): AuthProvider {
  const principal: Principal = { id: "test-admin", tenantId, roles: ["admin"], kind: "test" };
  return { authenticate: () => principal };
}

/**
 * Test AuthProvider mapping bearer tokens to principals (e.g. two tenants),
 * for wrong-tenant tests (docs/security/rules.md R9).
 */
export function tokenMapAuth(map: Record<string, Omit<Principal, "id" | "kind">>): AuthProvider {
  return {
    authenticate({ headers }) {
      const m = /^Bearer (.+)$/.exec(String(headers.authorization ?? ""));
      const p = m ? map[m[1]!] : undefined;
      return p ? { id: `token:${m![1]}`, kind: "token", ...p } : null;
    },
  };
}
