/**
 * Authentication extension point (ADR 0002 `AuthProvider`, ADR 0006).
 *
 * An `AuthProvider` turns the credentials of an HTTP request (headers and
 * cookies, framework-neutral) into a `Principal`: who is calling, for which
 * tenant, with which roles. The server asks it once per `/api/*` request and
 * derives the tenant from the principal (never from a request field,
 * docs/security/rules.md R5.3).
 *
 * - OSS default: `StaticTokenAuthProvider` (admin token from
 *   `AFE_ADMIN_TOKEN`, optional read-only `AFE_VIEWER_TOKEN`, tenant always
 *   `default`), plus the server's own signed session cookie for the web UI.
 * - Hosted: SSO/SAML/SCIM-backed providers that map users to organisations.
 */
import { createHash, timingSafeEqual } from "node:crypto";

// Same value as DEFAULT_TENANT_ID (index.ts); a literal avoids an import cycle.
const DEFAULT_TENANT_ID = "default";

export type Role = "admin" | "viewer";
export const ROLES: readonly Role[] = ["admin", "viewer"];

export interface Principal {
  /** Stable, non-secret identifier of the caller (user id, token fingerprint). */
  id: string;
  /** Tenant this principal acts for. Authoritative for every data access. */
  tenantId: string;
  roles: Role[];
  /** How the principal authenticated, e.g. "token", "session", "sso". */
  kind: string;
  /** Optional display name for the UI. */
  name?: string;
}

/** The parts of an HTTP request an AuthProvider may look at. */
export interface AuthRequestContext {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  cookies: Readonly<Record<string, string | undefined>>;
}

export interface AuthProvider {
  /**
   * Returns the authenticated principal, or null when the request carries no
   * valid credentials. Must not throw for bad credentials (return null) and
   * must never log them.
   */
  authenticate(request: AuthRequestContext): Principal | null | Promise<Principal | null>;
  /**
   * Optional: whether a principal established earlier (stored in a session
   * cookie) is still valid, e.g. its token was not rotated. Default: valid
   * until the session expires.
   */
  isActive?(principal: Principal): boolean | Promise<boolean>;
}

/** True when the principal has `role`. Admins can do everything viewers can. */
export function hasRole(principal: Principal, role: Role): boolean {
  if (principal.roles.includes("admin")) return true;
  return principal.roles.includes(role);
}

/** Minimum length of static API tokens (32 characters, e.g. `openssl rand -hex 32` gives 64). */
export const MIN_TOKEN_LENGTH = 32;

/** Extracts the token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | null {
  const h = headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer[ ]+([^\s]+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

function digest(label: string, value: string): Buffer {
  return createHash("sha256").update(label).update("\0").update(value, "utf8").digest();
}

/** Constant-time comparison of two strings (compares SHA-256 digests, so lengths do not leak). */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest("afe-cmp", a), digest("afe-cmp", b));
}

/** Non-secret fingerprint of a token, used as the principal id. */
export function tokenFingerprint(token: string): string {
  return digest("afe-token-fingerprint-v1", token).toString("hex").slice(0, 16);
}

export interface StaticTokenAuthOptions {
  /** Full access. At least MIN_TOKEN_LENGTH characters. */
  adminToken: string;
  /** Optional read-only access. At least MIN_TOKEN_LENGTH characters, distinct from the admin token. */
  viewerToken?: string;
  /** Tenant of both principals. Default `default`. */
  tenantId?: string;
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

function checkToken(name: string, token: string): void {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new AuthConfigError(
      `${name} must be at least ${MIN_TOKEN_LENGTH} characters (generate one with: openssl rand -hex 32)`,
    );
  }
  if (/\s/.test(token)) throw new AuthConfigError(`${name} must not contain whitespace`);
}

/**
 * OSS default AuthProvider: static bearer tokens. The admin token grants
 * every API; the optional viewer token is read-only. Tokens are compared in
 * constant time and are never stored in principals or sessions (only a
 * fingerprint is), so rotating a token invalidates every session made with it.
 */
export class StaticTokenAuthProvider implements AuthProvider {
  readonly #admin: string;
  readonly #viewer: string | null;
  readonly #tenantId: string;
  readonly #adminId: string;
  readonly #viewerId: string | null;

  constructor(options: StaticTokenAuthOptions) {
    checkToken("AFE_ADMIN_TOKEN", options.adminToken);
    if (options.viewerToken !== undefined) {
      checkToken("AFE_VIEWER_TOKEN", options.viewerToken);
      if (constantTimeEqual(options.viewerToken, options.adminToken)) {
        throw new AuthConfigError("AFE_VIEWER_TOKEN must differ from AFE_ADMIN_TOKEN");
      }
    }
    this.#admin = options.adminToken;
    this.#viewer = options.viewerToken ?? null;
    this.#tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
    this.#adminId = `admin-token:${tokenFingerprint(this.#admin)}`;
    this.#viewerId = this.#viewer ? `viewer-token:${tokenFingerprint(this.#viewer)}` : null;
  }

  /** Principal for a presented token, or null. */
  principalForToken(token: string): Principal | null {
    // Compare against both tokens every time so timing does not reveal which one matched.
    const isAdmin = constantTimeEqual(token, this.#admin);
    const isViewer = this.#viewer !== null && constantTimeEqual(token, this.#viewer);
    if (isAdmin) {
      return { id: this.#adminId, tenantId: this.#tenantId, roles: ["admin"], kind: "token" };
    }
    if (isViewer) {
      return { id: this.#viewerId!, tenantId: this.#tenantId, roles: ["viewer"], kind: "token" };
    }
    return null;
  }

  authenticate(request: AuthRequestContext): Principal | null {
    const token = bearerToken(request.headers);
    return token ? this.principalForToken(token) : null;
  }

  isActive(principal: Principal): boolean {
    return (
      principal.tenantId === this.#tenantId &&
      (principal.id === this.#adminId || principal.id === this.#viewerId)
    );
  }
}

/** Rejects every request. Used when no authentication is configured (fail closed). */
export const denyAllAuthProvider: AuthProvider = {
  authenticate: () => null,
  isActive: () => false,
};
