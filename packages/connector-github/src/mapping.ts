/**
 * Maps GitHub objects (webhook payloads and the matching REST objects) into
 * canonical events (AFE-7). Pure: no I/O. The per-object builders
 * (`workflowRunEvent`, `deploymentEvent`, ...) take the same objects the REST
 * API returns, so reconciliation polling (AFE-8) produces identical events
 * and idempotency keys (see event-ids.ts). `mapWebhookDelivery` dispatches a
 * webhook delivery to them.
 *
 * Reference: docs/connectors/github.md "Event capture".
 */
import {
  ACTIONS,
  repositoryKey,
  type ActorRef,
  type CanonicalEventInputLike,
  type Correlation as CorrelationKeys,
  type JsonObject,
  type JsonValue,
  type ObservationMethod,
  type Outcome,
  type RawPayloadInput,
  type TriggerType,
} from "@afe/core";
import {
  deploymentEventId,
  deploymentProtectionRuleEventId,
  deploymentReviewEventId,
  deploymentReviewRequestedEventId,
  deploymentStatusEventId,
  pullRequestEventId,
  pushEventId,
  repositoryDispatchEventId,
  workflowJobEventId,
  workflowRunEventId,
  type PullRequestTransition,
  type WorkflowRunTransition,
} from "./event-ids.ts";
import { githubRawPayload } from "./raw-payload.ts";
import type {
  GitHubDeployment,
  GitHubDeploymentStatus,
  GitHubUser,
  GitHubWebhookRepository,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
} from "./types.ts";

const SOURCE = "github";
const MAX_KEYS = 200;
const ZERO_SHA = /^0+$/;
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/i;

/** A payload is missing a field the mapping needs. Permanent: do not retry. */
export class GitHubPayloadError extends Error {
  constructor(
    readonly path: string,
    message = `missing or invalid ${path}`,
  ) {
    super(message);
    this.name = "GitHubPayloadError";
  }
}

/** How and when the object was observed; shared by webhook and polling. */
export interface ObservationContext {
  connectionId: string | null;
  observedAt: Date | string;
  method: ObservationMethod;
  deliveryId?: string;
  jobId?: string;
  detail?: string;
  /** Raw evidence (webhook body or REST object), already sanitised. */
  rawPayload?: RawPayloadInput;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Actor = CanonicalEventInputLike["actor"];
type Correlation = NonNullable<CanonicalEventInputLike["correlation"]>;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function needObject(v: unknown, path: string): Record<string, unknown> {
  if (!isObject(v)) throw new GitHubPayloadError(path);
  return v;
}

function needId(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw new GitHubPayloadError(path);
  }
  return v;
}

function needString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) throw new GitHubPayloadError(path);
  return v;
}

function needSha(v: unknown, path: string): string {
  if (typeof v !== "string" || !FULL_SHA.test(v)) throw new GitHubPayloadError(path);
  return v.toLowerCase();
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isSha(v: unknown): v is string {
  return typeof v === "string" && FULL_SHA.test(v) && !ZERO_SHA.test(v);
}

function timestamp(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return Number.isNaN(Date.parse(v)) ? undefined : v;
}

/** Validates the repository object every repository event carries. */
export function needRepository(v: unknown, path = "repository"): GitHubWebhookRepository {
  const repo = needObject(v, path);
  needId(repo.id, `${path}.id`);
  const fullName = needString(repo.full_name, `${path}.full_name`);
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) throw new GitHubPayloadError(`${path}.full_name`);
  return repo as unknown as GitHubWebhookRepository;
}

/** Actor reference for a GitHub user/bot object; null if it identifies nobody. */
export function githubActor(user: GitHubUser | null | undefined): ActorRef | null {
  if (!isObject(user)) return null;
  const id = typeof user.id === "number" ? String(user.id) : undefined;
  const login = optString(user.login);
  if (!id && !login) return null;
  const bot = user.type === "Bot" || (login?.endsWith("[bot]") ?? false);
  return { type: bot ? "bot" : "user", ...(id ? { id } : {}), ...(login ? { login } : {}) };
}

function sameActor(a: ActorRef | null, b: ActorRef | null): boolean {
  if (!a || !b) return a === b;
  return a.id && b.id ? a.id === b.id : a.login === b.login;
}

function actorWith(
  primary: ActorRef | null,
  extra: { onBehalfOf?: ActorRef | null; triggeredBy?: ActorRef | null } = {},
): Actor {
  const base: Actor = primary ?? { type: "unknown" };
  return {
    ...base,
    ...(extra.onBehalfOf && !sameActor(extra.onBehalfOf, primary)
      ? { onBehalfOf: extra.onBehalfOf }
      : {}),
    ...(extra.triggeredBy && !sameActor(extra.triggeredBy, primary)
      ? { triggeredBy: extra.triggeredBy }
      : {}),
  };
}

function pullRequestKey(fullName: string, number: number): string {
  return `${repositoryKey(fullName)}#${number}`;
}

/** "owner/name" from an API URL like https://api.github.com/repos/owner/name. */
function fullNameFromApiUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const m = /\/repos\/([^/]+\/[^/]+?)\/?$/.exec(url);
  return m?.[1];
}

/** Lower-case host of an http(s) URL, or undefined. */
function urlHost(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length === 0) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Full commit SHAs mentioned in free text (commit messages, PR bodies),
 * excluding `exclude`. Only the identifiers are kept, never the text (R8).
 */
