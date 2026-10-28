import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  GITHUB_OPERATIONS,
  GITHUB_OPERATION_NAMES,
  type GitHubOperation,
  type GitHubOperationParams,
  type GitHubPreparedOperation,
  type GitHubOperationReceipt,
} from "@afe/core";
import {
  GitHubHttp,
  GitHubApiError,
  GitHubRateLimitError,
  parseOperation,
  isWorkflowPath,
  operationJsonSchema,
  workflowInputs,
  validateDispatch,
} from "@afe/connector-github";
import { getConnection, getCredential, getUserToolPolicy, listConnections } from "@afe/db";
import type { ServerContext } from "../context.ts";
import { requestTenant } from "../auth/index.ts";
import { toolAccounts } from "../auth/tool-accounts.ts";
import { githubUserId } from "./github-identity.ts";
import { registerGitHubDownloads } from "./github-downloads.ts";

export const githubOperationError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const fail = githubOperationError;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const repository = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/;
const segment = (v: unknown) => encodeURIComponent(String(v));
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export type RepoParams = { owner: string; repo: string };
type SourceObject = Record<string, unknown>;
export interface GitHubOperationContext {
  tid: string;
  uid: string;
  actorId: string;
  connectionId: string;
  repository: string;
  path: string;
  write: boolean;
  admin: boolean;
  grants: string[];
  token: Awaited<ReturnType<typeof getCredential>> & {};
}
type ReceiptRow = {
  request_id: string;
  actor_id: string;
  repository: string;
  connection_id: string;
  action: GitHubOperation;
  state: GitHubOperationReceipt["state"];
  input_digest: string | null;
  resource_key: string | null;
  run_id: string | null;
  run_attempt: number | null;
  result: { id?: number; sha?: string } | null;
  created_at: Date;
  upstream_status: number | null;
  lock_key: string | null;
};
const messages = {
  requested:
    "Request is recorded and may still be in flight. Refresh the source state before recovery.",
  accepted:
    "GitHub accepted the request. Refresh to observe its result; acceptance does not mean deployment completion.",
  rejected:
    "GitHub rejected this request. Check permissions and source state, then prepare a new request.",
  unknown:
    "The provider response is uncertain. Inspect the source state here before acknowledging a possible duplicate and retrying.",
  released: "The uncertainty was acknowledged. A new deliberate request may now be prepared.",
};
const receipt = (r: ReceiptRow): GitHubOperationReceipt => ({
  requestId: r.request_id,
  action: r.action,
  state: r.state,
  message: messages[r.state],
  ...(r.run_id ? { runId: Number(r.run_id), runAttempt: r.run_attempt ?? undefined } : {}),
  ...(r.result ? { result: r.result } : {}),
  createdAt: new Date(r.created_at).toISOString(),
});

