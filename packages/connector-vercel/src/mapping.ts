/**
 * Maps Vercel deployments to canonical events (AFE-12). Pure functions:
 * no I/O. Webhook processing and polling (`capture.ts`, `polling.ts`) feed
 * deployments in here, so both paths produce identical idempotency keys.
 *
 * Field names follow https://vercel.com/docs/rest-api/reference/endpoints/deployments
 * and https://vercel.com/docs/webhooks/webhooks-api. Uncertain points are on
 * the "To verify" list in docs/connectors/vercel.md.
 */
import {
  type ActorRef,
  type CanonicalEventInputLike,
  type JsonObject,
  type ObservationMethod,
  type Outcome,
  type TriggerType,
  ACTIONS,
  deploymentUrlKey,
  jsonRawPayload,
  repositoryKey,
  sourceEventId,
} from "@afe/core";
import type {
  VercelAliasRequest,
  VercelDeployment,
  VercelDeploymentCreator,
  VercelDeploymentListItem,
  VercelProjectTargetDeployment,
} from "./types.ts";

const SOURCE = "vercel";

/** One shape for list items, single deployments and project `targets` entries. */
export interface DeploymentInfo {
  id: string;
  projectId: string | null;
  /** Project name (Vercel names deployments after their project). */
  name: string | null;
  /** Host name without scheme, e.g. "web-abc123.vercel.app". */
  url: string | null;
  /** Upper-case ready state: QUEUED, INITIALIZING, BUILDING, READY, ERROR, CANCELED. */
  state: string | null;
  /** "production", "staging" or null (preview). */
  target: string | null;
  /** Normalised environment name: production, preview, staging, or a custom environment slug. */
  environment: string;
  createdAt: number | null;
  readyAt: number | null;
  canceledAt: number | null;
  source: string | null;
  creator: VercelDeploymentCreator | null;
  meta: Record<string, string>;
  inspectorUrl: string | null;
  /**
   * Whether the target's domains were assigned to it (`aliasAssigned`). After
   * an instant rollback, new production builds are READY but not assigned.
   * Null when Vercel did not report the field.
   */
  aliasAssigned: boolean | null;
  /** REST `gitSource` (sha/ref/org/repo), used when `meta` has no Git keys. */
  gitSource: { type?: string; sha?: string; ref?: string; org?: string; repo?: string } | null;
  /** The project's connected repository, used when the deployment names none (e.g. CLI). */
  projectLink: VercelProjectLink | null;
}

/** `project.link` (connected Git repository). */
export interface VercelProjectLink {
  type?: string;
  org?: string;
  repo?: string;
}

type AnyDeployment =
  | VercelDeploymentListItem
  | VercelDeployment
  | VercelProjectTargetDeployment
  | (Partial<VercelDeployment> & { id: string });

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function normalizeDeployment(
  d: AnyDeployment,
  projectLink?: VercelProjectLink | null,
): DeploymentInfo {
  const r = d as Record<string, unknown>;
  const id = str(r.uid) ?? str(r.id) ?? "";
  const target = str(r.target);
  const custom = r.customEnvironment as { slug?: unknown; name?: unknown } | null | undefined;
  const environment =
    str(custom?.slug) ?? str(custom?.name) ?? (target ? target.toLowerCase() : "preview");
  const metaIn = (r.meta ?? {}) as Record<string, unknown>;
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(metaIn)) {
    if (typeof v === "string") meta[k] = v;
    else if (typeof v === "number") meta[k] = String(v);
  }
  const creator = r.creator as VercelDeploymentCreator | undefined;
  const state = str(r.readyState) ?? str(r.state);
  return {
    id,
    projectId: str(r.projectId),
    name: str(r.name),
    url: str(r.url),
    state: state ? state.toUpperCase() : null,
    target,
    environment,
    createdAt: num(r.createdAt) ?? num(r.created),
    readyAt: num(r.ready),
    canceledAt: num(r.canceledAt),
    source: str(r.source),
    creator: creator && str(creator.uid) ? creator : null,
    meta,
    inspectorUrl: str(r.inspectorUrl),
    aliasAssigned: aliasAssignedOf(r),
    gitSource:
      r.gitSource && typeof r.gitSource === "object"
        ? (r.gitSource as DeploymentInfo["gitSource"])
        : null,
    projectLink: projectLink ?? null,
  };
}