export function mentionedCommitShas(texts: unknown[], exclude: Iterable<string> = []): string[] {
  const skip = new Set([...exclude].map((s) => s.toLowerCase()));
  const found = new Set<string>();
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const m of text.matchAll(/\b(?:[0-9a-f]{64}|[0-9a-f]{40})\b/gi)) {
      const sha = m[0].toLowerCase();
      if (!skip.has(sha) && !ZERO_SHA.test(sha)) found.add(sha);
      if (found.size >= MAX_KEYS) break;
    }
  }
  return [...found].sort();
}

function hints(h: { mentionedCommitShas?: string[]; deploymentUrls?: string[] }): JsonObject {
  const out: JsonObject = {};
  if (h.mentionedCommitShas?.length) out.mentionedCommitShas = h.mentionedCommitShas;
  if (h.deploymentUrls?.length) out.deploymentUrls = [...new Set(h.deploymentUrls)].sort();
  return Object.keys(out).length > 0 ? { correlationHints: out } : {};
}

function list(...values: (string | undefined | null)[]): string[] | undefined {
  const out = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? [...new Set(out)].slice(0, MAX_KEYS) : undefined;
}

function base(
  ctx: ObservationContext,
): Pick<
  CanonicalEventInputLike,
  "source" | "connectionId" | "observedAt" | "observation" | "rawPayload"
