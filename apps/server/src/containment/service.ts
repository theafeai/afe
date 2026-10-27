/**
 * Commit containment (AFE-22): "is commit X included in what is live in
 * environment Y". X is contained in the live commit L of a repository iff
 * GitHub's compare(X, L) is `ahead` or `identical` (see
 * @afe/connector-github compare.ts). Reference: docs/containment.md.
 *
 * `ContainmentService.isContained` is the reusable primitive (one pair,
 * cached); `check` answers the API question for every environment where the
 * repository is live, with bounded work per request and honest partial
 * results: anything not decided is `"unknown"` with a reason.
 */
import type { FastifyBaseLogger } from "fastify";
import { repositoryKey } from "@afe/core";
import type { Connection } from "@afe/core";
import { listConnections } from "@afe/db";
import {
  COMPARE_PERMISSION,
  GitHubApiError,
  GitHubNetworkError,
  GitHubRateLimitError,
  hasPermission,
  isContainedStatus,
  type CommitComparison,
  type GitHubConnectionConfig,
  type InstallationClient,
} from "@afe/connector-github";
import type { ServerContext } from "../context.ts";
import type { GitHubRuntime } from "../connectors/github.ts";
import { ComparisonCache } from "./cache.ts";
import { DEFAULT_MAX_PLACEMENT_EVENTS, liveDeployments, type LiveDeployment } from "./live.ts";

export type Contained = true | false | "unknown";

/** Machine-readable reason of a verdict. */
export type ContainmentReasonCode =
  // decided
  | "same_commit"
  | "ancestor"
  | "not_yet_live"
  | "diverged"
  // unknown
  | "live_commit_unknown"
  | "github_not_configured"
  | "repository_not_connected"
  | "missing_permission"
  | "installation_token_failed"
  | "commit_not_found"
  | "forbidden"
  | "rate_limited"
  | "github_unreachable"
  | "timeout"
  | "github_error"
  | "not_checked_limit"
  | "not_checked_deadline";

export interface ContainmentVerdict {
  contained: Contained;
  reasonCode: ContainmentReasonCode;
  /** Human-readable explanation. */
  reason: string;
  /** compare(commit, liveCommit), when GitHub (or the cache) answered. */
  comparison: CommitComparison | null;
  /** Whether the comparison came from the cache. */
  cached: boolean;
  /** Rate limited: when GitHub accepts requests again (ISO). */
  retryAfter?: string;
}

export interface EnvironmentContainment {
  environment: string;
  /** Mapped environment id (AFE-19), or null when the tool's own name is shown. */
  environmentId: string | null;
  source: string;
  liveCommit: string | null;
  liveSince: string;
  contained: Contained;
  reasonCode: ContainmentReasonCode;
  reason: string;
  /** Event ids of the live placement (newest first). */
  evidence: string[];
  comparison: CommitComparison | null;
  cached: boolean;
  retryAfter?: string;
}

export interface ContainmentReport {
  /** Lower-case "owner/name". */
  repository: string;
  commit: string;
  checkedAt: string;
  environments: EnvironmentContainment[];
  /** True when some environments are `unknown` for a bounded-work reason, or not all placements were read. */
  partial: boolean;
  notes: string[];
}

export interface ContainmentOptions {
  /** Environments checked per request (newest placement first). Default 10. */
  maxEnvironments?: number;
  /** Total time budget per request. Default 10 s. */
  requestTimeoutMs?: number;
  /** Time budget per compare call. Default 5 s. */
  compareTimeoutMs?: number;
  /** Compare calls in flight per request. Default 4. */
  concurrency?: number;
  /** Placement events read per request. Default 1000. */
  maxPlacementEvents?: number;
  /** In-memory cache entries. Default 5000. */
  cacheEntries?: number;
  /** Persist results in `commit_comparisons`. Default true. */
  persistCache?: boolean;
  clock?: () => number;
}

/** The repository is unknown to the tenant (no placements and no connection selecting it). */
export class RepositoryNotFoundError extends Error {
  constructor() {
    super("repository not found");
    this.name = "RepositoryNotFoundError";
  }
}

const REPO_NAME = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

/**
 * Normalises a repository argument ("owner/name", "github.com/owner/name",
 * a GitHub URL) to lower-case "owner/name"; null when it is not a GitHub
 * repository.
 */
export function githubRepositoryName(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 300) return null;
  let key: string;
  try {
    key = repositoryKey(input);
  } catch {
    return null;
  }
  if (!key.startsWith("github.com/")) return null;
  const name = key.slice("github.com/".length);
  return REPO_NAME.test(name) ? name : null;
}

