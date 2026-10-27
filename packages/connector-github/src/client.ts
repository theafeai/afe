import { Secret } from "@afe/core/security";
import type { GitHubAppConfig } from "./config.ts";
import {
  GitHubApiError,
  GitHubHttp,
  nextPageUrl,
  type GitHubHttpOptions,
  type GitHubRequest,
} from "./http.ts";
import { AppJwtSource } from "./jwt.ts";
import { InstallationTokenCache, type InstallationToken, type TokenRequest } from "./tokens.ts";
import type { GitHubAttestationsResponse } from "./artifact.ts";
import type {
  GitHubDeployment,
  GitHubDeploymentStatus,
  GitHubInstallation,
  GitHubInstallationTokenResponse,
  GitHubManifestConversion,
  GitHubRepository,
  GitHubRunApproval,
  GitHubWorkflowRun,
  PermissionMap,
} from "./types.ts";

/** One page of a (possibly conditional) GET, for reconciliation (AFE-8). */
export interface ConditionalPage<T> {
  /** 200, or 304 when the request was conditional and nothing changed (`data` is null). */
  status: number;
  data: T | null;
  /** `ETag` of the response (on 304, the one sent or GitHub's echo of it). */
  etag: string | null;
  /** `Link: rel="next"` URL, if any. */
  next: string | null;
  /** `X-Poll-Interval` in seconds (events API), if any. */
  pollIntervalSeconds: number | null;
}

export interface PageOptions {
  /** Items per page (GitHub max 100). Default 100. */
  perPage?: number;
  /** Stop after this many pages. Default 50. */
  maxPages?: number;
}

const seg = (s: string | number) => encodeURIComponent(String(s));

/**
 * Typed GitHub client for one App. App-level calls authenticate with the App
 * JWT; repository reads go through `installation(...)`, which uses cached
 * short-lived installation tokens.
 *
 * Methods are read-only (GET), with two documented exceptions that do not
 * change anything in the customer's GitHub: minting an installation token
 * (POST /app/installations/{id}/access_tokens) and the one-time App Manifest
 * code conversion (POST /app-manifests/{code}/conversions).
 */
export class GitHubAppClient {
  readonly http: GitHubHttp;
  readonly tokens: InstallationTokenCache;
  readonly #jwt: AppJwtSource;

  constructor(
    readonly config: Pick<GitHubAppConfig, "appId" | "privateKey">,
    options: GitHubHttpOptions & { tokenRefreshMarginMs?: number } = {},
  ) {
    this.http = new GitHubHttp(options);
    this.#jwt = new AppJwtSource(
      { appId: config.appId, privateKey: config.privateKey },
      options.clock ?? Date.now,
    );
    this.tokens = new InstallationTokenCache((req) => this.createInstallationToken(req), {
      ...(options.tokenRefreshMarginMs !== undefined
        ? { refreshMarginMs: options.tokenRefreshMarginMs }
        : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }

  #app<T>(req: Omit<GitHubRequest, "token" | "bucket">) {
    return this.http.request<T>({ ...req, token: this.#jwt.get(), bucket: "app" });
  }

  /** GET /app/installations/{installation_id} */
  async getInstallation(installationId: number | string): Promise<GitHubInstallation> {
    return (
      await this.#app<GitHubInstallation>({
        method: "GET",
        path: `/app/installations/${seg(installationId)}`,
      })
    ).data;
  }

  /**
   * POST /app/installations/{installation_id}/access_tokens. Use
   * `tokens.get()` (cached) instead of calling this directly.
   */
  async createInstallationToken(req: TokenRequest): Promise<InstallationToken> {
    const body =
      req.permissions && Object.keys(req.permissions).length > 0
        ? { permissions: req.permissions }
        : undefined;
    const { data } = await this.#app<GitHubInstallationTokenResponse>({
      method: "POST",
      path: `/app/installations/${seg(req.installationId)}/access_tokens`,
      ...(body ? { body } : {}),
    });
    return {
      token: new Secret(data.token),
      expiresAt: new Date(data.expires_at),
      permissions: data.permissions ?? {},
      ...(data.repository_selection ? { repositorySelection: data.repository_selection } : {}),
    };
  }

  /** A client for repository reads within one installation. */
  installation(
    installationId: number | string,
    options: { tenantId?: string; permissions?: PermissionMap } = {},
  ): InstallationClient {
    return new InstallationClient(this, { installationId, ...options });
  }
}

