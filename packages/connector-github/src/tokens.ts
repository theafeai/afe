import type { Secret } from "@afe/core/security";
import type { PermissionMap } from "./types.ts";

/**
 * A short-lived installation access token (GitHub issues them for one hour).
 * Kept only in memory, wrapped in `Secret`; never persisted, logged or put in
 * a job payload.
 */
export interface InstallationToken {
  token: Secret<string>;
  expiresAt: Date;
  permissions: PermissionMap;
  repositorySelection?: "all" | "selected";
}

export interface TokenRequest {
  /** Tenant that owns the connection; part of the cache key (rules R5.7). */
  tenantId?: string;
  installationId: number | string;
  /** Narrow the token to these permissions (e.g. read-only). */
  permissions?: PermissionMap;
}

export type MintToken = (req: TokenRequest) => Promise<InstallationToken>;

export interface InstallationTokenCacheOptions {
  /** Refresh tokens this long before they expire. Default 5 minutes. */
  refreshMarginMs?: number;
  clock?: () => number;
}

/**
 * In-memory cache of installation tokens, fetched on demand and reused until
 * shortly before expiry. Concurrent requests for the same key share one mint.
 */
export class InstallationTokenCache {
  readonly #mint: MintToken;
  readonly #margin: number;
  readonly #clock: () => number;
  readonly #tokens = new Map<string, InstallationToken>();
  readonly #inflight = new Map<string, Promise<InstallationToken>>();

  constructor(mint: MintToken, options: InstallationTokenCacheOptions = {}) {
    this.#mint = mint;
    this.#margin = options.refreshMarginMs ?? 5 * 60_000;
    this.#clock = options.clock ?? Date.now;
  }

  static key(req: TokenRequest): string {
    const perms = Object.entries(req.permissions ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return JSON.stringify([req.tenantId ?? "", String(req.installationId), perms]);
  }

  async get(req: TokenRequest): Promise<InstallationToken> {
    const key = InstallationTokenCache.key(req);
    const cached = this.#tokens.get(key);
    if (cached && cached.expiresAt.getTime() - this.#margin > this.#clock()) return cached;
    this.#tokens.delete(key);
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const p = this.#mint(req)
      .then((t) => {
        this.#tokens.set(key, t);
        return t;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  /** Drops every cached token of an installation (uninstall, suspend, permission change). */
  invalidate(installationId: number | string): void {
    const id = String(installationId);
    for (const key of this.#tokens.keys()) {
      if ((JSON.parse(key) as string[])[1] === id) this.#tokens.delete(key);
    }
  }

  get size(): number {
    return this.#tokens.size;
  }
}