export class GitHubOperations {
  readonly http = new GitHubHttp({ maxRetries: 0, maxResponseBytes: 2 * 1024 * 1024 });
  constructor(readonly ctx: ServerContext) {}
  async identity(req: FastifyRequest) {
    const tid = requestTenant(req),
      uid = await githubUserId(this.ctx, req);
    if (!uid)
      throw fail(
        403,
        "Link a personal GitHub identity with explicit Afe repository grants to operate GitHub.",
      );
    const policy = await getUserToolPolicy(this.ctx.pool, tid, uid, "github");
    if (policy.mode === "none") throw fail(403, "GitHub access is disabled for this account.");
    const account = (await toolAccounts(this.ctx, tid, uid)).find((a) => a.tool === "github");
    const token =
      account && (await getCredential(this.ctx.pool, this.ctx.keys, tid, account.credential_id));
    if (!token) throw fail(403, "Link a GitHub OAuth account or fine-grained token in Profile.");
    return { tid, uid, policy, token };
  }
  async request<T>(
    c: Pick<GitHubOperationContext, "tid" | "uid" | "token">,
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ) {
    return this.http.request<T>({
      method,
      path,
      token: c.token.secret,
      bucket: `operations:${c.tid}:${c.uid}`,
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }
  async scope(
    req: FastifyRequest,
    connectionId: unknown,
    repo: string,
  ): Promise<GitHubOperationContext> {
    if (
      typeof connectionId !== "string" ||
      !uuid.test(connectionId) ||
      !repository.test(repo) ||
      repo.split("/").some((v) => v === "." || v === "..")
    )
      throw fail(400, "Select a connection and a valid lowercase owner/repository.");
    const { tid, uid, policy, token } = await this.identity(req);
    const custom = policy.mode === "custom" || policy.mode === "source + custom";
    const read =
      policy.mode === "source" ||
      policy.mode === "source + custom" ||
      (custom &&
        policy.custom.some(
          (g) =>
            g.action === "read" &&
            [`repository:${repo}`, `connection:${connectionId}`].includes(g.resource),
        ));
    if (!read) throw fail(404, "Repository not found.");
    const connection = await getConnection(this.ctx.pool, tid, connectionId);
    if (!connection || connection.source !== "github") throw fail(404, "Repository not found.");
    if (connection.status !== "active") throw fail(409, "The GitHub connection is inactive.");
    const config = connection.config;
    let bound =
      Array.isArray(config.repositories) &&
      config.repositories.some(
        (r) =>
          r &&
          typeof r === "object" &&
          "fullName" in r &&
          String(r.fullName).toLowerCase() === repo,
      );
    if (config.repositories === "all")
      bound =
        !!config.account &&
        typeof config.account === "object" &&
        "login" in config.account &&
        String(config.account.login).toLowerCase() === repo.split("/")[0];
    // Legacy records without a selection config must already contain source evidence.
    if (config.repositories === undefined) {
      const found = await this.ctx.pool.query(
        "SELECT 1 FROM events WHERE tenant_id=$1 AND connection_id=$2 AND source='github' AND lower(target->>'repository')=$3 LIMIT 1",
        [tid, connectionId, repo],
      );
      bound = !!found.rowCount;
    }
    if (!bound) throw fail(404, "Repository is outside this connection's selection.");
    const c = {
      tid,
      uid,
      actorId: req.principal!.id,
      token,
      connectionId,
      repository: repo,
      path: `/repos/${repo.split("/").map(segment).join("/")}`,
      write: false,
      admin: false,
      grants: custom
        ? policy.custom.filter((g) => g.resource === `repository:${repo}`).map((g) => g.action)
        : [],
    };
    const upstream = (
      await this.request<{ permissions?: { push?: boolean; maintain?: boolean; admin?: boolean } }>(
        c,
        c.path,
      )
    ).data;
    c.admin = upstream.permissions?.admin === true;
    c.write =
      c.admin || upstream.permissions?.push === true || upstream.permissions?.maintain === true;
    return c;
  }
  require(c: GitHubOperationContext, action: GitHubOperation) {
    const d = GITHUB_OPERATIONS.find((o) => o[0] === action)!;
    if (
      !c.grants.includes(action) ||
      (d[4] === "write" && !c.write) ||
      (d[4] === "admin" && !c.admin)
    )
      throw fail(
        403,
        `Requires the exact ${action} Afe repository grant and current GitHub ${d[4]} permission. GitHub token scopes and reviewer rules also apply.`,
      );
  }
  async run(c: GitHubOperationContext, id: unknown, attempt?: unknown) {
    const r = (await this.request<SourceObject>(c, `${c.path}/actions/runs/${segment(id)}`)).data;
    const repo = r.repository as { full_name?: string } | undefined;
    if (
      r.id !== id ||
      repo?.full_name?.toLowerCase() !== c.repository ||
      !Number.isSafeInteger(r.run_attempt)
    )
      throw fail(502, "GitHub returned an invalid run identity.");
    if (attempt !== undefined && r.run_attempt !== attempt)
      throw fail(409, "The run attempt changed. Refresh before continuing.");
    return r;
  }
  async workflowFile(c: GitHubOperationContext, path: string, ref: string, missing = false) {
    if (!isWorkflowPath(path))
      throw fail(
        400,
        "Only a workflow YAML file immediately inside .github/workflows is supported.",
      );
    try {
      const file = (
        await this.request<{
          sha: string;
          content: string;
          encoding: string;
          size: number;
          type: string;
        }>(c, `${c.path}/contents/${path.split("/").map(segment).join("/")}`, "GET", undefined, {
          ref,
        })
      ).data;
      if (
        file.type !== "file" ||
        file.encoding !== "base64" ||
        file.size > 128 * 1024 ||
        typeof file.content !== "string"
      )
        throw fail(422, "Workflow exceeds the supported 128 KiB size or is not a file.");
      const content = Buffer.from(file.content, "base64").toString("utf8");
      return { path, sha: file.sha, content, ...workflowInputs(content) };
    } catch (e) {
      if (missing && e instanceof GitHubApiError && e.status === 404) return null;
      throw e;
    }
  }
  async prepare(c: GitHubOperationContext, action: GitHubOperation, params: GitHubOperationParams) {
    this.require(c, action);
    const p = parseOperation(action, params);
    let source: unknown = null;
    let method: "POST" | "PUT" | "DELETE" = "POST";
    let path = "";
    let body: unknown;
    let resourceKey = "";
    let lockKey: string | null = null;
    let runId: number | undefined, runAttempt: number | undefined, jobId: number | undefined;
    const one = async (suffix: string) =>
      (await this.request<SourceObject>(c, c.path + suffix)).data;
    if ("runId" in p) {
      runId = p.runId as number;
      runAttempt = p.attempt as number;
      const r = await this.run(c, runId, runAttempt);
      source = {
        id: r.id,
        attempt: r.run_attempt,
        status: r.status,
        conclusion: r.conclusion,
        updatedAt: r.updated_at,
      };
      const base = `${c.path}/actions/runs/${runId}`;
      resourceKey = `run:${runId}`;
      if (["github.cancel", "github.force_cancel"].includes(action)) {
        if (r.status === "completed") throw fail(409, "A completed run cannot be cancelled.");
        path = `${base}/${action === "github.cancel" ? "cancel" : "force-cancel"}`;
      } else if (["github.rerun", "github.rerun_failed", "github.rerun_job"].includes(action)) {
        if (r.status !== "completed")
          throw fail(409, "Wait for the current attempt to complete before re-running.");
        if (
          action === "github.rerun_failed" &&
          !["failure", "timed_out", "cancelled"].includes(String(r.conclusion))
        )
          throw fail(409, "This attempt has no failed or cancelled jobs to re-run.");
        if (action === "github.rerun_job") {
          jobId = p.jobId as number;
          const job = await one(`/actions/jobs/${jobId}`);
          if (job.run_id !== runId || job.run_attempt !== runAttempt)
            throw fail(409, "The job belongs to a different run or attempt.");
          if (job.status !== "completed") throw fail(409, "Only a completed job can be re-run.");
          source = {
            run: source,
            job: { id: job.id, status: job.status, conclusion: job.conclusion },
          };
          path = `${c.path}/actions/jobs/${jobId}/rerun`;
        } else path = `${base}/${action === "github.rerun" ? "rerun" : "rerun-failed-jobs"}`;
        body = { enable_debug_logging: p.enableDebugLogging };
      } else if (action === "github.approve_run") {
        if (
          (r.event !== "pull_request" && r.event !== "pull_request_target") ||
          (r.conclusion !== "action_required" &&
            !["waiting", "requested", "pending"].includes(String(r.status)))
        )
          throw fail(409, "This run is not awaiting fork workflow approval.");
        path = `${base}/approve`;
      } else if (action === "github.review_deployment") {
        const pending = (
          await this.request<
            Array<{ environment: { id: number }; current_user_can_approve: boolean }>
          >(c, `${base}/pending_deployments`)
        ).data;
        if (
          (p.environmentIds as number[]).some(
            (id) =>
              !pending.some((e) => e.environment.id === id && e.current_user_can_approve === true),
          )
        )
          throw fail(
            403,
            "GitHub does not allow this identity to review all selected pending environments. Self-review and required-reviewer restrictions are preserved.",
          );
        source = { run: source, pending };
        path = `${base}/pending_deployments`;
        body = { environment_ids: p.environmentIds, state: p.state, comment: p.comment };
      } else if (["github.delete_run", "github.delete_logs"].includes(action)) {
        if (r.status !== "completed")
          throw fail(409, "Complete or cancel the run before deletion.");
        method = "DELETE";
        path = action === "github.delete_run" ? base : `${base}/logs`;
      } else throw fail(400, "Use the download endpoint for archived logs.");
      lockKey = `run:${c.repository}:${runId}:${runAttempt}:${["github.rerun", "github.rerun_failed", "github.rerun_job"].includes(action) ? "rerun" : action === "github.cancel" ? "cancel" : action + ":" + digest(body ?? null)}`;
    } else if (["github.dispatch", "github.enable", "github.disable"].includes(action)) {
      const w = await one(`/actions/workflows/${p.workflowId}`);
      source = w;
      resourceKey = `workflow:${p.workflowId}`;
      if (action === "github.dispatch") {
        if (w.state !== "active") throw fail(409, "Enable the workflow before dispatching.");
        const file = await this.workflowFile(c, String(w.path), String(p.ref));
        if (!file?.dispatchable)
          throw fail(409, "The selected ref does not declare workflow_dispatch.");
        const inputs = validateDispatch(file.inputs, p.inputs as Record<string, unknown>);
        for (const input of file.inputs.filter((i) => i.type === "environment"))
          if (inputs[input.name]) await one(`/environments/${segment(inputs[input.name])}`);
        const commit = await one(`/commits/${segment(p.ref)}`);
        source = { workflow: w, fileSha: file.sha, commit: commit.sha };
        body = { ref: p.ref, inputs };
        path = `${c.path}/actions/workflows/${p.workflowId}/dispatches`;
      } else {
        if (
          (action === "github.enable" && w.state === "active") ||
          (action === "github.disable" && w.state !== "active")
        )
          throw fail(409, "The workflow is already in the requested state.");
        method = "PUT";
        path = `${c.path}/actions/workflows/${p.workflowId}/${action === "github.enable" ? "enable" : "disable"}`;
      }
    } else if (["github.workflow_save", "github.workflow_delete"].includes(action)) {
      const file = await this.workflowFile(c, String(p.path), String(p.branch), true);
      if ((file?.sha ?? undefined) !== p.sha)
        throw fail(409, "The workflow file changed. Reload its SHA before saving or deleting.");
      if (action === "github.workflow_save") {
        if (Buffer.byteLength(String(p.content), "utf8") > 128 * 1024)
          throw fail(413, "Workflow YAML exceeds the 128 KiB limit.");
        workflowInputs(String(p.content));
      } else if (!file) throw fail(404, "Workflow file not found.");
      source = { sha: file?.sha ?? null, path: p.path, branch: p.branch };
      resourceKey = `workflow-file:${p.branch}:${p.path}`;
      path = `${c.path}/contents/${String(p.path).split("/").map(segment).join("/")}`;
      method = action === "github.workflow_save" ? "PUT" : "DELETE";
      body = {
        branch: p.branch,
        message: p.message,
        ...(p.sha ? { sha: p.sha } : {}),
        ...(action === "github.workflow_save"
          ? { content: Buffer.from(String(p.content)).toString("base64") }
          : {}),
      };
    } else if (action === "github.deployment_create") {
      const commit = await one(`/commits/${segment(p.ref)}`);
      source = { sha: commit.sha };
      resourceKey = `deployment-ref:${p.ref}:${p.environment}`;
      path = `${c.path}/deployments`;
      body = {
        ref: p.ref,
        environment: p.environment,
        task: p.task,
        description: p.description,
        auto_merge: p.autoMerge,
        transient_environment: p.transientEnvironment,
        ...(p.requiredContexts !== undefined ? { required_contexts: p.requiredContexts } : {}),
        ...(p.productionEnvironment !== undefined
          ? { production_environment: p.productionEnvironment }
          : {}),
        ...(p.payload !== undefined ? { payload: p.payload } : {}),
      };
    } else if (["github.deployment_status", "github.deployment_delete"].includes(action)) {
      const d = await one(`/deployments/${p.deploymentId}`);
      const statuses = (
        await this.request<SourceObject[]>(
          c,
          `${c.path}/deployments/${p.deploymentId}/statuses`,
          "GET",
          undefined,
          { per_page: 1 },
        )
      ).data;
      source = { id: d.id, sha: d.sha, status: statuses[0] ?? null };
      resourceKey = `deployment:${p.deploymentId}`;
      if (action === "github.deployment_delete") {
        if (statuses.length && statuses[0]!.state !== "inactive")
          throw fail(409, "Mark the deployment inactive before deleting it.");
        path = `${c.path}/deployments/${p.deploymentId}`;
        method = "DELETE";
      } else {
        path = `${c.path}/deployments/${p.deploymentId}/statuses`;
        body = {
          state: p.state,
          description: p.description,
          auto_inactive: p.autoInactive,
          ...(p.environment ? { environment: p.environment } : {}),
          ...(p.environmentUrl !== undefined ? { environment_url: p.environmentUrl } : {}),
          ...(p.logUrl !== undefined ? { log_url: p.logUrl } : {}),
        };
      }
    } else if (action === "github.artifact_delete") {
      const a = await one(`/actions/artifacts/${p.artifactId}`);
      source = { id: a.id, createdAt: a.created_at, expired: a.expired };
      resourceKey = `artifact:${p.artifactId}`;
      path = `${c.path}/actions/artifacts/${p.artifactId}`;
      method = "DELETE";
    } else if (
      [
        "github.environment_save",
        "github.environment_delete",
        "github.branch_policy_save",
        "github.branch_policy_delete",
      ].includes(action)
    ) {
      const ep = `${c.path}/environments/${segment(p.environment)}`;
      let e: SourceObject | null = null;
      try {
        e = (await this.request<SourceObject>(c, ep)).data;
      } catch (err) {
        if (!(
          action === "github.environment_save" &&
          err instanceof GitHubApiError &&
          err.status === 404
        ))
          throw err;
      }
      source = e;
      resourceKey = `environment:${p.environment}`;
      if (action === "github.environment_save") {
        path = ep;
        method = "PUT";
        body = {
          wait_timer: p.waitTimer,
          prevent_self_review: p.preventSelfReview,
          reviewers: p.reviewers,
          deployment_branch_policy: p.branchPolicy,
        };
      } else if (action === "github.environment_delete") {
        path = ep;
        method = "DELETE";
      } else {
        const policy = e?.deployment_branch_policy as
          { custom_branch_policies?: boolean } | undefined;
        if (!policy?.custom_branch_policies)
          throw fail(409, "Enable custom deployment branch policies on this environment first.");
        const policies =
          p.policyId !== undefined
            ? [
                (
                  await this.request<SourceObject>(
                    c,
                    `${ep}/deployment-branch-policies/${p.policyId}`,
                  )
                ).data,
              ]
            : [];
        source = { environment: e, policies };
        if (action === "github.branch_policy_delete") {
          if (!policies.some((x) => x.id === p.policyId))
            throw fail(404, "Deployment branch policy not found.");
          path = `${ep}/deployment-branch-policies/${p.policyId}`;
          method = "DELETE";
        } else {
          path = `${ep}/deployment-branch-policies`;
          if (p.policyId !== undefined) {
            if (!policies.some((x) => x.id === p.policyId))
              throw fail(404, "Deployment branch policy not found.");
            path += `/${p.policyId}`;
            method = "PUT";
            if (policies[0]!.type !== p.type)
              throw fail(
                409,
                "GitHub branch policy types are immutable. Delete and create a new policy to change its type.",
              );
          }
          body = p.policyId !== undefined ? { name: p.name } : { name: p.name, type: p.type };
        }
      }
    } else if (
      action === "github.protection_rule_enable" ||
      action === "github.protection_rule_delete"
    ) {
      const ep = `${c.path}/environments/${segment(p.environment)}/deployment_protection_rules`;
      const rules = (
        await this.request<{ custom_deployment_protection_rules: SourceObject[] }>(c, ep)
      ).data.custom_deployment_protection_rules;
      source = rules;
      resourceKey = `environment-rules:${p.environment}`;
      if (action === "github.protection_rule_enable") {
        const available = (
          await this.request<{
            available_custom_deployment_protection_rule_integrations: SourceObject[];
          }>(c, ep + "/apps")
        ).data.available_custom_deployment_protection_rule_integrations;
        if (!available.some((a) => a.id === p.appId))
          throw fail(404, "This GitHub App is not available as a deployment rule integration.");
        if (rules.some((r) => (r.app as SourceObject)?.id === p.appId))
          throw fail(409, "This protection rule is already enabled.");
        path = ep;
        body = { integration_id: p.appId };
      } else {
        if (!rules.some((r) => r.id === p.ruleId)) throw fail(404, "Protection rule not found.");
        path = `${ep}/${p.ruleId}`;
        method = "DELETE";
      }
    } else if (action === "github.cache_delete") {
      let cache: SourceObject | undefined;
      for (let page = 1; page <= 10; page++) {
        const response = await this.request<{ actions_caches: SourceObject[] }>(
          c,
          `${c.path}/actions/caches`,
          "GET",
          undefined,
          {
            per_page: 100,
            page,
            ...(p.key ? { key: String(p.key) } : {}),
            ...(p.ref ? { ref: String(p.ref) } : {}),
          },
        );
        cache = response.data.actions_caches.find((x) => x.id === p.cacheId);
        if (cache || !response.headers.get("link")?.includes('rel="next"')) break;
      }
      if (!cache)
        throw fail(
          404,
          "Cache not found in the bounded lookup. Select its key and ref from the cache list.",
        );
      source = { id: cache.id, key: cache.key, ref: cache.ref, createdAt: cache.created_at };
      resourceKey = `cache:${p.cacheId}`;
      path = `${c.path}/actions/caches/${p.cacheId}`;
      method = "DELETE";
    } else throw fail(400, "Use the download endpoint for artifact archives.");
    const version = digest({
      connectionId: c.connectionId,
      repository: c.repository,
      action,
      p,
      source,
    });
    const repeatable = [
      "github.dispatch",
      "github.deployment_create",
      "github.deployment_status",
      "github.branch_policy_save",
    ].includes(action);
    lockKey ??= `operation:${c.repository}:${action}:${resourceKey}:${version}`;
    const detail =
      action === "github.review_deployment"
        ? ` · ${p.state} environments ${(p.environmentIds as number[]).join(", ")}`
        : action === "github.dispatch"
          ? ` · ref ${p.ref}`
          : action === "github.deployment_create"
            ? ` · ${p.environment} from ${p.ref}`
            : action === "github.deployment_status"
              ? ` · state ${p.state}`
              : "";
    const preview: GitHubPreparedOperation = {
      action,
      version,
      summary: `${GITHUB_OPERATIONS.find((o) => o[0] === action)![1]} · ${c.repository} · ${resourceKey}${runAttempt ? ` · attempt ${runAttempt}` : ""}${detail}`,
      context: {
        connectionId: c.connectionId,
        repository: c.repository,
        ...(runId ? { runId, runAttempt } : {}),
        ...(jobId ? { jobId } : {}),
      },
    };
    return { preview, p, path, method, body, resourceKey, lockKey, repeatable };
  }
  async execute(
    c: GitHubOperationContext,
    action: GitHubOperation,
    params: GitHubOperationParams,
    requestId: string,
    expectedVersion: string,
  ) {
    this.require(c, action);
    const p = parseOperation(action, params),
      inputDigest = digest({ connectionId: c.connectionId, repository: c.repository, action, p });
    const previous = (
      await this.ctx.pool.query<ReceiptRow>(
        "SELECT * FROM github_action_requests WHERE tenant_id=$1 AND request_id=$2",
        [c.tid, requestId],
      )
    ).rows[0];
    if (previous) {
      if (previous.actor_id !== c.actorId || previous.input_digest !== inputDigest)
        throw fail(409, "Request ID belongs to a different intent.");
      return receipt(previous);
    }
    const prepared = await this.prepare(c, action, p);
    if (prepared.preview.version !== expectedVersion)
      throw fail(409, "Source state changed after confirmation. Prepare and confirm again.");
    const inserted = await this.ctx.pool.query<ReceiptRow>(
      `INSERT INTO github_action_requests (tenant_id,request_id,actor_id,connection_id,repository,run_id,run_attempt,action,input_digest,resource_key,lock_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`,
      [
        c.tid,
        requestId,
        c.actorId,
        c.connectionId,
        c.repository,
        prepared.preview.context.runId ?? null,
        prepared.preview.context.runAttempt ?? null,
        action,
        inputDigest,
        prepared.resourceKey,
        prepared.lockKey,
      ],
    );
    if (!inserted.rowCount)
      throw fail(
        409,
        "A matching operation is recorded. Inspect request history and source state before retrying.",
      );
    let state: GitHubOperationReceipt["state"] = "unknown",
      status: number | null = null,
      result: { id?: number; sha?: string } | null = null;
    try {
      const response = await this.request<SourceObject | null>(
        c,
        prepared.path,
        prepared.method,
        prepared.body,
      );
      status = response.status;
      // Deployment creation can return 202 after merging the branch without creating a deployment.
      state = action === "github.deployment_create" && status === 202 ? "unknown" : "accepted";
      if (response.data) {
        result = {
          ...(typeof response.data.id === "number" ? { id: response.data.id } : {}),
          ...(typeof response.data.sha === "string" ? { sha: response.data.sha } : {}),
        };
      }
    } catch (e) {
      status = e instanceof GitHubApiError ? e.status : null;
      state = status !== null && status >= 400 && status < 500 ? "rejected" : "unknown";
    }
    const updated = (
      await this.ctx.pool.query<ReceiptRow>(
        "UPDATE github_action_requests SET state=$3,upstream_status=$4,result=$5,lock_key=CASE WHEN $6 AND $3='accepted' THEN NULL ELSE lock_key END WHERE tenant_id=$1 AND request_id=$2 RETURNING *",
        [c.tid, requestId, state, status, result, prepared.repeatable],
      )
    ).rows[0]!;
    this.ctx.log.info(
      { tenantId: c.tid, actorId: c.actorId, requestId, action, repository: c.repository, state },
      "GitHub operation receipt",
    );
    return receipt(updated);
  }
  async guarded<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GitHubRateLimitError)
        throw fail(429, `GitHub rate limit reached. Retry after ${e.retryAfter.toISOString()}.`);
      if (e instanceof GitHubApiError)
        throw fail(
          e.status === 404 ? 404 : e.status === 401 || e.status === 403 ? 403 : 502,
          "GitHub denied or could not complete this request. Check token permissions, source state and organization restrictions.",
        );
      if (e instanceof Error && "statusCode" in e) throw e;
      throw fail(502, "The GitHub request failed. No mutation is retried automatically.");
    }
  }
}

