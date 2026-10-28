import { revealIfSecret, type Secret } from "@afe/core/security";

/**
 * Minimal fetch-based GitHub REST transport.
 *
 * - Sends `User-Agent`, `Accept: application/vnd.github+json` and
 *   `X-GitHub-Api-Version` on every request.
 *   https://docs.github.com/en/rest/about-the-rest-api/api-versions
 * - Honours rate limits: remembers `x-ratelimit-remaining`/`x-ratelimit-reset`
 *   per bucket (the App JWT, or one installation) and refuses to send while a
 *   bucket is exhausted; maps 429 / 403-with-remaining-0 / `retry-after`
 *   (secondary limits) to `GitHubRateLimitError` with `retryAfter`.
 *   https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 * - Timeouts, bounded retries with backoff for 5xx and network errors,
 *   response size limit, no automatic redirects (docs/security/rules.md R6).
 * - Never puts tokens, headers or bodies in errors.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const DEFAULT_USER_AGENT = "afe-github-connector";

export interface GitHubHttpOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  userAgent?: string;
  /** Total time per attempt. Default 15 s. */
  timeoutMs?: number;
  /** Default 10 MiB. */
  maxResponseBytes?: number;
  /** Retries after the first attempt for 5xx/network errors. Default 2. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export interface GitHubRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below the base URL (e.g. "/app/installations/1") or an absolute pagination URL. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Bearer token: App JWT or installation token. Omitted for unauthenticated calls. */
  token?: string | Secret<string>;
  /** Rate-limit bucket, e.g. "app" or "installation:<id>". */
  bucket?: string;
  /**
   * Conditional request (AFE-8): sent as `If-None-Match`. A `304 Not Modified`
   * answer is then returned (status 304, `data` null) instead of raising, and
   * does not count against the primary rate limit.
   * https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate
   */
  ifNoneMatch?: string;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `x-github-request-id`, for support requests. */
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  constructor(
    status: number,
    requestId: string | null,
    readonly retryAfter: Date,
  ) {
    super(`GitHub rate limit exceeded; retry after ${retryAfter.toISOString()}`, status, requestId);
    this.name = "GitHubRateLimitError";
  }
}

export class GitHubNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubNetworkError";
  }
}

interface RateState {
  remaining: number;
  resetAt: number;
  /** `x-ratelimit-limit`, when GitHub sent it. */
  limit?: number;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

export class GitHubHttp {
  readonly baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #clock: () => number;
  readonly #rate = new Map<string, RateState>();

  constructor(options: GitHubHttpOptions = {}) {
    this.baseUrl = (options.baseUrl ?? GITHUB_API_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#clock = options.clock ?? Date.now;
  }

  /** Last known rate-limit state of a bucket (for health reporting). */
  rateLimit(bucket: string): { remaining: number; resetAt: Date; limit?: number } | null {
    const s = this.#rate.get(bucket);
    return s
      ? {
          remaining: s.remaining,
          resetAt: new Date(s.resetAt),
          ...(s.limit !== undefined ? { limit: s.limit } : {}),
        }
      : null;
  }

  url(path: string, query?: GitHubRequest["query"]): string {
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(this.baseUrl + path);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new GitHubApiError("refusing to follow a URL on another host", 0, null);
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async request<T>(req: GitHubRequest): Promise<GitHubResponse<T>> {
    const bucket = req.bucket ?? "anonymous";
    const known = this.#rate.get(bucket);
    if (known && known.remaining <= 0 && known.resetAt > this.#clock()) {
      throw new GitHubRateLimitError(0, null, new Date(known.resetAt));
    }
    const url = this.url(req.path, req.query);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": this.#userAgent,
      "x-github-api-version": GITHUB_API_VERSION,
    };
    if (req.token !== undefined) headers.authorization = `Bearer ${revealIfSecret(req.token)}`;
    if (req.ifNoneMatch) headers["if-none-match"] = req.ifNoneMatch;
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        if (req.method === "GET" && attempt < this.#maxRetries) {
          await this.#sleep(500 * 2 ** attempt);
          continue;
        }
        const kind = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
        throw new GitHubNetworkError(`GitHub request ${req.method} ${pathOf(url)} ${kind}`);
      }
      this.#recordRate(bucket, res.headers);
      if (req.method === "GET" && RETRYABLE_STATUS.has(res.status) && attempt < this.#maxRetries) {
        await res.body?.cancel().catch(() => {});
        await this.#sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 304 && req.ifNoneMatch) {
        await res.body?.cancel().catch(() => {});
        return { status: 304, data: null as T, headers: res.headers };
      }
      return this.#handle<T>(req.method, url, res);
    }
  }

  #recordRate(bucket: string, h: Headers): void {
    const remaining = h.get("x-ratelimit-remaining");
    const reset = h.get("x-ratelimit-reset");
    const limit = h.get("x-ratelimit-limit");
    if (remaining !== null && reset !== null && /^\d+$/.test(remaining) && /^\d+$/.test(reset)) {
      this.#rate.set(bucket, {
        remaining: Number(remaining),
        resetAt: Number(reset) * 1000,
        ...(limit !== null && /^\d+$/.test(limit) ? { limit: Number(limit) } : {}),
      });
    }
  }

  async #handle<T>(method: string, url: string, res: Response): Promise<GitHubResponse<T>> {
    const requestId = res.headers.get("x-github-request-id");
    const text = await readLimited(res, this.#maxBytes);
    if (res.status >= 200 && res.status < 300) {
      let data: T;
      try {
        data = (text.length > 0 ? JSON.parse(text) : null) as T;
      } catch {
        throw new GitHubApiError(
          `GitHub ${method} ${pathOf(url)} returned invalid JSON`,
          res.status,
          requestId,
        );
      }
      return { status: res.status, data, headers: res.headers };
    }
    const retryAfter = rateLimitRetryAfter(res, text, this.#clock());
    if (retryAfter) throw new GitHubRateLimitError(res.status, requestId, retryAfter);
    let detail = "";
    try {
      const msg = (JSON.parse(text) as { message?: unknown }).message;
      if (typeof msg === "string") detail = `: ${msg.slice(0, 200)}`;
    } catch {
      // not JSON; do not echo bodies
    }
    throw new GitHubApiError(
      `GitHub ${method} ${pathOf(url)} returned ${res.status}${detail}`,
      res.status,
      requestId,
    );
  }
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function rateLimitRetryAfter(res: Response, body: string, now: number): Date | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return new Date(now + Number(retryAfter) * 1000);
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset && /^\d+$/.test(reset)) return new Date(Number(reset) * 1000);
  // Secondary limit without retry-after: GitHub says wait at least one minute.
  if (res.status === 429 || /secondary rate limit/i.test(body)) return new Date(now + 60_000);
  return null;
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new GitHubApiError("GitHub response too large", res.status, null);
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
      await reader.cancel().catch(() => {});
      throw new GitHubApiError("GitHub response too large", res.status, null);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parses an RFC 8288 `Link` header and returns the `rel="next"` URL, if any. */
export function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (m && m[2]!.split(/\s+/).includes("next")) return m[1]!;
  }
  return null;
}