> {
  return {
    source: SOURCE,
    connectionId: ctx.connectionId,
    observedAt: ctx.observedAt,
    observation: {
      method: ctx.method,
      ...(ctx.deliveryId ? { deliveryId: ctx.deliveryId } : {}),
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
      ...(ctx.detail ? { detail: ctx.detail.slice(0, 1024) } : {}),
    },
    ...(ctx.rawPayload ? { rawPayload: ctx.rawPayload } : {}),
  };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/**
 * Canonical trigger type for a GitHub Actions `event` name (the thing that
 * started a workflow run). `workflow_dispatch` is `manual` unless the
 * dispatching principal is a bot/App, in which case it is `api`: GitHub does
 * not say whether a person used the UI or a personal token called the REST
 * API, so a dispatch by a user is recorded as `manual` with that caveat.
 */
export function triggerTypeForEvent(event: string, byBot = false): TriggerType {
  switch (event) {
    case "push":
      return "push";
    case "pull_request":
    case "pull_request_target":
    case "pull_request_review":
    case "pull_request_review_comment":
      return "pull_request";
    case "merge_group":
      return "merge_queue";
    case "workflow_dispatch":
      return byBot ? "api" : "manual";
    case "schedule":
      return "schedule";
    case "repository_dispatch":
      return "api";
    case "workflow_run":
    case "workflow_call":
    case "deployment":
    case "deployment_status":
      return "upstream";
    case "release":
      return "release";
    case "dynamic":
      return "system";
    default:
      return "unknown";
  }
}

/** Trigger of a workflow run: re-runs (`run_attempt > 1`) are `rerun`. */
export function workflowRunTrigger(run: GitHubWorkflowRun): CanonicalEventInputLike["trigger"] {
  const attempt = run.run_attempt ?? 1;
  const dispatcher = githubActor(run.triggering_actor ?? run.actor);
  const original = triggerTypeForEvent(run.event, dispatcher?.type === "bot");
  if (attempt > 1) {
    return {
      type: "rerun",
      sourceValue: run.event,
      detail: `attempt ${attempt}; original trigger ${original}`,
    };
  }
  let detail: string | undefined;
  if (run.event === "workflow_dispatch") {
    detail =
      original === "api"
        ? "dispatched by an app or bot (API)"
        : "dispatched by a user; GitHub does not distinguish the UI from a user token calling the API";
  } else if (run.event === "workflow_run") {
    detail = "started by the completion of another workflow run";
  }
  return { type: original, sourceValue: run.event, ...(detail ? { detail } : {}) };
}

// ---------------------------------------------------------------------------
// Workflow runs
// ---------------------------------------------------------------------------

const RUN_CONCLUSIONS: Record<string, Outcome> = {
  success: "succeeded",
  failure: "failed",
  timed_out: "failed",
  startup_failure: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
  neutral: "none",
  action_required: "pending",
  stale: "unknown",
};

export function conclusionOutcome(conclusion: string | null | undefined): Outcome {
  return (conclusion && RUN_CONCLUSIONS[conclusion]) || "unknown";
}

const RUN_ACTIONS: Record<WorkflowRunTransition, string> = {
  requested: ACTIONS.WORKFLOW_RUN_REQUESTED,
  in_progress: ACTIONS.WORKFLOW_RUN_IN_PROGRESS,
  completed: ACTIONS.WORKFLOW_RUN_COMPLETED,
};

/** Validates the fields of a workflow run object the mapping relies on. */
export function needWorkflowRun(v: unknown, path = "workflow_run"): GitHubWorkflowRun {
  const run = needObject(v, path);
  needId(run.id, `${path}.id`);
  needSha(run.head_sha, `${path}.head_sha`);
  needString(run.event, `${path}.event`);
  if (run.run_attempt !== undefined) needId(run.run_attempt, `${path}.run_attempt`);
  return run as unknown as GitHubWorkflowRun;
}

function runPullRequests(run: GitHubWorkflowRun, fallbackRepo: string): string[] {
  return (run.pull_requests ?? [])
    .filter((pr) => typeof pr?.number === "number")
    .map((pr) => pullRequestKey(fullNameFromApiUrl(pr.base?.repo?.url) ?? fallbackRepo, pr.number));
}

/** Correlation keys of a workflow run (also used for jobs, deployments and reviews). */
export function workflowRunCorrelation(
  run: GitHubWorkflowRun & { head_repository?: { full_name?: string } | null },
  repo: GitHubWebhookRepository,
): CorrelationKeys {
  const headRepo = optString(run.head_repository?.full_name);
  return {
    commitShas: [run.head_sha],
    repositories: list(repositoryKey(repo.full_name), headRepo && repositoryKey(headRepo))!,
    runIds: [`github:${run.id}`],
    ...(list(...runPullRequests(run, repo.full_name))
      ? { pullRequests: list(...runPullRequests(run, repo.full_name))! }
      : {}),
    ...(list(run.head_branch) ? { refs: list(run.head_branch)! } : {}),
  };
}

/** Summary of a run kept in `data` (also attached to deployment events). */
function runSummary(run: GitHubWorkflowRun): JsonObject {
  return {
    id: run.id,
    attempt: run.run_attempt ?? 1,
    number: run.run_number ?? null,
    event: run.event,
    workflowId: run.workflow_id ?? null,
    name: run.name ?? null,
    path: run.path ?? null,
    headBranch: run.head_branch ?? null,
    headSha: run.head_sha,
    actor: (githubActor(run.actor) as JsonObject | null) ?? null,
    triggeringActor: (githubActor(run.triggering_actor) as JsonObject | null) ?? null,
    url: run.html_url ?? null,
  };
}

/**
 * One workflow run transition. `run` is the webhook `workflow_run` object or
 * the REST run; `repo` its repository.
 */
export function workflowRunEvent(
  run: GitHubWorkflowRun,
  repo: GitHubWebhookRepository,
  transition: WorkflowRunTransition,
  ctx: ObservationContext,
): CanonicalEventInputLike {
  const occurredAt =
    transition === "requested"
      ? (timestamp(run.created_at) ?? timestamp(run.updated_at))
      : transition === "in_progress"
        ? (timestamp(run.run_started_at) ?? timestamp(run.updated_at))
        : timestamp(run.updated_at);
  const outcome: Outcome =
    transition === "completed"
      ? conclusionOutcome(run.conclusion)
      : transition === "in_progress"
        ? "in_progress"
        : "pending";
  const referenced = (run.referenced_workflows ?? [])
    .filter((w) => typeof w?.path === "string")
    .map((w) => ({ path: w.path, sha: w.sha ?? null, ref: w.ref ?? null }));
  return {
    ...base(ctx),
    sourceEventId: workflowRunEventId(run, transition),
    action: RUN_ACTIONS[transition],
    actor: actorWith(githubActor(run.actor), { triggeredBy: githubActor(run.triggering_actor) }),
    target: {
      type: "workflow_run",
      id: `${repo.full_name}/actions/runs/${run.id}`,
      name: run.name ?? run.path ?? null,
      url: run.html_url ?? null,
      repository: repo.full_name,
      ref: run.head_branch ?? null,
    },
    trigger: workflowRunTrigger(run),
    outcome,
    occurredAt: occurredAt ?? ctx.observedAt,
    correlation: workflowRunCorrelation(run, repo),
    data: {
      run: runSummary(run),
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      // Reusable (called) workflows: they have no run of their own; their
      // jobs appear as jobs of this run ("caller job / called job").
      referencedWorkflows: referenced,
      pullRequests: (run.pull_requests ?? []).map((pr) => pr.number),
    },
  };
}

// ---------------------------------------------------------------------------
// Workflow jobs
// ---------------------------------------------------------------------------

/** A completed workflow job (`workflow_job` with action `completed`). */
export function workflowJobEvent(
  job: GitHubWorkflowJob & { environment?: string | null },
  repo: GitHubWebhookRepository,
  sender: GitHubUser | null | undefined,
  ctx: ObservationContext,
): CanonicalEventInputLike {
  const attempt = job.run_attempt ?? 1;
  const environment = optString(job.environment);
  return {
    ...base(ctx),
    sourceEventId: workflowJobEventId(job),
    action: ACTIONS.WORKFLOW_JOB_COMPLETED,
    actor: actorWith(githubActor(sender)),
    target: {
      type: "workflow_run",
      id: `${repo.full_name}/actions/runs/${job.run_id}/jobs/${job.id}`,
      name: job.name,
      url: job.html_url ?? null,
      repository: repo.full_name,
      ref: job.head_branch ?? null,
      environment: environment ?? null,
    },
    trigger:
      attempt > 1
        ? { type: "rerun", sourceValue: "workflow_job", detail: `attempt ${attempt}` }
        : { type: "upstream", sourceValue: "workflow_job", detail: "job of a workflow run" },
    outcome: conclusionOutcome(job.conclusion),
    occurredAt: timestamp(job.completed_at) ?? ctx.observedAt,
    correlation: {
      commitShas: [job.head_sha],
      refs: list(job.head_branch),
      repositories: [repositoryKey(repo.full_name)],
      runIds: [`github:${job.run_id}`],
      environments: list(environment),
    },
    data: {
      job: {
        id: job.id,
        name: job.name,
        runId: job.run_id,
        runAttempt: attempt,
        workflowName: job.workflow_name ?? null,
        conclusion: job.conclusion ?? null,
        startedAt: job.started_at ?? null,
        completedAt: job.completed_at ?? null,
        labels: (job.labels ?? []).slice(0, 50),
        runnerName: job.runner_name ?? null,
        runnerGroupName: job.runner_group_name ?? null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

export function needDeployment(v: unknown, path = "deployment"): GitHubDeployment {
  const d = needObject(v, path);
  needId(d.id, `${path}.id`);
  needSha(d.sha, `${path}.sha`);
  needString(d.environment, `${path}.environment`);
  return d as unknown as GitHubDeployment;
}

function deploymentTrigger(
  deployment: GitHubDeployment,
  run: GitHubWorkflowRun | null,
): CanonicalEventInputLike["trigger"] {
  if (run) {
    return {
      type: "upstream",
      sourceValue: run.event,
      detail: `created by workflow run ${run.id} attempt ${run.run_attempt ?? 1}`,
    };
  }
  const app = deployment.performed_via_github_app;
  return {
    type: "api",
    sourceValue: "deployment",
    detail: app?.slug
      ? `created through the REST API by app ${app.slug}`
      : "created through the REST API",
  };
}

function deploymentCorrelation(
  deployment: GitHubDeployment,
  repo: GitHubWebhookRepository,
  run: GitHubWorkflowRun | null,
): Correlation {
  const runCorr: CorrelationKeys = run ? workflowRunCorrelation(run, repo) : {};
  return {
    commitShas: list(deployment.sha, ...(runCorr.commitShas ?? [])),
    refs: list(isSha(deployment.ref) ? undefined : deployment.ref, ...(runCorr.refs ?? [])),
    repositories: list(repositoryKey(repo.full_name), ...(runCorr.repositories ?? [])),
    environments: [deployment.environment],
    deploymentIds: [`github:${deployment.id}`],
    runIds: runCorr.runIds ?? null,
    pullRequests: runCorr.pullRequests ?? null,
  };
}

function deploymentTarget(
  deployment: GitHubDeployment,
  repo: GitHubWebhookRepository,
): CanonicalEventInputLike["target"] {
  return {
    type: "deployment",
    id: `${repo.full_name}/deployments/${deployment.id}`,
    name: `${deployment.environment} (${deployment.task || "deploy"})`,
    repository: repo.full_name,
    environment: deployment.environment,
    ref: deployment.ref ?? null,
  };
}

function deploymentSummary(d: GitHubDeployment): JsonObject {
  return {
    id: d.id,
    environment: d.environment,
    originalEnvironment: d.original_environment ?? null,
    ref: d.ref ?? null,
    sha: d.sha,
    task: d.task ?? null,
    productionEnvironment: d.production_environment ?? null,
    transientEnvironment: d.transient_environment ?? null,
    creator: (githubActor(d.creator) as JsonObject | null) ?? null,
    performedViaGithubApp: d.performed_via_github_app?.slug ?? null,
  };
}

/**
 * Actor of a deployment (or status): the creator GitHub reports. When the
 * deployment was made by a workflow run, the person who triggered that run
 * attempt is `triggeredBy` (if different from the creator).
 */
function deploymentActor(creator: GitHubUser | null | undefined, run: GitHubWorkflowRun | null) {
  return actorWith(githubActor(creator), {
    triggeredBy: run ? githubActor(run.triggering_actor ?? run.actor) : null,
  });
}

/** `deployment.created` from a deployment object (+ linked workflow run, if any). */
export function deploymentEvent(
  deployment: GitHubDeployment,
  repo: GitHubWebhookRepository,
  run: GitHubWorkflowRun | null,
  ctx: ObservationContext,
): CanonicalEventInputLike {
  return {
    ...base(ctx),
    sourceEventId: deploymentEventId(deployment),
    action: ACTIONS.DEPLOYMENT_CREATED,
    actor: deploymentActor(deployment.creator, run),
    target: deploymentTarget(deployment, repo),
    trigger: deploymentTrigger(deployment, run),
    outcome: "pending",
    occurredAt: timestamp(deployment.created_at) ?? ctx.observedAt,
    correlation: deploymentCorrelation(deployment, repo, run),
    data: {
      deployment: deploymentSummary(deployment),
      run: run ? runSummary(run) : null,
    },
  };
}

const STATUS_OUTCOMES: Record<string, Outcome> = {
  success: "succeeded",
  failure: "failed",
  error: "failed",
  pending: "pending",
  queued: "pending",
  waiting: "pending",
  in_progress: "in_progress",
  inactive: "none",
};

/** `deployment.status_updated` from a deployment status and its deployment. */
export function deploymentStatusEvent(
  status: GitHubDeploymentStatus,
  deployment: GitHubDeployment,
  repo: GitHubWebhookRepository,
  run: GitHubWorkflowRun | null,
  ctx: ObservationContext,
): CanonicalEventInputLike {
  const corr = deploymentCorrelation(deployment, repo, run);
  const environment = optString(status.environment) ?? deployment.environment;
  return {
    ...base(ctx),
    sourceEventId: deploymentStatusEventId(status),
    action: ACTIONS.DEPLOYMENT_STATUS_UPDATED,
    actor: deploymentActor(status.creator, run),
    target: { ...deploymentTarget(deployment, repo), environment },
    trigger: deploymentTrigger(deployment, run),
    outcome: STATUS_OUTCOMES[status.state] ?? "unknown",
    occurredAt: timestamp(status.created_at) ?? ctx.observedAt,
    correlation: { ...corr, environments: list(deployment.environment, environment) },
    data: {
      status: {
        id: status.id,
        state: status.state,
        environment,
        environmentUrl: status.environment_url || null,
        targetUrl: status.target_url || null,
        logUrl: status.log_url || null,
        performedViaGithubApp: status.performed_via_github_app?.slug ?? null,
      },
      deployment: deploymentSummary(deployment),
      run: run ? runSummary(run) : null,
      ...hints({
        deploymentUrls: [urlHost(status.environment_url), urlHost(status.target_url)].filter(
          (h): h is string => Boolean(h),
        ),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook dispatch
// ---------------------------------------------------------------------------

export interface WebhookDelivery {
  /** X-GitHub-Event */
  event: string;
  payload: unknown;
  /** Exact delivery body (raw evidence). */
  rawBody: string;
  deliveryId: string;
  receivedAt: Date | string;
  connectionId: string | null;
  jobId?: string;
}

export type MapResult =
  | { status: "mapped"; events: CanonicalEventInputLike[]; repositoryId: number }
  | { status: "ignored"; reason: string; repositoryId?: number };

/** Repository events AFE-7 maps (others are ignored). */
export const MAPPED_EVENTS = [
  "workflow_run",
  "workflow_job",
  "deployment",
  "deployment_status",
  "deployment_review",
  "deployment_protection_rule",
  "push",
  "pull_request",
  "repository_dispatch",
] as const;

const MAPPED = new Set<string>(MAPPED_EVENTS);

/**
 * Maps one verified webhook delivery. Returns `ignored` for events and
 * actions Afe does not record; throws `GitHubPayloadError` when a mapped
 * event lacks required fields. Repository selection is checked by the caller
 * with `repositoryOf` + `isRepositorySelected` before mapping.
 */
export function mapWebhookDelivery(d: WebhookDelivery): MapResult {
  if (!MAPPED.has(d.event)) return { status: "ignored", reason: `event ${d.event} not recorded` };
  const p = needObject(d.payload, "payload");
  const repo = needRepository(p.repository);
  const sanitised = githubRawPayload(d.rawBody, p);
  const ctx: ObservationContext = {
    connectionId: d.connectionId,
    observedAt: d.receivedAt,
    method: "webhook",
    deliveryId: d.deliveryId,
    ...(d.jobId ? { jobId: d.jobId } : {}),
    ...(sanitised.stripped.length > 0
      ? { detail: `raw payload redacted (R8): ${sanitised.stripped.join(", ")}` }
      : {}),
    rawPayload: sanitised.rawPayload,
  };
  const action = typeof p.action === "string" ? p.action : null;
  const ignored = (reason: string): MapResult => ({
    status: "ignored",
    reason,
    repositoryId: repo.id,
  });
  const mapped = (...events: CanonicalEventInputLike[]): MapResult => ({
    status: "mapped",
    events,
    repositoryId: repo.id,
  });

  switch (d.event) {
    case "workflow_run": {
      if (action !== "requested" && action !== "in_progress" && action !== "completed") {
        return ignored(`workflow_run action ${action} not recorded`);
      }
      const run = needWorkflowRun(p.workflow_run);
      return mapped(workflowRunEvent(run, repo, action, ctx));
    }
    case "workflow_job": {
      // Only completed jobs: they carry runner, timing and conclusion; queued /
      // in_progress / waiting add volume without new facts (approvals are
      // recorded from deployment_review, deployments from deployment).
      if (action !== "completed") return ignored(`workflow_job action ${action} not recorded`);
      const job = needObject(p.workflow_job, "workflow_job");
      needId(job.id, "workflow_job.id");
      needId(job.run_id, "workflow_job.run_id");
      needSha(job.head_sha, "workflow_job.head_sha");
      needString(job.name, "workflow_job.name");
      return mapped(
        workflowJobEvent(
          job as unknown as GitHubWorkflowJob,
          repo,
          p.sender as GitHubUser | undefined,
          ctx,
        ),
      );
    }
    case "deployment": {
      if (action !== "created") return ignored(`deployment action ${action} not recorded`);
      const deployment = needDeployment(p.deployment);
      const run = isObject(p.workflow_run) ? needWorkflowRun(p.workflow_run) : null;
      return mapped(deploymentEvent(deployment, repo, run, ctx));
    }
    case "deployment_status": {
      if (action !== "created") return ignored(`deployment_status action ${action} not recorded`);
      const status = needObject(p.deployment_status, "deployment_status");
      needId(status.id, "deployment_status.id");
      needString(status.state, "deployment_status.state");
      const deployment = needDeployment(p.deployment);
      const run = isObject(p.workflow_run) ? needWorkflowRun(p.workflow_run) : null;
      return mapped(
        deploymentStatusEvent(
          status as unknown as GitHubDeploymentStatus,
          deployment,
          repo,
          run,
          ctx,
        ),
      );
    }
    case "deployment_review":
      return mapDeploymentReview(p, repo, action, ctx, ignored, mapped);
    case "deployment_protection_rule":
      return mapProtectionRule(p, repo, action, ctx, ignored, mapped);
    case "push":
      return mapped(pushEvent(p, repo, ctx));
    case "pull_request":
      return mapPullRequest(p, repo, action, ctx, ignored, mapped);
    case "repository_dispatch":
      return mapped(repositoryDispatchEvent(p, repo, d.deliveryId, ctx));
  }
  return ignored(`event ${d.event} not recorded`);
}

type Ignored = (reason: string) => MapResult;
type Mapped = (...events: CanonicalEventInputLike[]) => MapResult;

/** Environment names of a deployment_review payload (all shapes GitHub uses). */
function reviewEnvironments(p: Record<string, unknown>): string[] {
  const envs: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) envs.push(v);
  };
  add(p.environment);
  if (isObject(p.workflow_job_run)) add(p.workflow_job_run.environment);
  if (Array.isArray(p.workflow_job_runs)) {
    for (const j of p.workflow_job_runs) if (isObject(j)) add(j.environment);
  }
  return [...new Set(envs)].sort();
}

function latestTimestamp(values: unknown[]): string | undefined {
  const ts = values.map(timestamp).filter((t): t is string => Boolean(t));
  return ts.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function mapDeploymentReview(
  p: Record<string, unknown>,
  repo: GitHubWebhookRepository,
  action: string | null,
  ctx: ObservationContext,
  ignored: Ignored,
  mapped: Mapped,
): MapResult {
  if (action !== "approved" && action !== "rejected" && action !== "requested") {
    return ignored(`deployment_review action ${action} not recorded`);
  }
  const run = needWorkflowRun(p.workflow_run);
  const environments = reviewEnvironments(p);
  if (environments.length === 0) throw new GitHubPayloadError("workflow_job_runs[].environment");
  const jobRuns = [
    ...(isObject(p.workflow_job_run) ? [p.workflow_job_run] : []),
    ...(Array.isArray(p.workflow_job_runs) ? p.workflow_job_runs.filter(isObject) : []),
  ];
  const runCorr = workflowRunCorrelation(run, repo);
  const common = {
    ...base(ctx),
    target: {
      type: "workflow_run" as const,
      id: `${repo.full_name}/actions/runs/${run.id}`,
      name: run.name ?? run.path ?? null,
      url: run.html_url ?? null,
      repository: repo.full_name,
      environment: environments.length === 1 ? environments[0]! : null,
      ref: run.head_branch ?? null,
    },
    trigger: { type: "manual" as const, sourceValue: `deployment_review.${action}` },
    outcome: "none" as const,
    correlation: { ...runCorr, environments },
  };
  const jobs = jobRuns.map((j) => ({
    id: typeof j.id === "number" ? j.id : null,
    name: optString(j.name) ?? null,
    environment: optString(j.environment) ?? null,
  }));

  if (action === "requested") {
    const reviewers = Array.isArray(p.reviewers)
      ? p.reviewers.filter(isObject).map((r) => ({
          type: optString(r.type) ?? null,
          login: isObject(r.reviewer)
            ? (optString(r.reviewer.login) ?? optString(r.reviewer.slug) ?? null)
            : null,
        }))
      : [];
    return mapped({
      ...common,
      sourceEventId: deploymentReviewRequestedEventId({
        runId: run.id,
        runAttempt: run.run_attempt ?? null,
        environments,
      }),
      action: ACTIONS.DEPLOYMENT_REVIEW_REQUESTED,
      actor: actorWith(
        githubActor((p.requestor ?? p.sender) as GitHubUser | undefined) ??
          githubActor(run.triggering_actor ?? run.actor),
      ),
      occurredAt: latestTimestamp([p.since, ...jobRuns.map((j) => j.created_at)]) ?? ctx.observedAt,
      data: { run: runSummary(run), environments, jobs, reviewers },
    });
  }

  const approver = (p.approver ?? p.sender) as GitHubUser | undefined;
  const reviewer = githubActor(approver);
  if (!reviewer?.id) throw new GitHubPayloadError("approver.id");
  return mapped({
    ...common,
    sourceEventId: deploymentReviewEventId({
      runId: run.id,
      runAttempt: run.run_attempt ?? null,
      environments,
      reviewerId: reviewer.id,
      state: action,
    }),
    action:
      action === "approved"
        ? ACTIONS.DEPLOYMENT_REVIEW_APPROVED
        : ACTIONS.DEPLOYMENT_REVIEW_REJECTED,
    actor: actorWith(reviewer, { onBehalfOf: null }),
    occurredAt: latestTimestamp(jobRuns.map((j) => j.updated_at)) ?? ctx.observedAt,
    data: {
      run: runSummary(run),
      environments,
      jobs,
      state: action,
      hasComment: typeof p.comment === "string" && p.comment.length > 0,
    },
  });
}

function mapProtectionRule(
  p: Record<string, unknown>,
  repo: GitHubWebhookRepository,
  action: string | null,
  ctx: ObservationContext,
  ignored: Ignored,
  mapped: Mapped,
): MapResult {
  if (action !== "requested") {
    return ignored(`deployment_protection_rule action ${action} not recorded`);
  }
  const deployment = needDeployment(p.deployment);
  const environment = optString(p.environment) ?? deployment.environment;
  const event = optString(p.event) ?? "unknown";
  const runId = /\/actions\/runs\/(\d+)\//.exec(String(p.deployment_callback_url ?? ""))?.[1];
  const corr = deploymentCorrelation(deployment, repo, null);
  return mapped({
    ...base(ctx),
    sourceEventId: deploymentProtectionRuleEventId({ deploymentId: deployment.id, environment }),
    action: ACTIONS.DEPLOYMENT_PROTECTION_RULE_REQUESTED,
    actor: actorWith(githubActor(p.sender as GitHubUser | undefined)),
    target: { ...deploymentTarget(deployment, repo), environment },
    trigger: { type: triggerTypeForEvent(event), sourceValue: event },
    outcome: "pending",
    occurredAt: timestamp(deployment.updated_at) ?? ctx.observedAt,
    correlation: {
      ...corr,
      environments: list(deployment.environment, environment),
      runIds: runId ? [`github:${runId}`] : null,
    },
    data: { deployment: deploymentSummary(deployment), environment, event },
  });
}

/**
 * `deployment.review_approved` / `.review_rejected` from one entry of REST
 * `GET /repos/{o}/{r}/actions/runs/{id}/approvals` (AFE-8 reconciliation).
 * Same key, target and correlation as the `deployment_review` webhook.
 * The REST entry has no timestamp, so the caller passes `occurredAt` (an
 * approximation, documented in docs/connectors/github.md "Reconciliation"),
 * and no run attempt, so the caller must only use it when the attempt is
 * unambiguous.
 */
export function deploymentReviewApprovalEvent(
  approval: { state: string; user: GitHubUser | null; comment?: string | null },
  environmentNames: string[],
  run: GitHubWorkflowRun,
  repo: GitHubWebhookRepository,
  occurredAt: Date | string,
  ctx: ObservationContext,
): CanonicalEventInputLike {
  const state = approval.state;
  if (state !== "approved" && state !== "rejected") throw new GitHubPayloadError("state");
  const environments = [...new Set(environmentNames.filter((e) => e.length > 0))].sort();
  if (environments.length === 0) throw new GitHubPayloadError("environments[].name");
  const reviewer = githubActor(approval.user);
  if (!reviewer?.id) throw new GitHubPayloadError("user.id");
  return {
    ...base(ctx),
    sourceEventId: deploymentReviewEventId({
      runId: run.id,
      runAttempt: run.run_attempt ?? null,
      environments,
      reviewerId: reviewer.id,
      state,
    }),
    action:
      state === "approved"
        ? ACTIONS.DEPLOYMENT_REVIEW_APPROVED
        : ACTIONS.DEPLOYMENT_REVIEW_REJECTED,
    actor: actorWith(reviewer),
    target: {
      type: "workflow_run",
      id: `${repo.full_name}/actions/runs/${run.id}`,
      name: run.name ?? run.path ?? null,
      url: run.html_url ?? null,
      repository: repo.full_name,
      environment: environments.length === 1 ? environments[0]! : null,
      ref: run.head_branch ?? null,
    },
    trigger: { type: "manual", sourceValue: `deployment_review.${state}` },
    outcome: "none",
    occurredAt,
    correlation: { ...workflowRunCorrelation(run, repo), environments },
    data: {
      run: runSummary(run),
      environments,
      jobs: [],
      state,
      hasComment: typeof approval.comment === "string" && approval.comment.length > 0,
    },
  };
}

/**
 * A `pull_request` payload (`{ action, pull_request, sender }`) as a canonical
 * event, or null for actions Afe does not record. Used for the repository
 * events API (AFE-8), whose `PullRequestEvent` payload has the same shape.
 */
export function pullRequestEvent(
  payload: Record<string, unknown>,
  repo: GitHubWebhookRepository,
  ctx: ObservationContext,
): CanonicalEventInputLike | null {
  const action = typeof payload.action === "string" ? payload.action : null;
  const result = mapPullRequest(
    payload,
    repo,
    action,
    ctx,
    (reason) => ({ status: "ignored", reason }),
    (...events) => ({ status: "mapped", events, repositoryId: repo.id }),
  );
  return result.status === "mapped" ? (result.events[0] ?? null) : null;
}

/** A `push` payload as a canonical event (`ref.pushed` / `ref.created` / `ref.deleted`). */
export function pushEvent(
  p: Record<string, unknown>,
  repo: GitHubWebhookRepository,
  ctx: ObservationContext,
): CanonicalEventInputLike {
  const ref = needString(p.ref, "ref");
  const before = needSha(p.before, "before");
  const after = needSha(p.after, "after");
  const created = p.created === true;
  const deleted = p.deleted === true;
  const commits = Array.isArray(p.commits) ? p.commits.filter(isObject) : [];
  const headCommit = isObject(p.head_commit) ? p.head_commit : null;
  const commitIds = commits.map((c) => c.id).filter(isSha);
  const shas = list(isSha(after) ? after : undefined, ...commitIds);
  const pusher = isObject(p.pusher) ? p.pusher : null;
  const sender = githubActor(p.sender as GitHubUser | undefined);
  const actor =
    sender ??
    (optString(pusher?.name) ? { type: "user" as const, login: String(pusher!.name) } : null);
  const isTag = ref.startsWith("refs/tags/");
  const pushedAt =
    typeof repo.pushed_at === "number" && !deleted
      ? new Date(repo.pushed_at * 1000).toISOString()
      : undefined;
  const messages = [...commits.map((c) => c.message), headCommit?.message];
  return {
    ...base(ctx),
    sourceEventId: pushEventId({ repositoryId: repo.id, ref, before, after }),
    action: deleted ? ACTIONS.REF_DELETED : created ? ACTIONS.REF_CREATED : ACTIONS.REF_PUSHED,
    actor: actorWith(actor),
    target: {
      type: "ref",
      id: `${repo.full_name}:${ref}`,
      name: ref.replace(/^refs\/(heads|tags)\//, ""),
      repository: repo.full_name,
      ref,
    },
    trigger: { type: isTag && created ? "tag" : "push", sourceValue: "push" },
    outcome: "none",
    occurredAt: pushedAt ?? ctx.observedAt,
    correlation: {
      commitShas: shas ?? null,
      refs: [ref],
      repositories: [repositoryKey(repo.full_name)],
    },
    data: {
      ref,
      before,
      after,
      headCommit: isSha(after) ? after : null,
      created,
      deleted,
      forced: p.forced === true,
      baseRef: optString(p.base_ref) ?? null,
      commitCount: commits.length,
      pusher: optString(pusher?.name) ?? null,
      ...hints({ mentionedCommitShas: mentionedCommitShas(messages, shas ?? []) }),
    },
  };
}

function mapPullRequest(
  p: Record<string, unknown>,
  repo: GitHubWebhookRepository,
  action: string | null,
  ctx: ObservationContext,
  ignored: Ignored,
  mapped: Mapped,
): MapResult {
  const pr = needObject(p.pull_request, "pull_request");
  needId(pr.id, "pull_request.id");
  const number = needId(pr.number, "pull_request.number");
  const head = needObject(pr.head, "pull_request.head");
  const baseRef = needObject(pr.base, "pull_request.base");
  const headSha = needSha(head.sha, "pull_request.head.sha");
  let transition: PullRequestTransition;
  switch (action) {
    case "opened":
    case "reopened":
    case "synchronize":
      transition = action;
      break;
    case "closed":
      transition = pr.merged === true ? "merged" : "closed";
      break;
    default:
      return ignored(`pull_request action ${action} not recorded`);
  }
  const actions: Record<PullRequestTransition, string> = {
    opened: ACTIONS.PULL_REQUEST_OPENED,
    reopened: ACTIONS.PULL_REQUEST_REOPENED,
    synchronize: ACTIONS.PULL_REQUEST_SYNCHRONIZED,
    closed: ACTIONS.PULL_REQUEST_CLOSED,
    merged: ACTIONS.PULL_REQUEST_MERGED,
  };
  const mergeSha =
    transition === "merged" && isSha(pr.merge_commit_sha) ? pr.merge_commit_sha : null;
  const headRepo = isObject(head.repo) ? optString(head.repo.full_name) : undefined;
  const sameRepo = !headRepo || headRepo.toLowerCase() === repo.full_name.toLowerCase();
  const baseName = optString(baseRef.ref);
  const headName = optString(head.ref);
  const sender = githubActor(p.sender as GitHubUser | undefined);
  const mergedBy = githubActor(pr.merged_by as GitHubUser | undefined);
  const occurredAt =
    transition === "opened"
      ? timestamp(pr.created_at)
      : transition === "merged"
        ? (timestamp(pr.merged_at) ?? timestamp(pr.closed_at))
        : transition === "closed"
          ? timestamp(pr.closed_at)
          : timestamp(pr.updated_at);
  const shas = list(mergeSha, headSha);
  return mapped({
    ...base(ctx),
    sourceEventId: pullRequestEventId(
      {
        id: pr.id as number,
        head: { sha: headSha },
        closed_at: (pr.closed_at as string | null) ?? null,
        updated_at: pr.updated_at as string,
      },
      transition,
    ),
    action: actions[transition],
    actor: actorWith(transition === "merged" ? (mergedBy ?? sender) : sender),
    target: {
      type: "other",
      id: `${repo.full_name}#${number}`,
      name: `${repo.full_name}#${number}`,
      url: optString(pr.html_url) ?? null,
      repository: repo.full_name,
      ref: baseName ? `refs/heads/${baseName}` : null,
    },
    trigger: { type: "pull_request", sourceValue: `pull_request.${action}` },
    outcome: "none",
    occurredAt: occurredAt ?? ctx.observedAt,
    correlation: {
      commitShas: shas ?? null,
      refs: list(
        baseName && `refs/heads/${baseName}`,
        sameRepo && headName ? `refs/heads/${headName}` : undefined,
      ),
      repositories: list(repositoryKey(repo.full_name), headRepo && repositoryKey(headRepo)),
      pullRequests: [pullRequestKey(repo.full_name, number)],
    },
    data: {
      number,
      headSha,
      headRef: headName ?? null,
      headRepository: headRepo ?? null,
      baseRef: baseName ?? null,
      baseSha: isSha(baseRef.sha) ? (baseRef.sha as string) : null,
      merged: pr.merged === true,
      mergeCommitSha: mergeSha,
      mergedBy: (mergedBy as JsonObject | null) ?? null,
      author: (githubActor(pr.user as GitHubUser | undefined) as JsonObject | null) ?? null,
      ...(transition === "synchronize" && isSha(p.before) ? { before: p.before as string } : {}),
      // The body itself is never stored (R8); only commit SHAs it mentions.
      ...hints({ mentionedCommitShas: mentionedCommitShas([pr.body], shas ?? []) }),
    },
  });
}

function repositoryDispatchEvent(
  p: Record<string, unknown>,
  repo: GitHubWebhookRepository,
  deliveryId: string,
  ctx: ObservationContext,
): CanonicalEventInputLike {
  const eventType = needString(p.action, "action").slice(0, 100);
  const branch = optString(p.branch);
  return {
    ...base(ctx),
    sourceEventId: repositoryDispatchEventId({ repositoryId: repo.id, deliveryId }),
    action: ACTIONS.REPOSITORY_DISPATCH_RECEIVED,
    actor: actorWith(githubActor(p.sender as GitHubUser | undefined)),
    target: {
      type: "repository",
      id: repo.full_name,
      name: repo.full_name,
      repository: repo.full_name,
      ref: branch ? `refs/heads/${branch}` : null,
    },
    trigger: { type: "api", sourceValue: "repository_dispatch", detail: `event_type ${eventType}` },
    outcome: "none",
    // The payload carries no timestamp; receipt time is the best evidence.
    occurredAt: ctx.observedAt,
    correlation: {
      refs: list(branch && `refs/heads/${branch}`),
      repositories: [repositoryKey(repo.full_name)],
    },
    // client_payload is arbitrary caller data: raw payload only.
    data: { eventType, branch: branch ?? null } satisfies Record<string, JsonValue>,
  };
}

// ---------------------------------------------------------------------------
// Repository selection
// ---------------------------------------------------------------------------

/** Repository id of a delivery (`repository.id`), if any. */
export function repositoryIdOf(payload: unknown): number | null {
  const id = (payload as { repository?: { id?: unknown } } | null)?.repository?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Whether a repository is selected in the connection config
 * (`GitHubConnectionConfig.repositories`: "all" or the selected list).
 */
export function isRepositorySelected(config: unknown, repositoryId: number): boolean {
  const repos = (config as { repositories?: unknown } | null)?.repositories;
  if (repos === "all") return true;
  if (!Array.isArray(repos)) return false;
  return repos.some((r) => isObject(r) && r.id === repositoryId);
}
