/**
 * Multi-tenancy extension point (ADR 0002 `TenantResolver`). Decides which
 * tenant an API request acts for. The tenant id must come from authenticated
 * context, never from an unauthenticated request field (docs/security/rules.md
 * R5.3).
 *
 * The open-source build has a single tenant, so its resolver always returns
 * `"default"` (DEFAULT_TENANT_ID). The hosted service supplies a resolver
 * that maps the authenticated principal to its organisation's tenant.
 */

/** The parts of an HTTP request a resolver may look at (framework-neutral). */
export interface TenantRequestContext {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Principal established by the `AuthProvider`, once there is one. */
  principal?: unknown;
}

export interface TenantResolver {
  /** Returns the tenant id for the request; throw to reject the request. */
  resolveTenant(request: TenantRequestContext): string | Promise<string>;
}

/** OSS default: every request belongs to the built-in `default` tenant. */
export const defaultTenantResolver: TenantResolver = {
  // Same value as DEFAULT_TENANT_ID (index.ts); a literal avoids an import cycle.
  resolveTenant: () => "default",
};

/**
 * Default resolver of the server (AFE-27): the tenant of the authenticated
 * principal (`Principal.tenantId`, set by the AuthProvider). Rejects requests
 * without a principal. With the OSS `StaticTokenAuthProvider` this is always
 * `default`.
 */
export const principalTenantResolver: TenantResolver = {
  resolveTenant(request) {
    const p = request.principal as { tenantId?: unknown } | undefined;
    if (!p || typeof p.tenantId !== "string" || p.tenantId === "") {
      throw new Error("no authenticated principal for tenant resolution");
    }
    return p.tenantId;
  },
};