function aliasAssignedOf(r: Record<string, unknown>): boolean | null {
  if (!("aliasAssigned" in r)) return null;
  const v = r.aliasAssigned;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v > 0;
  return v === null ? false : null;
}

/** Git metadata of a deployment: `meta`, else `gitSource`, else the project's Git link (repo only). */
export function deploymentGit(d: DeploymentInfo): GitInfo | null {
  const fromMeta = gitInfo(d.meta);
  if (fromMeta) return withDirty(fromMeta, d.meta);
  const gs = d.gitSource;
  if (gs && (gs.sha || gs.ref)) {
    const provider = gs.type === "gitlab" || gs.type === "bitbucket" ? gs.type : "github";
    return withDirty(
      {
        provider,
        host: HOSTS[provider],
        sha: str(gs.sha),
        branch: str(gs.ref),
        repo: gs.org && gs.repo ? `${gs.org}/${gs.repo}` : null,
        authorLogin: null,
        authorName: null,
        pullRequest: null,
      },
      d.meta,
    );
  }
  const link = d.projectLink;
  if (link?.org && link.repo) {
    const provider = link.type === "gitlab" || link.type === "bitbucket" ? link.type : "github";
    return withDirty(
      {
        provider,
        host: HOSTS[provider],
        sha: null,
        branch: null,
        repo: `${link.org}/${link.repo}`,
        authorLogin: null,
        authorName: null,
        pullRequest: null,
        repoFromProjectLink: true,
      },
      d.meta,
    );
  }
  return null;
}

const HOSTS = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" } as const;

function withDirty(g: GitInfo, meta: Record<string, string>): GitInfo {
  const dirty = meta.gitDirty;
  return dirty === undefined ? g : { ...g, dirty: dirty === "1" || dirty === "true" };
}

// ---------------------------------------------------------------------------
// Git metadata
// ---------------------------------------------------------------------------

export interface GitInfo {
  provider: "github" | "gitlab" | "bitbucket";
  sha: string | null;
  /** Branch name as Vercel reports it (`githubCommitRef`). */
  branch: string | null;
  /** "owner/name". */
  repo: string | null;
  host: string;
  authorLogin: string | null;
  authorName: string | null;
  pullRequest: string | null;
  /** `meta.gitDirty` (CLI deploys from a checkout with uncommitted changes). */
  dirty?: boolean;
  /** The repository comes from the project link, not from the deployment. */
  repoFromProjectLink?: boolean;
}

