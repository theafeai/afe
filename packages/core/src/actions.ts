/**
 * Action vocabulary: *what* happened, as `<object>.<verb>` (dot-separated,
 * lower snake case segments). See docs/event-model.md for the meaning of each.
 *
 * Rules:
 * - Concepts shared by several tools use a tool-neutral object name
 *   (`deployment.*`, `observation_gap.*`). Concepts that exist in one tool
 *   only are prefixed with the tool (`argocd.sync.*`).
 * - Status/outcome is carried by the event's `outcome` field, not encoded in
 *   new action names, except where the tool itself models a distinct step
 *   (e.g. `workflow_run.requested` vs `workflow_run.completed`).
 * - The validator accepts any action matching {@link ACTION_PATTERN} so that a
 *   new connector (including ones outside this repository, see ADR 0002) can
 *   emit new actions; add new actions here and in docs/event-model.md.
 *   Renaming or removing an action is a breaking change: stored events keep
 *   the name they were recorded with.
 */
export const ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

export const ACTIONS = {
  // --- Deployments (GitHub Deployments API, Vercel deployments, generic) ---
  /** A deployment record was created (GitHub `deployment`, Vercel `deployment.created`). */
  DEPLOYMENT_CREATED: "deployment.created",
  /** A deployment changed state; `outcome` holds the new state. */
  DEPLOYMENT_STATUS_UPDATED: "deployment.status_updated",
  /** An existing build was promoted to an environment (e.g. Vercel promote to production). */
  DEPLOYMENT_PROMOTED: "deployment.promoted",
  /** A previous deployment was made live again (Vercel instant rollback, etc.). */
  DEPLOYMENT_ROLLED_BACK: "deployment.rolled_back",
  /** A deployment was cancelled before completing. */
  DEPLOYMENT_CANCELLED: "deployment.cancelled",
  /** A deployment record was deleted in the source tool. */
  DEPLOYMENT_DELETED: "deployment.deleted",
  /** A required reviewer approved a deployment (GitHub `deployment_review`). */
  DEPLOYMENT_REVIEW_APPROVED: "deployment.review_approved",
  /** A required reviewer rejected a deployment. */
  DEPLOYMENT_REVIEW_REJECTED: "deployment.review_rejected",
  /** A deployment protection rule check was requested (GitHub `deployment_protection_rule`). */
  DEPLOYMENT_PROTECTION_RULE_REQUESTED: "deployment.protection_rule_requested",

  // --- GitHub Actions ---
  WORKFLOW_RUN_REQUESTED: "workflow_run.requested",
  WORKFLOW_RUN_IN_PROGRESS: "workflow_run.in_progress",
  WORKFLOW_RUN_COMPLETED: "workflow_run.completed",
  WORKFLOW_JOB_COMPLETED: "workflow_job.completed",

  // --- Source control ---
  /** Commits were pushed to an existing ref. */
  REF_PUSHED: "ref.pushed",
  REF_CREATED: "ref.created",
  REF_DELETED: "ref.deleted",
  PULL_REQUEST_MERGED: "pull_request.merged",
  RELEASE_PUBLISHED: "release.published",

  // --- ArgoCD ---
  /** A sync operation started (operationState.phase Running). */
  ARGOCD_SYNC_STARTED: "argocd.sync.started",
  ARGOCD_SYNC_SUCCEEDED: "argocd.sync.succeeded",
  /** Sync finished with phase Failed or Error. */
  ARGOCD_SYNC_FAILED: "argocd.sync.failed",
  /** Sync was terminated by a user or the controller. */
  ARGOCD_SYNC_TERMINATED: "argocd.sync.terminated",
  ARGOCD_APPLICATION_CREATED: "argocd.application.created",
  /** Application spec changed (target revision, source, sync policy...). */
  ARGOCD_APPLICATION_UPDATED: "argocd.application.updated",
  ARGOCD_APPLICATION_DELETED: "argocd.application.deleted",
  ARGOCD_HEALTH_CHANGED: "argocd.health.changed",

  // --- Delivery configuration changes that can enable or bypass deployments ---
  /** A deployment-relevant setting changed (environment, protection rule, env vars...). */
  CONFIGURATION_CHANGED: "configuration.changed",

  // --- Afe itself (source "afe") ---
  OBSERVATION_GAP_OPENED: "observation_gap.opened",
  OBSERVATION_GAP_CLOSED: "observation_gap.closed",
  CONNECTION_CREATED: "connection.created",
  CONNECTION_UPDATED: "connection.updated",
  CONNECTION_DELETED: "connection.deleted",
} as const;

export type KnownAction = (typeof ACTIONS)[keyof typeof ACTIONS];

/** Any action string; known ones autocomplete. */
export type EventAction = KnownAction | (string & {});

const KNOWN = new Set<string>(Object.values(ACTIONS));

export function isKnownAction(action: string): action is KnownAction {
  return KNOWN.has(action);
}