/** Normalises a commit argument: lower-case hex, 7 to 64 characters; null otherwise. */
export function commitArgument(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(s) ? s : null;
}

/** Same commit, allowing either side to be abbreviated. */
function sameCommit(a: string, b: string): boolean {
  return a.length >= b.length ? a.startsWith(b) : b.startsWith(a);
}

const unknown = (
  reasonCode: ContainmentReasonCode,
  reason: string,
  extra: Partial<ContainmentVerdict> = {},
): ContainmentVerdict => ({
  contained: "unknown",
  reasonCode,
  reason,
  comparison: null,
  cached: false,
  ...extra,
});

export function verdictOf(c: CommitComparison, cached: boolean): ContainmentVerdict {
  if (isContainedStatus(c.status)) {
    return c.status === "identical"
      ? {
          contained: true,
          reasonCode: "same_commit",
          reason: "the live commit is this commit",
          comparison: c,
          cached,
        }
      : {
          contained: true,
          reasonCode: "ancestor",
          reason: `the live commit is ${c.aheadBy} commit(s) ahead and includes this commit`,
          comparison: c,
          cached,
        };
  }
  return c.status === "behind"
    ? {
        contained: false,
        reasonCode: "not_yet_live",
        reason: `the live commit is ${c.behindBy} commit(s) behind this commit (older)`,
        comparison: c,
        cached,
      }
    : {
        contained: false,
        reasonCode: "diverged",
        reason:
          "the live commit is on a different line of history (diverged); this commit is not in it",
        comparison: c,
        cached,
      };
}

/** Maps a compare failure to an "unknown" verdict. */
export function failureVerdict(err: unknown): ContainmentVerdict {
  if (err instanceof GitHubRateLimitError) {
    return unknown("rate_limited", "GitHub rate limit reached; try again later", {
      retryAfter: err.retryAfter.toISOString(),
    });
  }
  if (err instanceof GitHubApiError) {
    if (err.status === 404) {
      return unknown(
        "commit_not_found",
        "GitHub does not know one of the commits in this repository (unknown commit, or removed by a force-push)",
      );
    }
    if (err.status === 401 || err.status === 403) {
      return unknown(
        "forbidden",
        `GitHub refused the comparison (${err.status}); the installation may lack contents: read or access to this repository`,
      );
    }
    return unknown("github_error", `GitHub returned ${err.status || "an invalid answer"}`);
  }
  if (err instanceof GitHubNetworkError)
    return unknown("github_unreachable", "GitHub did not answer");
  if (err instanceof TimeoutError) return unknown("timeout", "GitHub did not answer in time");
  return unknown("github_error", "the comparison failed");
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError("timeout")), Math.max(0, ms));
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** GitHub access for one repository of a tenant, or the reason there is none. */
type Access =
  | { ok: true; client: InstallationClient; connection: Connection }
  | { ok: false; verdict: ContainmentVerdict; connected: boolean };

interface CompareContext {
  deadline: number;
  /** Set once GitHub rate limits this request: later compares are skipped. */
  rateLimited?: ContainmentVerdict;
}

export class ContainmentService {
  readonly cache: ComparisonCache;
  readonly #opts: Required<Omit<ContainmentOptions, "clock" | "cacheEntries" | "persistCache">>;
  readonly #clock: () => number;