/** Return only operational metadata. Deployment payloads and provider internals stay server-side. */
function summary(item: SourceObject) {
  const fields = [
    "id",
    "type",
    "name",
    "path",
    "state",
    "status",
    "conclusion",
    "run_attempt",
    "run_id",
    "workflow_id",
    "head_branch",
    "head_sha",
    "event",
    "created_at",
    "updated_at",
    "started_at",
    "completed_at",
    "environment",
    "ref",
    "sha",
    "task",
    "description",
    "expired",
    "size_in_bytes",
    "key",
    "last_accessed_at",
    "wait_timer",
    "wait_timer_started_at",
    "current_user_can_approve",
  ];
  const result: SourceObject = Object.fromEntries(
    fields.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]),
  );
  if (typeof item.html_url === "string" && item.html_url.startsWith("https://github.com/"))
    result.html_url = item.html_url;
  if (Array.isArray(item.steps))
    result.steps = item.steps.map((x) => {
      const s = x as SourceObject;
      return {
        number: s.number,
        name: s.name,
        status: s.status,
        conclusion: s.conclusion,
        started_at: s.started_at,
        completed_at: s.completed_at,
      };
    });
  if (item.environment && typeof item.environment === "object")
    result.environment = {
      id: (item.environment as SourceObject).id,
      name: (item.environment as SourceObject).name,
    };
  if (Array.isArray(item.reviewers)) result.reviewers = item.reviewers;
  if (item.protection_rules) result.protection_rules = item.protection_rules;
  if (item.deployment_branch_policy)
    result.deployment_branch_policy = item.deployment_branch_policy;
  if (item.workflow_run && typeof item.workflow_run === "object")
    result.run_id = (item.workflow_run as SourceObject).id;
  return result;
}
export function registerGitHubOperations(app: FastifyInstance, ctx: ServerContext) {
  const service = new GitHubOperations(ctx);
  const root = "/api/actions/github/repositories/:owner/:repo";
  const scope = (req: FastifyRequest<{ Params: RepoParams }>, connectionId: unknown) =>
    service.scope(req, connectionId, `${req.params.owner}/${req.params.repo}`.toLowerCase());
  app.get<{ Querystring: { page?: string } }>(
    "/api/actions/github/resources",
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return service.guarded(async () => {
        const identity = await service.identity(req);
        const page = Number(req.query.page ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
          throw fail(400, "Invalid page.");
        const connections = (
          await listConnections(ctx.pool, identity.tid, { source: "github", statuses: ["active"] })
        ).filter((c) => c.source === "github");
        const repos = await service.request<Array<{ full_name: string }>>(
          identity,
          "/user/repos",
          "GET",
          undefined,
          { page, per_page: 30, sort: "full_name" },
        );
        const items = [];
        for (const repo of repos.data) {
          const name = repo.full_name?.toLowerCase();
          if (!name || !repository.test(name)) continue;
          for (const connection of connections) {
            const custom =
              identity.policy.mode === "custom" || identity.policy.mode === "source + custom";
            if (
              custom &&
              identity.policy.mode === "custom" &&
              !identity.policy.custom.some(
                (g) =>
                  g.action === "read" &&
                  [`repository:${name}`, `connection:${connection.id}`].includes(g.resource),
              )
            )
              continue;
            const conf = connection.config;
            let bound =
              Array.isArray(conf.repositories) &&
              conf.repositories.some(
                (x) =>
                  x &&
                  typeof x === "object" &&
                  "fullName" in x &&
                  String(x.fullName).toLowerCase() === name,
              );
            if (conf.repositories === "all")
              bound =
                !!conf.account &&
                typeof conf.account === "object" &&
                "login" in conf.account &&
                String(conf.account.login).toLowerCase() === name.split("/")[0];
            if (conf.repositories === undefined)
              bound = !!(
                await ctx.pool.query(
                  "SELECT 1 FROM events WHERE tenant_id=$1 AND connection_id=$2 AND lower(target->>'repository')=$3 LIMIT 1",
                  [identity.tid, connection.id, name],
                )
              ).rowCount;
            if (bound)
              items.push({
                connectionId: connection.id,
                connectionName: connection.name,
                repository: name,
              });
          }
        }
        return { items, page, hasMore: repos.headers.get("link")?.includes('rel="next"') ?? false };
      });
    },
  );
  app.get<{ Params: RepoParams; Querystring: Record<string, string> }>(root, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return service.guarded(async () => {
      const c = await scope(req, req.query.connectionId);
      const q = req.query,
        view = q.view ?? "workflows";
      const page = Number(q.page ?? 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw fail(400, "Invalid page.");
      if (view === "capabilities") {
        const stateReasons: Partial<Record<GitHubOperation, string>> = {};
        if (q.runId) {
          const runId = Number(q.runId);
          if (!Number.isSafeInteger(runId) || runId < 1) throw fail(400, "Invalid run ID.");
          const run = await service.run(c, runId);
          if (run.status !== "completed")
            for (const action of [
              "github.rerun",
              "github.rerun_failed",
              "github.rerun_job",
              "github.delete_run",
              "github.delete_logs",
              "github.logs_download",
            ] as GitHubOperation[])
              stateReasons[action] = "Available after this attempt completes.";
          else
            for (const action of ["github.cancel", "github.force_cancel"] as GitHubOperation[])
              stateReasons[action] = "The run is already completed.";
          if (!["failure", "timed_out", "cancelled"].includes(String(run.conclusion)))
            stateReasons["github.rerun_failed"] =
              "No failed or cancelled jobs are recorded for this attempt.";
          if (
            (run.event !== "pull_request" && run.event !== "pull_request_target") ||
            (run.conclusion !== "action_required" &&
              !["waiting", "requested", "pending"].includes(String(run.status)))
          )
            stateReasons["github.approve_run"] = "This run is not awaiting fork approval.";
        }
        if (q.runId && q.attempt) {
          const selected = Number(q.attempt),
            run = await service.run(c, Number(q.runId));
          if (!Number.isSafeInteger(selected) || selected < 1 || selected > Number(run.run_attempt))
            throw fail(400, "Select an existing run attempt.");
          if (selected < Number(run.run_attempt)) delete stateReasons["github.logs_download"];
        }
        if (q.workflowId) {
          const id = Number(q.workflowId);
          if (!Number.isSafeInteger(id) || id < 1) throw fail(400, "Invalid workflow ID.");
          const workflow = (
            await service.request<SourceObject>(c, `${c.path}/actions/workflows/${id}`)
          ).data;
          if (workflow.state === "active")
            stateReasons["github.enable"] = "The workflow is already enabled.";
          else {
            stateReasons["github.disable"] = "The workflow is already disabled.";
            stateReasons["github.dispatch"] = "Enable this workflow before dispatching.";
          }
        }
        return {
          items: GITHUB_OPERATIONS.map(([action, label, group, destructive, level]) => {
            const reason = !c.grants.includes(action)
              ? `Requires ${action} on repository:${c.repository}.`
              : level === "admin" && !c.admin
                ? "GitHub repository admin permission is required."
                : level === "write" && !c.write
                  ? "GitHub repository write permission is required."
                  : (stateReasons[action] ?? null);
            return {
              action,
              label,
              group,
              destructive,
              enabled: reason === null,
              reason,
              paramsSchema: operationJsonSchema(action),
              method: level === "read" ? "GET" : "POST",
            };
          }),
        };
      }
      if (view === "history") {
        const rows = await ctx.pool.query<ReceiptRow>(
          "SELECT * FROM github_action_requests WHERE tenant_id=$1 AND repository=$2 AND actor_id=$3 ORDER BY created_at DESC LIMIT 30 OFFSET $4",
          [c.tid, c.repository, c.actorId, (page - 1) * 30],
        );
        return { items: rows.rows.map(receipt), page, hasMore: rows.rowCount === 30 };
      }
      if (view === "protection_rules" || view === "protection_apps") {
        if (!q.name || q.name.length > 255 || q.name === "." || q.name === "..")
          throw fail(400, "Select an environment.");
        const suffix = view === "protection_apps" ? "/apps" : "";
        const response = await service.request<SourceObject>(
          c,
          `${c.path}/environments/${segment(q.name)}/deployment_protection_rules${suffix}`,
          "GET",
          undefined,
          { per_page: 30, page },
        );
        const data =
          response.data[
            view === "protection_apps"
              ? "available_custom_deployment_protection_rule_integrations"
              : "custom_deployment_protection_rules"
          ];
        if (!Array.isArray(data)) throw fail(502, "GitHub returned invalid protection rules.");
        return {
          items: data.map((x: SourceObject) => ({
            id: x.id,
            name:
              typeof x.name === "string"
                ? x.name
                : ((x.app as SourceObject)?.slug ?? x.slug ?? String(x.id)),
          })),
          page,
          hasMore: response.headers.get("link")?.includes('rel="next"') ?? false,
        };
      }
      if (view === "reviewers") {
        if (!c.admin)
          throw fail(
            403,
            "Repository admin permission is required to browse environment reviewers.",
          );
        const [users, teams] = await Promise.all([
          service.request<Array<{ id: number; login: string }>>(
            c,
            `${c.path}/collaborators`,
            "GET",
            undefined,
            { page, per_page: 30 },
          ),
          service.request<Array<{ id: number; name: string }>>(
            c,
            `${c.path}/teams`,
            "GET",
            undefined,
            { page, per_page: 30 },
          ),
        ]);
        return {
          items: [
            ...users.data.map((u) => ({ id: u.id, name: u.login, type: "User" })),
            ...teams.data.map((t) => ({ id: t.id, name: t.name, type: "Team" })),
          ],
          page,
          hasMore: [users, teams].some((r) => r.headers.get("link")?.includes('rel="next"')),
        };
      }
      if (view === "workflow_file") {
        if (
          !["github.dispatch", "github.workflow_save", "github.workflow_delete"].some((a) =>
            c.grants.includes(a),
          )
        )
          throw fail(403, "Workflow source requires a dispatch or workflow configuration grant.");
        if (!q.ref || q.ref.length > 255) throw fail(400, "Select a workflow ref.");
        const wid = Number(q.id);
        if (!Number.isSafeInteger(wid) || wid < 1) throw fail(400, "Select a workflow.");
        const w = (await service.request<SourceObject>(c, `${c.path}/actions/workflows/${wid}`))
          .data;
        const file = await service.workflowFile(c, String(w.path), q.ref);
        // Dispatch-only users receive the input schema, not workflow source.
        return {
          path: file!.path,
          sha: file!.sha,
          dispatchable: file!.dispatchable,
          inputs: file!.inputs,
          ...(c.grants.some((a) => ["github.workflow_save", "github.workflow_delete"].includes(a))
            ? { content: file!.content }
            : {}),
        };
      }
      let path = "",
        key: string | null = null;
      const params: Record<string, string | number | boolean | undefined> = { page, per_page: 30 };
      const numeric = (value: unknown) => {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 1) throw fail(400, "Select a valid source ID.");
        return n;
      };
      if (view === "workflows") {
        path = "/actions/workflows";
        key = "workflows";
      } else if (view === "runs") {
        path = q.workflowId ? `/actions/workflows/${numeric(q.workflowId)}/runs` : "/actions/runs";
        key = "workflow_runs";
        if (q.branch) params.branch = q.branch;
      } else if (view === "jobs") {
        const run = await service.run(c, numeric(q.runId));
        const attempt = q.attempt ? numeric(q.attempt) : Number(run.run_attempt);
        path = `/actions/runs/${numeric(q.runId)}/attempts/${attempt}/jobs`;
        key = "jobs";
      } else if (view === "run") {
        return { item: summary(await service.run(c, numeric(q.id))) };
      } else if (view === "artifacts") {
        path = q.runId ? `/actions/runs/${numeric(q.runId)}/artifacts` : "/actions/artifacts";
        key = "artifacts";
      } else if (view === "deployments") {
        path = "/deployments";
      } else if (view === "statuses") {
        path = `/deployments/${numeric(q.id)}/statuses`;
      } else if (view === "pending") {
        await service.run(c, numeric(q.runId));
        path = `/actions/runs/${numeric(q.runId)}/pending_deployments`;
      } else if (view === "environments") {
        path = "/environments";
        key = "environments";
      } else if (view === "environment") {
        if (!q.name || q.name.length > 255 || q.name === "." || q.name === "..")
          throw fail(400, "Select an environment.");
        return {
          item: summary(
            (await service.request<SourceObject>(c, `${c.path}/environments/${segment(q.name)}`))
              .data,
          ),
        };
      } else if (view === "branch_policies") {
        if (!q.name || q.name.length > 255 || q.name === "." || q.name === "..")
          throw fail(400, "Select an environment.");
        path = `/environments/${segment(q.name)}/deployment-branch-policies`;
        key = "branch_policies";
      } else if (view === "caches") {
        path = "/actions/caches";
        key = "actions_caches";
      } else if (view === "branches") {
        path = "/branches";
      } else if (view === "tags") {
        path = "/tags";
      } else throw fail(400, "Unknown GitHub operation view.");
      const response = await service.request<SourceObject | SourceObject[]>(
        c,
        c.path + path,
        "GET",
        undefined,
        params,
      );
      const data = key ? (response.data as SourceObject)[key] : response.data;
      if (!Array.isArray(data)) throw fail(502, "GitHub returned an invalid list.");
      return {
        items: data.map((x) => summary(x as SourceObject)),
        page,
        hasMore: response.headers.get("link")?.includes('rel="next"') ?? false,
      };
    });
  });
  type Body = {
    connectionId?: unknown;
    action?: unknown;
    params?: unknown;
    requestId?: unknown;
    expectedVersion?: unknown;
    confirmed?: unknown;
  };
  const validateAction = (value: unknown): GitHubOperation => {
    if (!GITHUB_OPERATION_NAMES.includes(value as GitHubOperation))
      throw fail(400, "Unknown GitHub operation.");
    return value as GitHubOperation;
  };
  app.post<{ Params: RepoParams; Body: Body }>(
    root + "/prepare",
    { config: { access: "viewer" }, bodyLimit: 256 * 1024 },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return service.guarded(async () => {
        const action = validateAction(req.body?.action);
        const c = await scope(req, req.body.connectionId);
        return (await service.prepare(c, action, req.body.params as GitHubOperationParams)).preview;
      });
    },
  );
  app.post<{ Params: RepoParams; Body: Body }>(
    root,
    { config: { access: "viewer" }, bodyLimit: 256 * 1024 },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return service.guarded(async () => {
        const b = req.body;
        if (
          !b ||
          b.confirmed !== true ||
          typeof b.requestId !== "string" ||
          !uuid.test(b.requestId) ||
          typeof b.expectedVersion !== "string" ||
          !/^[a-f0-9]{64}$/.test(b.expectedVersion)
        )
          throw fail(
            400,
            "Provide confirmed intent, UUID requestId and expectedVersion from prepare.",
          );
        const action = validateAction(b.action),
          c = await scope(req, b.connectionId);
        const result = await service.execute(
          c,
          action,
          b.params as GitHubOperationParams,
          b.requestId,
          b.expectedVersion,
        );
        return reply
          .code(
            result.state === "accepted"
              ? 202
              : result.state === "rejected"
                ? 409
                : result.state === "unknown"
                  ? 502
                  : 200,
          )
          .send(result);
      });
    },
  );
  app.post<{
    Params: RepoParams & { requestId: string };
    Body: { connectionId?: unknown; confirmed?: unknown; acknowledgeDuplicateRisk?: unknown };
  }>(
    root + "/requests/:requestId/release",
    { config: { access: "viewer" } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return service.guarded(async () => {
        if (
          !uuid.test(req.params.requestId) ||
          req.body?.confirmed !== true ||
          req.body.acknowledgeDuplicateRisk !== true
        )
          throw fail(400, "Explicitly confirm recovery and acknowledge duplicate risk.");
        const c = await scope(req, req.body.connectionId);
        const r = (
          await ctx.pool.query<ReceiptRow>(
            "SELECT * FROM github_action_requests WHERE tenant_id=$1 AND request_id=$2 AND actor_id=$3 AND repository=$4",
            [c.tid, req.params.requestId, c.actorId, c.repository],
          )
        ).rows[0];
        if (!r) throw fail(404, "Request not found.");
        service.require(c, r.action);
        if (r.state !== "unknown" && r.state !== "requested")
          throw fail(409, "Only uncertain requests need manual recovery.");
        if (r.state === "requested" && new Date(r.created_at).getTime() > Date.now() - 120000)
          throw fail(
            409,
            "The operation may still be in flight. Wait two minutes before recovery.",
          );
        // Verify current source access immediately before explicit user-directed recovery.
        if (r.run_id) await service.run(c, Number(r.run_id));
        const updated = (
          await ctx.pool.query<ReceiptRow>(
            "UPDATE github_action_requests SET state='released',released_at=now() WHERE tenant_id=$1 AND request_id=$2 AND state=$3 RETURNING *",
            [c.tid, r.request_id, r.state],
          )
        ).rows[0];
        if (!updated) throw fail(409, "Receipt changed; refresh history.");
        return receipt(updated);
      });
    },
  );
  registerGitHubDownloads(app, service);
}