/** Repository reads for one installation, authenticated with installation tokens. */
export class InstallationClient {
  constructor(
    private readonly app: GitHubAppClient,
    readonly token: TokenRequest,
  ) {}

  /** Rate-limit bucket of this installation in the shared transport. */
  get bucket(): string {
    return `installation:${this.token.installationId}`;
  }

  /** Last known rate-limit state of this installation (null before the first call). */
  rateLimit(): { remaining: number; resetAt: Date; limit?: number } | null {
    return this.app.http.rateLimit(this.bucket);
  }

  async #get<T>(path: string, query?: GitHubRequest["query"], ifNoneMatch?: string) {
    const { token } = await this.app.tokens.get(this.token);
    return this.app.http.request<T>({
      method: "GET",
      path,
      ...(query ? { query } : {}),
      ...(ifNoneMatch ? { ifNoneMatch } : {}),
      token,
      bucket: this.bucket,
    });
  }

  /**
   * One GET page (a path below the API, or a pagination URL on the same
   * host), optionally conditional on a stored `ETag`. Used by reconciliation
   * (AFE-8), which stores ETags per endpoint and page.
   */
  async getPage<T>(
    path: string,
    query?: GitHubRequest["query"],
    options: { etag?: string | null } = {},
  ): Promise<ConditionalPage<T>> {
    const res = await this.#get<T>(path, query, options.etag ?? undefined);
    const poll = res.headers.get("x-poll-interval");
    return {
      status: res.status,
      data: res.status === 304 ? null : res.data,
      etag: res.headers.get("etag") ?? (res.status === 304 ? (options.etag ?? null) : null),
      next: nextPageUrl(res.headers.get("link")),
      pollIntervalSeconds: poll && /^\d+$/.test(poll) ? Number(poll) : null,
    };
  }

  /**
   * Follows `Link: rel="next"` pages. `extract` picks the items out of each
   * page body (GitHub wraps some lists in an object).
   */
  async *paginate<P, T>(
    path: string,
    query: GitHubRequest["query"],
    extract: (page: P) => T[],
    options: PageOptions = {},
  ): AsyncGenerator<T> {
    const maxPages = options.maxPages ?? 50;
    let url: string | null = path;
    let q: GitHubRequest["query"] | undefined = { per_page: options.perPage ?? 100, ...query };
    for (let page = 0; url && page < maxPages; page++) {
      const res: { data: P; headers: Headers } = await this.#get<P>(url, q);
      for (const item of extract(res.data)) yield item;
      url = nextPageUrl(res.headers.get("link"));
      q = undefined; // the next URL carries the query
    }
  }

  async #all<P, T>(
    path: string,
    query: GitHubRequest["query"],
    extract: (page: P) => T[],
    options?: PageOptions,
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.paginate(path, query, extract, options)) out.push(item);
    return out;
  }

  /** GET /installation/repositories (all pages). */
  listRepositories(options?: PageOptions): Promise<GitHubRepository[]> {
    return this.#all<{ repositories: GitHubRepository[] }, GitHubRepository>(
      "/installation/repositories",
      {},
      (p) => p.repositories ?? [],
      options,
    );
  }

  /**
   * GET /repos/{owner}/{repo}/actions/runs. Filters: `created` (e.g.
   * ">=2026-10-01"), `event`, `status`, `branch`, `head_sha`.
   */
  listWorkflowRuns(
    owner: string,
    repo: string,
    filters: Record<string, string | undefined> = {},
    options?: PageOptions,
  ): Promise<GitHubWorkflowRun[]> {
    return this.#all<{ workflow_runs: GitHubWorkflowRun[] }, GitHubWorkflowRun>(
      `/repos/${seg(owner)}/${seg(repo)}/actions/runs`,
      filters,
      (p) => p.workflow_runs ?? [],
      options,
    );
  }

  /** GET /repos/{owner}/{repo}/actions/runs/{run_id} */
  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<GitHubWorkflowRun> {
    return (
      await this.#get<GitHubWorkflowRun>(
        `/repos/${seg(owner)}/${seg(repo)}/actions/runs/${seg(runId)}`,
      )
    ).data;
  }

  /** GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number} */
  async getWorkflowRunAttempt(
    owner: string,
    repo: string,
    runId: number,
    attempt: number,
  ): Promise<GitHubWorkflowRun> {
    return (
      await this.#get<GitHubWorkflowRun>(
        `/repos/${seg(owner)}/${seg(repo)}/actions/runs/${seg(runId)}/attempts/${seg(attempt)}`,
      )
    ).data;
  }

  /** GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals (environment reviews). */
  async listWorkflowRunApprovals(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GitHubRunApproval[]> {
    return (
      (
        await this.#get<GitHubRunApproval[]>(
          `/repos/${seg(owner)}/${seg(repo)}/actions/runs/${seg(runId)}/approvals`,
        )
      ).data ?? []
    );
  }

  /** GET /repos/{owner}/{repo}/deployments/{deployment_id} */
  async getDeployment(
    owner: string,
    repo: string,
    deploymentId: number,
  ): Promise<GitHubDeployment> {
    return (
      await this.#get<GitHubDeployment>(
        `/repos/${seg(owner)}/${seg(repo)}/deployments/${seg(deploymentId)}`,
      )
    ).data;
  }

  /** GET /repos/{owner}/{repo}/deployments. Filters: `sha`, `ref`, `task`, `environment`. */
  listDeployments(
    owner: string,
    repo: string,
    filters: Record<string, string | undefined> = {},
    options?: PageOptions,
  ): Promise<GitHubDeployment[]> {
    return this.#all<GitHubDeployment[], GitHubDeployment>(
      `/repos/${seg(owner)}/${seg(repo)}/deployments`,
      filters,
      (p) => p ?? [],
      options,
    );
  }

  /**
   * GET /repos/{owner}/{repo}/attestations/{subject_digest} (AFE-21): artifact
   * attestations (Sigstore bundles) for an image digest (`sha256:<hex>`).
   * Needs `attestations: read`. One page of up to 30; GitHub answers 404 when
   * there are none. https://docs.github.com/en/rest/repos/attestations
   */
  async listAttestations(
    owner: string,
    repo: string,
    subjectDigest: string,
  ): Promise<GitHubAttestationsResponse> {
    // Validated, then sent unencoded: `sha256:<hex>` is a valid path segment.
    if (!/^sha256:[0-9a-f]{64}$/.test(subjectDigest)) {
      throw new GitHubApiError("invalid attestation subject digest", 0, null);
    }
    return (
      (
        await this.#get<GitHubAttestationsResponse>(
          `/repos/${seg(owner)}/${seg(repo)}/attestations/${subjectDigest}`,
          { per_page: 30 },
        )
      ).data ?? {}
    );
  }

  /** GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses */
  listDeploymentStatuses(
    owner: string,
    repo: string,
    deploymentId: number,
    options?: PageOptions,
  ): Promise<GitHubDeploymentStatus[]> {
    return this.#all<GitHubDeploymentStatus[], GitHubDeploymentStatus>(
      `/repos/${seg(owner)}/${seg(repo)}/deployments/${seg(deploymentId)}/statuses`,
      {},
      (p) => p ?? [],
      options,
    );
  }
}

/**
 * App Manifest flow: converts the one-time `code` into the new App's
 * credentials. Unauthenticated; the code is single-use and expires after an hour.
 * POST /app-manifests/{code}/conversions
 */
export async function convertManifestCode(
  http: GitHubHttp,
  code: string,
): Promise<GitHubManifestConversion> {
  const { data } = await http.request<GitHubManifestConversion>({
    method: "POST",
    path: `/app-manifests/${seg(code)}/conversions`,
    bucket: "manifest",
  });
  return data;
}