  constructor(
    readonly ctx: Pick<ServerContext, "pool" | "retention" | "mapping"> & {
      log: FastifyBaseLogger;
    },
    readonly github: () => GitHubRuntime | undefined,
    options: ContainmentOptions = {},
  ) {
    this.#clock = options.clock ?? Date.now;
    this.#opts = {
      maxEnvironments: options.maxEnvironments ?? 10,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      compareTimeoutMs: options.compareTimeoutMs ?? 5_000,
      concurrency: Math.max(1, options.concurrency ?? 4),
      maxPlacementEvents: options.maxPlacementEvents ?? DEFAULT_MAX_PLACEMENT_EVENTS,
    };
    this.cache = new ComparisonCache({
      maxEntries: options.cacheEntries ?? 5000,
      pool: options.persistCache === false ? null : ctx.pool,
      onError: (err) =>
        ctx.log.warn({ err: (err as Error).message }, "containment: comparison cache unavailable"),
    });
  }

  /** The tenant's active GitHub connection covering `repository` ("owner/name"). */
  async #connectionFor(tenantId: string, repository: string): Promise<Connection | null> {
    const connections = await listConnections(this.ctx.pool, tenantId, {
      source: "github",
      statuses: ["active"],
    });
    const owner = repository.split("/")[0]!;
    const configOf = (c: Connection) => c.config as unknown as Partial<GitHubConnectionConfig>;
    // A selected repository wins over an "all repositories" installation on the owner.
    const selected = connections.find((c) => {
      const repos = configOf(c).repositories;
      return Array.isArray(repos) && repos.some((r) => r.fullName?.toLowerCase() === repository);
    });
    if (selected) return selected;
    return (
      connections.find(
        (c) =>
          configOf(c).repositories === "all" && configOf(c).account?.login?.toLowerCase() === owner,
      ) ?? null
    );
  }

  async #access(tenantId: string, repository: string): Promise<Access> {
    const connection = await this.#connectionFor(tenantId, repository);
    if (!connection) {
      return {
        ok: false,
        connected: false,
        verdict: unknown(
          "repository_not_connected",
          `no active GitHub installation of this tenant has access to ${repository} (not selected in the installation, or not connected)`,
        ),
      };
    }
    const perms = (connection.config as unknown as Partial<GitHubConnectionConfig>).permissions;
    if (!hasPermission(perms, COMPARE_PERMISSION)) {
      return {
        ok: false,
        connected: true,
        verdict: unknown(
          "missing_permission",
          `the GitHub App installation has not granted the optional ${COMPARE_PERMISSION}: read permission, which comparing commits needs`,
        ),
      };
    }
    const rt = this.github();
    const app = rt ? await rt.app().catch(() => null) : null;
    if (!rt || !app) {
      return {
        ok: false,
        connected: true,
        verdict: unknown(
          "github_not_configured",
          "the GitHub App is not configured on this server",
        ),
      };
    }
    try {
      const client = await rt.installationClient(connection);
      // Mint (or reuse) the token now, so a token failure is not mistaken for an unknown commit.
      await app.client.tokens.get(client.token);
      return { ok: true, client, connection };
    } catch (err) {
      const v = failureVerdict(err);
      return {
        ok: false,
        connected: true,
        verdict:
          v.reasonCode === "rate_limited"
            ? v
            : unknown(
                "installation_token_failed",
                "Afe could not get an access token for the GitHub App installation",
              ),
      };
    }
  }

  /** compare(commit, liveCommit): cache, then GitHub. */
  async #compare(
    getAccess: () => Promise<Access>,
    tenantId: string,
    repository: string,
    commit: string,
    liveCommit: string,
    cc: CompareContext,
  ): Promise<ContainmentVerdict> {
    const key = { tenantId, repository, base: commit, head: liveCommit };
    const hit = await this.cache.get(key);
    if (hit) return verdictOf(hit, true);
    if (cc.rateLimited) return cc.rateLimited;
    const access = await getAccess();
    if (!access.ok) return access.verdict;
    const left = cc.deadline - this.#clock();
    if (left <= 0) {
      return unknown("not_checked_deadline", "not checked: the request's time budget was used up");
    }
    const [owner, name] = repository.split("/") as [string, string];
    try {
      const comparison = await withTimeout(
        access.client.compareCommits(owner, name, commit, liveCommit),
        Math.min(this.#opts.compareTimeoutMs, left),
      );
      await this.cache.put(key, comparison);
      return verdictOf(comparison, false);
    } catch (err) {
      const v = failureVerdict(err);
      if (v.reasonCode === "rate_limited") cc.rateLimited = v;
      if (v.reasonCode === "github_error" || v.reasonCode === "github_unreachable") {
        this.ctx.log.warn(
          {
            tenantId,
            connectionId: access.connection.id,
            error: err instanceof Error ? err.name : "error",
          },
          "containment: compare failed",
        );
      }
      return v;
    }
  }

  /**
   * Is `commit` contained in `liveCommit` of `repository` ("owner/name")?
   * One cached comparison; never throws for GitHub failures (they are
   * `"unknown"` with a reason). Reusable by the correlation service (AFE-20).
   */
  async isContained(
    tenantId: string,
    repository: string,
    commit: string,
    liveCommit: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ContainmentVerdict> {
    const repo = githubRepositoryName(repository);
    const x = commitArgument(commit);
    const l = commitArgument(liveCommit);
    if (!repo || !x || !l) throw new TypeError("invalid repository or commit");
    if (sameCommit(x, l)) {
      return {
        contained: true,
        reasonCode: "same_commit",
        reason: "the live commit is this commit",
        comparison: null,
        cached: false,
      };
    }
    return this.#compare(() => this.#access(tenantId, repo), tenantId, repo, x, l, {
      deadline: this.#clock() + (options.timeoutMs ?? this.#opts.requestTimeoutMs),
    });
  }

  /**
   * For every environment where `repository` is live (recent placements
   * within retention): is `commit` included in the live commit? Throws
   * `RepositoryNotFoundError` when the tenant has neither placements of the
   * repository nor a GitHub connection covering it.
   */
  async check(tenantId: string, repository: string, commit: string): Promise<ContainmentReport> {
    const repo = githubRepositoryName(repository);
    const x = commitArgument(commit);
    if (!repo || !x) throw new TypeError("invalid repository or commit");
    const started = this.#clock();
    const cc: CompareContext = { deadline: started + this.#opts.requestTimeoutMs };
    const notes: string[] = [];
    let partial = false;

    const live = await liveDeployments(this.ctx, tenantId, repo, {
      now: new Date(started),
      maxEvents: this.#opts.maxPlacementEvents,
    });
    if (live.truncated) {
      partial = true;
      notes.push(
        `only the ${this.#opts.maxPlacementEvents} most recent placements were read; environments last deployed earlier are not listed`,
      );
    }
    if (live.since) notes.push(`placements since ${live.since} (retention window) were considered`);

    let access: Promise<Access> | null = null;
    const accessOnce = () => (access ??= this.#access(tenantId, repo));

    if (live.deployments.length === 0) {
      const a = await accessOnce();
      if (!a.ok && !a.connected) throw new RepositoryNotFoundError();
      notes.push("the repository is not live in any environment Afe has seen recently");
    }

    const checked = live.deployments.slice(0, this.#opts.maxEnvironments);
    const skipped = live.deployments.slice(this.#opts.maxEnvironments);
    if (skipped.length > 0) {
      partial = true;
      notes.push(
        `${skipped.length} more environment(s) were not checked (at most ${this.#opts.maxEnvironments} per request)`,
      );
    }

    // One comparison per distinct live commit, a few at a time.
    const verdicts = new Map<string, Promise<ContainmentVerdict>>();
    const queue: (() => Promise<void>)[] = [];
    const verdictFor = (d: LiveDeployment): Promise<ContainmentVerdict> => {
      if (d.liveCommit === null) {
        return Promise.resolve(
          unknown(
            "live_commit_unknown",
            "the live deployment does not name a single commit of this repository",
          ),
        );
      }
      const l = d.liveCommit;
      if (sameCommit(x, l)) {
        return Promise.resolve({
          contained: true,
          reasonCode: "same_commit",
          reason: "the live commit is this commit",
          comparison: null,
          cached: false,
        } satisfies ContainmentVerdict);
      }
      let p = verdicts.get(l);
      if (!p) {
        p = new Promise<ContainmentVerdict>((resolve) => {
          queue.push(async () =>
            resolve(await this.#compare(accessOnce, tenantId, repo, x, l, cc)),
          );
        });
        verdicts.set(l, p);
      }
      return p;
    };
    const pending = checked.map((d) => verdictFor(d));
    const workers = Array.from(
      { length: Math.min(this.#opts.concurrency, queue.length) },
      async () => {
        for (let job = queue.shift(); job; job = queue.shift()) await job();
      },
    );
    await Promise.all(workers);
    const results = await Promise.all(pending);

    const environments: EnvironmentContainment[] = checked.map((d, i) => {
      const v = results[i]!;
      return {
        environment: d.environment,
        environmentId: d.environmentId,
        source: d.source,
        liveCommit: d.liveCommit,
        liveSince: d.liveSince,
        contained: v.contained,
        reasonCode: v.reasonCode,
        reason: v.reason,
        evidence: d.evidence,
        comparison: v.comparison,
        cached: v.cached,
        ...(v.retryAfter ? { retryAfter: v.retryAfter } : {}),
      };
    });
    for (const d of skipped) {
      environments.push({
        environment: d.environment,
        environmentId: d.environmentId,
        source: d.source,
        liveCommit: d.liveCommit,
        liveSince: d.liveSince,
        contained: "unknown",
        reasonCode: "not_checked_limit",
        reason: `not checked: at most ${this.#opts.maxEnvironments} environments per request`,
        evidence: d.evidence,
        comparison: null,
        cached: false,
      });
    }
    if (
      environments.some((e) =>
        ["not_checked_deadline", "timeout", "rate_limited"].includes(e.reasonCode),
      )
    ) {
      partial = true;
    }
    return {
      repository: repo,
      commit: x,
      checkedAt: new Date(started).toISOString(),
      environments,
      partial,
      notes,
    };
  }
}
