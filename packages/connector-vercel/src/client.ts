import type { Secret } from "@afe/core/security";
import type {
  RateLimitInfo,
  VercelDeployment,
  VercelDeploymentListItem,
  VercelPagination,
  VercelProject,
  VercelTeam,
  VercelUser,
} from "./types.ts";

export const VERCEL_API_URL = "https://api.vercel.com";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A token, or a function that loads it at use time (so rotation/revocation take effect). */
export type TokenSource = Secret<string> | (() => Promise<Secret<string>>);

export interface VercelClientOptions {
  token: TokenSource;
  fetch?: FetchLike;
  /** Fixed to https://api.vercel.com in production; overridable for tests only. */
  baseUrl?: string;
  /** Total time per request attempt. Default 15 s. */
  timeoutMs?: number;
  /** Retries for 429 and 5xx. Default 2. */
  maxRetries?: number;
  /** Longest wait honoured for a 429 before giving up with `VercelRateLimitError`. Default 30 s. */
  maxRetryWaitMs?: number;
  /** Response size limit. Default 5 MiB. */
  maxResponseBytes?: number;
  /** Upper bound on pages fetched by one list call. Default 50. */
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A non-2xx response from the Vercel API. Never contains request headers or the token. */
export class VercelApiError extends Error {
  constructor(
    readonly status: number,
    /** Vercel's `error.code`, if any. */
    readonly code: string | null,
    /** `x-vercel-id` response header, for support requests. */
    readonly requestId: string | null,
    readonly path: string,
  ) {
    super(`Vercel API ${path} returned ${status}${code ? ` (${code})` : ""}`);
    this.name = "VercelApiError";
  }

  /**
   * 401/403: the token was revoked/expired, the integration was removed, or it
   * lost access to the team. Afe treats this as revocation (docs/connectors/vercel.md).
   */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class VercelRateLimitError extends VercelApiError {
  constructor(
    requestId: string | null,
    path: string,
    readonly retryAfter: Date | null,
  ) {
    super(429, "rate_limited", requestId, path);
    this.name = "VercelRateLimitError";
  }
}

type Query = Record<string, string | number | undefined | null>;

function parseIntHeader(h: Headers, name: string): number | null {
  const v = h.get(name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseRateLimit(headers: Headers): RateLimitInfo {
  const reset = parseIntHeader(headers, "x-ratelimit-reset");
  return {
    limit: parseIntHeader(headers, "x-ratelimit-limit"),
    remaining: parseIntHeader(headers, "x-ratelimit-remaining"),
    reset: reset === null ? null : new Date(reset * 1000),
  };
}

/** Keys whose values Afe must never store (environment variable values). */
const SENSITIVE_PAYLOAD_KEYS = new Set(["env", "envs", "buildEnv", "environmentVariables"]);

/** Recursively drops environment-variable values from an upstream payload (R8). */
export function stripSensitive<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSensitive(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_PAYLOAD_KEYS.has(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out as T;
  }
  return value;
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`Vercel API response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Vercel API response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read-only Vercel REST client (docs/security/rules.md R1.4: it only ever issues
 * `GET`). Auth-lifecycle calls (OAuth code exchange, removing Afe's own
 * integration configuration) live in `oauth.ts`, not here.
 */
export class VercelClient {
  readonly #token: TokenSource;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxRetryWaitMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxPages: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  /** Rate-limit state from the most recent response. */
  lastRateLimit: RateLimitInfo | null = null;

  constructor(options: VercelClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#baseUrl = (options.baseUrl ?? VERCEL_API_URL).replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 30_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
    this.#maxPages = options.maxPages ?? 50;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
  }

  async #tokenValue(): Promise<string> {
    const t = typeof this.#token === "function" ? await this.#token() : this.#token;
    return t.reveal();
  }

  /** The only request primitive: GET with a bearer token. */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${await this.#tokenValue()}`,
          accept: "application/json",
        },
        // R6.3: never follow redirects automatically.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      this.lastRateLimit = parseRateLimit(res.headers);
      const requestId = res.headers.get("x-vercel-id");

      if (res.status >= 200 && res.status < 300) {
        const text = await readLimited(res, this.#maxResponseBytes);
        return stripSensitive(JSON.parse(text)) as T;
      }

      let code: string | null = null;
      try {
        const body = JSON.parse(await readLimited(res, 64 * 1024)) as {
          error?: { code?: unknown };
        };
        if (typeof body.error?.code === "string") code = body.error.code;
      } catch {
        // ignore unparseable error bodies; never echo them
      }

      if (res.status === 429) {
        const reset = this.lastRateLimit.reset;
        const wait = reset ? Math.max(0, reset.getTime() - this.#now()) : 1000 * 2 ** attempt;
        if (attempt < this.#maxRetries && wait <= this.#maxRetryWaitMs) {
          await this.#sleep(wait);
          continue;
        }
        throw new VercelRateLimitError(requestId, path, reset);
      }
      if (res.status >= 500 && attempt < this.#maxRetries) {
        await this.#sleep(500 * 2 ** attempt);
        continue;
      }
      throw new VercelApiError(res.status, code, requestId, path);
    }
  }

  /** Follows `pagination.next` by passing it back as `until`. */
  async #paginate<T>(path: string, key: string, query: Query, max?: number): Promise<T[]> {
    const items: T[] = [];
    let until: number | null | undefined = (query.until as number | undefined) ?? undefined;
    for (let page = 0; page < this.#maxPages; page++) {
      const body = await this.get<Record<string, unknown>>(path, { ...query, until });
      const pageItems = (body[key] as T[] | undefined) ?? [];
      items.push(...pageItems);
      if (max !== undefined && items.length >= max) return items.slice(0, max);
      const pagination = body.pagination as VercelPagination | undefined;
      until = pagination?.next ?? null;
      if (until === null || pageItems.length === 0) break;
    }
    return items;
  }

  /** `GET /v2/user`: the authenticated user. */
  async getUser(): Promise<VercelUser> {
    const body = await this.get<{ user: VercelUser }>("/v2/user");
    return body.user;
  }

  /** `GET /v2/teams`: teams the token can access. */
  listTeams(): Promise<VercelTeam[]> {
    return this.#paginate<VercelTeam>("/v2/teams", "teams", { limit: 100 });
  }

  /** `GET /v2/teams/{id}`. */
  getTeam(teamId: string): Promise<VercelTeam> {
    return this.get<VercelTeam>(`/v2/teams/${encodeURIComponent(teamId)}`);
  }

  /** `GET /v9/projects?teamId=`. `teamId` null means the personal account. */
  listProjects(teamId: string | null, options: { max?: number } = {}): Promise<VercelProject[]> {
    return this.#paginate<VercelProject>(
      "/v9/projects",
      "projects",
      { teamId, limit: 100 },
      options.max,
    );
  }