/** Reads Git metadata from `meta` (GitHub, GitLab, Bitbucket keys). */
export function gitInfo(meta: Record<string, string>): GitInfo | null {
  const m = (k: string) => str(meta[k]);
  if (m("githubCommitSha") || m("githubCommitRef")) {
    const owner = m("githubCommitOrg") ?? m("githubOrg");
    const name = m("githubCommitRepo") ?? m("githubRepo");
    return {
      provider: "github",
      host: "github.com",
      sha: m("githubCommitSha"),
      branch: m("githubCommitRef"),
      repo: owner && name ? `${owner}/${name}` : null,
      authorLogin: m("githubCommitAuthorLogin"),
      authorName: m("githubCommitAuthorName"),
      pullRequest: m("githubPrId"),
    };
  }
  if (m("gitlabCommitSha") || m("gitlabCommitRef")) {
    const ns = m("gitlabProjectNamespace");
    const name = m("gitlabProjectName");
    return {
      provider: "gitlab",
      host: "gitlab.com",
      sha: m("gitlabCommitSha"),
      branch: m("gitlabCommitRef"),
      repo: m("gitlabProjectPath") ?? (ns && name ? `${ns}/${name}` : null),
      authorLogin: m("gitlabCommitAuthorLogin"),
      authorName: m("gitlabCommitAuthorName"),
      pullRequest: m("gitlabMergeRequestIid"),
    };
  }
  if (m("bitbucketCommitSha") || m("bitbucketCommitRef")) {
    const owner = m("bitbucketRepoOwner") ?? m("bitbucketRepoWorkspaceUuid");
    const name = m("bitbucketRepoName") ?? m("bitbucketRepoSlug");
    return {
      provider: "bitbucket",
      host: "bitbucket.org",
      sha: m("bitbucketCommitSha"),
      branch: m("bitbucketCommitRef"),
      repo: owner && name ? `${owner}/${name}` : null,
      authorLogin: m("bitbucketCommitAuthorLogin"),
      authorName: m("bitbucketCommitAuthorName"),
      pullRequest: m("bitbucketPrId"),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trigger classification
// ---------------------------------------------------------------------------

/**
 * Afe's fine-grained classification of how a deployment was started, stored
 * in `data.triggerKind` (the canonical `trigger.type` is coarser).
 */
export type DeploymentTriggerKind =
  | "git_push"
  | "git_pull_request"
  | "cli"
  | "api"
  | "deploy_hook"
  | "redeploy"
  | "dashboard"
  | "unknown";

export interface DeploymentTrigger {
  kind: DeploymentTriggerKind;
  type: TriggerType;
  sourceValue: string | null;
  detail: string | null;
}

/**
 * Classifies a deployment by Vercel's `source` and `meta`. Deploy hooks are
 * recognised by `meta.deployHookId` whatever `source` says.
 */
export function classifyDeploymentTrigger(d: DeploymentInfo): DeploymentTrigger {
  const hookId = str(d.meta.deployHookId);
  if (hookId || d.source === "deploy-hook") {
    const hookName = str(d.meta.deployHookName);
    return {
      kind: "deploy_hook",
      type: "api",
      sourceValue: d.source ?? "deploy-hook",
      detail: `deploy hook ${hookName ? `"${hookName}"` : (hookId ?? "")}`.trim(),
    };
  }
  const git = deploymentGit(d);
  switch (d.source) {
    case "git":
      return git?.pullRequest
        ? { kind: "git_pull_request", type: "pull_request", sourceValue: "git", detail: null }
        : { kind: "git_push", type: "push", sourceValue: "git", detail: null };
    case "cli":
      return { kind: "cli", type: "cli", sourceValue: "cli", detail: null };
    case "redeploy":
      return { kind: "redeploy", type: "redeploy", sourceValue: "redeploy", detail: null };
    case "api":
    case "api-trigger-git-deploy":
      return { kind: "api", type: "api", sourceValue: d.source, detail: null };
    case "import":
    case "import/repo":
    case "clone/repo":
      return { kind: "dashboard", type: "manual", sourceValue: d.source, detail: null };
    default:
      return { kind: "unknown", type: "unknown", sourceValue: d.source, detail: null };
  }
}

// ---------------------------------------------------------------------------
// Actor, target, correlation
// ---------------------------------------------------------------------------

function creatorRef(c: VercelDeploymentCreator | null): ActorRef | null {
  if (!c) return null;
  return { type: "user", id: c.uid, ...(c.username ? { login: c.username } : {}) };
}

function gitAuthorRef(git: GitInfo | null): ActorRef | null {
  if (!git || (!git.authorLogin && !git.authorName)) return null;
  return git.authorLogin
    ? { type: "user", login: git.authorLogin, ...(git.authorName ? { name: git.authorName } : {}) }
    : { type: "unknown", name: git.authorName! };
}

/**
 * Who caused the deployment. The Vercel `creator` is the actor; for deploy
 * hooks the hook is the actor (a token) acting for the creator. The Git
 * commit author, when it is reported, is `triggeredBy` for Git deployments.
 */
export function deploymentActor(d: DeploymentInfo, trigger = classifyDeploymentTrigger(d)) {
  const creator = creatorRef(d.creator);
  const git = deploymentGit(d);
  if (trigger.kind === "deploy_hook") {
    const hookId = str(d.meta.deployHookId);
    const hookName = str(d.meta.deployHookName);
    return {
      type: "token" as const,
      ...(hookId ? { id: `deploy_hook:${hookId}` } : {}),
      login: hookName ?? hookId ?? "deploy-hook",
      ...(creator ? { onBehalfOf: creator } : {}),
    };
  }
  const author =
    trigger.kind === "git_push" || trigger.kind === "git_pull_request" ? gitAuthorRef(git) : null;
  const base = creator ?? { type: "unknown" as const };
  return { ...base, ...(author ? { triggeredBy: author } : {}) };
}

function fullRef(branch: string | null): string | null {
  if (!branch) return null;
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function deploymentTarget(d: DeploymentInfo) {
  const git = deploymentGit(d);
  return {
    type: "deployment" as const,
    id: d.id,
    name: d.name,
    url: d.url ? `https://${d.url}` : null,
    project: d.projectId,
    environment: d.environment,
    repository: git?.repo ?? null,
    ref: fullRef(git?.branch ?? null),
  };
}

export function deploymentCorrelation(d: DeploymentInfo, extraDeploymentIds: string[] = []) {
  const git = deploymentGit(d);
  const sha = git?.sha && /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(git.sha) ? git.sha : null;
  const repo = git?.repo ? repositoryKey(`${git.host}/${git.repo}`) : null;
  const ref = fullRef(git?.branch ?? null);
  return {
    commitShas: sha ? [sha] : null,
    refs: ref ? [ref] : null,
    repositories: repo ? [repo] : null,
    environments: [d.environment],
    deploymentIds: [d.id, ...extraDeploymentIds].filter(Boolean).map((id) => `vercel:${id}`),
    pullRequests: repo && git?.pullRequest ? [`${repo}#${git.pullRequest}`] : null,
    deploymentUrls: d.url ? [deploymentUrlKey(d.url)].filter((h) => h !== undefined) : null,
  };
}

/** Small, non-secret summary of the deployment for `data`. */
export function deploymentData(d: DeploymentInfo, trigger: DeploymentTrigger): JsonObject {
  const git = deploymentGit(d);
  const out: JsonObject = {
    deploymentId: d.id,
    environment: d.environment,
    triggerKind: trigger.kind,
  };
  if (d.projectId) out.projectId = d.projectId;
  if (d.name) out.projectName = d.name;
  if (d.url) out.deploymentUrl = `https://${d.url}`;
  if (d.inspectorUrl) out.inspectorUrl = d.inspectorUrl;
  if (d.state) out.state = d.state;
  out.target = d.target ?? "preview";
  if (d.aliasAssigned !== null) out.aliasAssigned = d.aliasAssigned;
  if (d.source) out.vercelSource = d.source;
  if (d.creator) {
    out.creator = {
      uid: d.creator.uid,
      ...(d.creator.username ? { username: d.creator.username } : {}),
    };
  }
  if (trigger.kind === "deploy_hook") {
    const hook: JsonObject = {};
    if (d.meta.deployHookId) hook.id = d.meta.deployHookId;
    if (d.meta.deployHookName) hook.name = d.meta.deployHookName;
    if (d.meta.deployHookRef) hook.ref = d.meta.deployHookRef;
    out.deployHook = hook;
  }
  if (git) {
    const g: JsonObject = { provider: git.provider };
    if (git.sha) g.sha = git.sha;
    if (git.branch) g.branch = git.branch;
    if (git.repo) g.repo = git.repo;
    if (git.authorLogin) g.authorLogin = git.authorLogin;
    if (git.authorName) g.authorName = git.authorName;
    if (git.pullRequest) g.pullRequest = git.pullRequest;
    if (git.dirty !== undefined) g.dirty = git.dirty;
    if (git.repoFromProjectLink) g.repoFromProjectLink = true;
    out.git = g;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export type LifecycleTransition = "created" | "succeeded" | "failed" | "cancelled";

/** `deployment:<dpl_id>:<transition>` (docs/event-model.md). */
export function lifecycleSourceEventId(deploymentId: string, transition: LifecycleTransition) {
  return sourceEventId("deployment", deploymentId, transition);
}

/** The terminal transition a ready state represents, if any. */
export function terminalTransition(state: string | null): LifecycleTransition | null {
  switch (state) {
    case "READY":
      return "succeeded";
    case "ERROR":
      return "failed";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    default:
      return null;
  }
}

/** When the terminal state was reached, if Vercel reports it. */
export function terminalTime(d: DeploymentInfo): number | null {
  if (d.state === "CANCELED") return d.canceledAt ?? d.readyAt;
  return d.readyAt;
}

export interface Provenance {
  method: ObservationMethod;
  observedAt: Date;
  connectionId: string;
  deliveryId?: string | null;
  jobId?: string | null;
  detail?: string | null;
}

export interface LifecycleEventOptions {
  transition: LifecycleTransition;
  provenance: Provenance;
  /** Source time of the transition; defaults per transition (see `defaultOccurredAt`). */
  occurredAt?: number | null;
  /** Raw payload (the webhook body or the API object the event was mapped from). */
  raw: unknown;
  extraData?: JsonObject;
}

const ACTION_BY_TRANSITION: Record<LifecycleTransition, string> = {
  created: ACTIONS.DEPLOYMENT_CREATED,
  succeeded: ACTIONS.DEPLOYMENT_STATUS_UPDATED,
  failed: ACTIONS.DEPLOYMENT_STATUS_UPDATED,
  cancelled: ACTIONS.DEPLOYMENT_CANCELLED,
};
const OUTCOME_BY_TRANSITION: Record<LifecycleTransition, Outcome> = {
  created: "pending",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

/** Builds the canonical event for one lifecycle transition of a deployment. */
export function lifecycleEvent(
  d: DeploymentInfo,
  options: LifecycleEventOptions,
): CanonicalEventInputLike {
  const trigger = classifyDeploymentTrigger(d);
  const { transition, provenance } = options;
  let occurredAt = options.occurredAt ?? null;
  let approximate = false;
  if (occurredAt === null) {
    occurredAt = transition === "created" ? d.createdAt : terminalTime(d);
  }
  if (occurredAt === null) {
    occurredAt = provenance.observedAt.getTime();
    approximate = true;
  }
  const data: JsonObject = { ...deploymentData(d, trigger), transition, ...options.extraData };
  if (approximate) data.occurredAtApproximate = true;
  // Domain assignment is a placement hint for finished builds only (AFE-15).
  if (transition !== "succeeded") delete data.aliasAssigned;
  return {
    source: SOURCE,
    sourceEventId: lifecycleSourceEventId(d.id, transition),
    connectionId: provenance.connectionId,
    action: ACTION_BY_TRANSITION[transition]!,
    actor: deploymentActor(d, trigger),
    target: deploymentTarget(d),
    trigger: { type: trigger.type, sourceValue: trigger.sourceValue, detail: trigger.detail },
    outcome: OUTCOME_BY_TRANSITION[transition],
    occurredAt: new Date(occurredAt),
    observedAt: provenance.observedAt,
    observation: observation(provenance),
    correlation: deploymentCorrelation(d),
    data,
    rawPayload: jsonRawPayload(options.raw),
  };
}

function observation(p: Provenance) {
  return {
    method: p.method,
    deliveryId: p.deliveryId ?? null,
    jobId: p.jobId ?? null,
    detail: p.detail ?? null,
  };
}

// ---------------------------------------------------------------------------
// Production alias changes: promotions and rollbacks
// ---------------------------------------------------------------------------

/** What Afe last saw as a project's production deployment. */
export interface ProductionState {
  deploymentId: string;
  deploymentCreatedAt: number | null;
  /** The production deployment before this one, when Afe saw the change. */
  previousDeploymentId: string | null;
  previousDeploymentCreatedAt: number | null;
  /** Last time Afe confirmed `deploymentId` was production (epoch ms). */
  lastSeenAt: number;
  /** When Afe recorded the change to `deploymentId` (epoch ms). */
  changedAt: number;
  /**
   * Recent production changes of the project, oldest first (at most
   * `PRODUCTION_HISTORY_LIMIT`), with the idempotency key each was given.
   * Empty for state stored before AFE-30 (see `legacyProductionChange`).
   */
  changes: ProductionChangeRecord[];
}

/**
 * Where an occurrence time of a production change comes from (AFE-30):
 * - `lastAliasRequest`: Vercel's `requestedAt` of the promote/rollback request (exact, and
 *   the same for webhook and poll);
 * - `webhook`: the signed `createdAt` of the `deployment.promoted` webhook (exact);
 * - `observed`: Afe's first observation (a poll), an upper bound only;
 * - `legacy`: synthesised for state stored before AFE-30; the change time is unknown.
 */
export type OccurrenceSource = "lastAliasRequest" | "webhook" | "observed" | "legacy";

/** How Afe knows when a production change happened. */
export interface ProductionOccurrence {
  source: OccurrenceSource;
  /** Epoch ms: the exact time, or for `observed`/`legacy` the latest it can have happened. */
  at: number;
  /** For `observed`/`legacy`: the earliest it can have happened (last sighting of the previous production); null if unknown. */
  notBefore: number | null;
}

/** One production change Afe recorded (or chose not to emit an event for), and its key. */
export interface ProductionChangeRecord extends ProductionOccurrence {
  /** `sourceEventId` of the change's promotion/rollback event (if any was emitted). */
  key: string;
  from: string | null;
  to: string;
}

/** How many production changes per project `ProductionState.changes` keeps. */
export const PRODUCTION_HISTORY_LIMIT = 20;

/**
 * Slack when comparing occurrence times that are not both a `requestedAt`:
 * a webhook's `createdAt` trails the request by the promote job's duration, and
 * Afe's and Vercel's clocks may differ slightly.
 */
export const OCCURRENCE_TOLERANCE_MS = 2 * 60_000;

const isExact = (o: ProductionOccurrence) =>
  o.source === "lastAliasRequest" || o.source === "webhook";

/**
 * Whether two sightings of a change to the same deployment can be the same
 * occurrence. Two `requestedAt`s must be equal; otherwise exact times must lie
 * within the other's window (widened by `OCCURRENCE_TOLERANCE_MS`).
 */
export function sameOccurrence(a: ProductionOccurrence, b: ProductionOccurrence): boolean {
  const T = OCCURRENCE_TOLERANCE_MS;
  if (a.source === "lastAliasRequest" && b.source === "lastAliasRequest") return a.at === b.at;
  const lo = (o: ProductionOccurrence) => (isExact(o) ? o.at : (o.notBefore ?? -Infinity)) - T;
  const hi = (o: ProductionOccurrence) => o.at + T;
  return lo(a) <= hi(b) && lo(b) <= hi(a);
}

/**
 * The newest recorded change to `to` that `occurrence` can be (and, when both
 * name one, from the same deployment).
 */
export function findProductionChange(
  changes: readonly ProductionChangeRecord[],
  to: string,
  occurrence: ProductionOccurrence,
  from?: string | null,
): ProductionChangeRecord | null {
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i]!;
    if (c.to !== to) continue;
    if (from && c.from && from !== c.from) continue;
    if (sameOccurrence(c, occurrence)) return c;
  }
  return null;
}

/**
 * For state stored before AFE-30 (no `changes`): the change that made the
 * stored deployment production, under the old key
 * `production_alias:<project>:<from or none>:<to>`, so a late webhook for it
 * still deduplicates against an event recorded before the upgrade.
 */
export function legacyProductionChange(
  projectId: string,
  state: ProductionState,
): ProductionChangeRecord {
  return {
    key: sourceEventId(
      "production_alias",
      projectId,
      state.previousDeploymentId ?? "none",
      state.deploymentId,
    ),
    from: state.previousDeploymentId,
    to: state.deploymentId,
    source: "legacy",
    at: state.changedAt,
    notBefore: null,
  };
}

export type ProductionChangeKind = "promotion" | "rollback";

export interface ProductionChange {
  kind: ProductionChangeKind;
  /** `reported`: Vercel said so (webhook or `lastAliasRequest`); `inferred`: Afe deduced it. */
  confidence: "reported" | "inferred";
  reason: string;
  fromDeploymentId: string | null;
  occurredAt: number | null;
}

/**
 * Decides what a change of a project's production deployment means.
 *
 * - `null` previous state: the first observation. Polling records a baseline
 *   (no event, since Afe cannot know how it got there); a `deployment.promoted`
 *   webhook is still a promotion.
 * - `lastAliasRequest` naming the new deployment: Vercel's own promote/rollback record.
 * - New deployment older than the previous one: an (instant) rollback.
 * - A webhook said "promoted": a promotion.
 * - New deployment was built for a non-production target, or was already
 *   READY while the previous one was still live: a promotion.
 * - Otherwise a new production build went live by itself: no alias event
 *   (its lifecycle events already record it). Returns `null`.
 */
export function classifyProductionChange(input: {
  previous: Pick<ProductionState, "deploymentId" | "deploymentCreatedAt" | "lastSeenAt"> | null;
  current: DeploymentInfo;
  aliasRequest?: VercelAliasRequest | null;
  /** The change was reported by a `deployment.promoted` webhook, at this time. */
  webhookAt?: number | null;
}): ProductionChange | null {
  const { previous, current, aliasRequest } = input;
  const webhook = input.webhookAt !== undefined && input.webhookAt !== null;
  if (previous && previous.deploymentId === current.id) return null;
  const from = previous?.deploymentId ?? null;

  if (aliasRequest && aliasRequest.toDeploymentId === current.id) {
    const type = (aliasRequest.type ?? "").toLowerCase();
    if (type === "promote" || type === "rollback") {
      return {
        kind: type === "rollback" ? "rollback" : "promotion",
        confidence: "reported",
        reason: `lastAliasRequest.type=${type}`,
        fromDeploymentId: aliasRequest.fromDeploymentId ?? from,
        occurredAt: num(aliasRequest.requestedAt) ?? input.webhookAt ?? null,
      };
    }
  }
  if (
    previous?.deploymentCreatedAt != null &&
    current.createdAt !== null &&
    current.createdAt < previous.deploymentCreatedAt
  ) {
    return {
      kind: "rollback",
      confidence: "inferred",
      reason: "production moved to an older deployment",
      fromDeploymentId: from,
      occurredAt: input.webhookAt ?? null,
    };
  }
  if (webhook) {
    return {
      kind: "promotion",
      confidence: "reported",
      reason: "deployment.promoted webhook",
      fromDeploymentId: from,
      occurredAt: input.webhookAt!,
    };
  }
  if (!previous) return null;
  if (current.target !== "production") {
    return {
      kind: "promotion",
      confidence: "inferred",
      reason: "a deployment built for another target became production",
      fromDeploymentId: from,
      occurredAt: null,
    };
  }
  if (current.readyAt !== null && current.readyAt < previous.lastSeenAt) {
    return {
      kind: "promotion",
      confidence: "inferred",
      reason: "the deployment was ready while the previous one was still production",
      fromDeploymentId: from,
      occurredAt: null,
    };
  }
  return null;
}

/**
 * `production_alias:<projectId>:<from dpl_id or "none">:<to dpl_id>:<occurrence ms>`
 * (AFE-30). The from/to part names the transition, not its interpretation, so
 * the webhook and the poll that see the same change produce the same key
 * whichever of them names it a promotion or a rollback. The occurrence time
 * tells repeated identical changes (A→B, B→A, A→B) apart; it is Vercel's
 * `lastAliasRequest.requestedAt` when available, so both paths derive it
 * independently, else the first sighting's time, which the other path finds
 * in `ProductionState.changes`.
 */
export function productionChangeSourceEventId(
  projectId: string,
  fromDeploymentId: string | null,
  toDeploymentId: string,
  occurrenceAt: number,
): string {
  return sourceEventId(
    "production_alias",
    projectId,
    fromDeploymentId ?? "none",
    toDeploymentId,
    Math.trunc(occurrenceAt),
  );
}

export function productionChangeEvent(input: {
  projectId: string;
  deployment: DeploymentInfo;
  change: ProductionChange;
  provenance: Provenance;
  /** Who promoted or rolled back, if Vercel reported it (webhook `payload.user`). */
  actor?: ActorRef | null;
  /** What tells this occurrence apart from an identical earlier change (AFE-30). */
  occurrence: ProductionOccurrence;
  /** The key, when the change was already recorded under one (see `ProductionState.changes`). */
  sourceEventId?: string;
  raw: unknown;
}): CanonicalEventInputLike {
  const { deployment: d, change, provenance, occurrence } = input;
  const data: JsonObject = {
    projectId: input.projectId,
    toDeploymentId: d.id,
    environment: "production",
    confidence: change.confidence,
    reason: change.reason,
    triggerKind: change.kind,
    occurrenceSource: occurrence.source,
    occurrenceAt: new Date(occurrence.at).toISOString(),
  };
  if (change.fromDeploymentId) data.fromDeploymentId = change.fromDeploymentId;
  if (d.name) data.projectName = d.name;
  if (d.url) data.deploymentUrl = `https://${d.url}`;
  // The deployment now holds the production domains (AFE-15 placement hint).
  data.aliasAssigned = true;
  const git = deploymentGit(d);
  if (git?.sha)
    data.git = { provider: git.provider, sha: git.sha, ...(git.repo ? { repo: git.repo } : {}) };
  let occurredAt = change.occurredAt;
  if (occurredAt === null) {
    occurredAt = provenance.observedAt.getTime();
    data.occurredAtApproximate = true;
  }
  const actor = input.actor ?? { type: "unknown" as const };
  const target = { ...deploymentTarget(d), environment: "production", project: input.projectId };
  const correlation = deploymentCorrelation(
    { ...d, environment: "production" },
    change.fromDeploymentId ? [change.fromDeploymentId] : [],
  );
  return {
    source: SOURCE,
    sourceEventId:
      input.sourceEventId ??
      productionChangeSourceEventId(input.projectId, change.fromDeploymentId, d.id, occurrence.at),
    connectionId: provenance.connectionId,
    action:
      change.kind === "rollback" ? ACTIONS.DEPLOYMENT_ROLLED_BACK : ACTIONS.DEPLOYMENT_PROMOTED,
    actor,
    target,
    trigger: {
      type: change.kind === "rollback" ? "rollback" : "promotion",
      sourceValue: change.confidence === "reported" ? change.reason : "inferred",
    },
    outcome: "succeeded",
    occurredAt: new Date(occurredAt),
    observedAt: provenance.observedAt,
    observation: observation(provenance),
    correlation,
    data,
    rawPayload: jsonRawPayload(input.raw),
  };
}