  /**
   * `GET /v6/deployments?teamId=&projectId=&since=&until=`. Prefer the
   * project-scoped `ScopedVercelReader` in connector code, which enforces the
   * user's project selection.
   */
  listDeployments(options: {
    teamId: string | null;
    projectId?: string;
    since?: number;
    until?: number;
    max?: number;
  }): Promise<VercelDeploymentListItem[]> {
    return this.#paginate<VercelDeploymentListItem>(
      "/v6/deployments",
      "deployments",
      {
        teamId: options.teamId,
        projectId: options.projectId,
        since: options.since,
        until: options.until,
        limit: 100,
      },
      options.max,
    );
  }

  /**
   * One page of `GET /v6/deployments` (newest first). Pass `pagination.next`
   * back as `until` for the next page. Used by AFE-12 polling, which processes
   * page by page instead of buffering a whole window.
   */
  async listDeploymentsPage(options: {
    teamId: string | null;
    projectId?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<{ deployments: VercelDeploymentListItem[]; next: number | null }> {
    const body = await this.get<{
      deployments?: VercelDeploymentListItem[];
      pagination?: VercelPagination;
    }>("/v6/deployments", {
      teamId: options.teamId,
      projectId: options.projectId,
      since: options.since,
      until: options.until,
      limit: options.limit ?? 100,
    });
    const deployments = body.deployments ?? [];
    return { deployments, next: deployments.length > 0 ? (body.pagination?.next ?? null) : null };
  }

  /** `GET /v9/projects/{id}` (includes `targets` and `lastAliasRequest`). */
  getProject(projectId: string, teamId: string | null): Promise<VercelProject> {
    return this.get<VercelProject>(`/v9/projects/${encodeURIComponent(projectId)}`, { teamId });
  }

  /** `GET /v13/deployments/{id}`. */
  getDeployment(id: string, teamId: string | null): Promise<VercelDeployment> {
    return this.get<VercelDeployment>(`/v13/deployments/${encodeURIComponent(id)}`, { teamId });
  }
}
