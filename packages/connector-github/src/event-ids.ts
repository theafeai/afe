/**
 * Idempotency keys (`sourceEventId`) of GitHub events, shared by the webhook
 * mapper (AFE-7) and reconciliation polling / backfill (AFE-8). Every key is
 * derived from fields that the webhook payload and the REST object both carry,
 * never from a delivery id (except `repository_dispatch`, see below), so the
 * same state transition observed twice is stored once.
 *
 * Reference: docs/connectors/github.md "Event capture" and
 * docs/event-model.md "Idempotency keys".
 */
import { sourceEventId } from "@afe/core";

/** Workflow run transitions Afe records (one event per run attempt and transition). */
export type WorkflowRunTransition = "requested" | "in_progress" | "completed";

/**
 * Transition of a run from its REST `status` (polling sees states, not
 * actions): `completed` and `in_progress` map to themselves; every waiting
 * state (`queued`, `requested`, `waiting`, `pending`) to `requested`.
 */
export function workflowRunTransition(status: string | null | undefined): WorkflowRunTransition {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in_progress";
  return "requested";
}

/** `workflow_run:<run id>:<run_attempt>:<transition>`; attempt defaults to 1. */
export function workflowRunEventId(
  run: { id: number; run_attempt?: number | null },
  transition: WorkflowRunTransition,
): string {
  return sourceEventId("workflow_run", run.id, run.run_attempt ?? 1, transition);
}

/** `workflow_job:<job id>:completed` (job ids are new for every attempt). */
export function workflowJobEventId(job: { id: number }): string {
  return sourceEventId("workflow_job", job.id, "completed");
}

/** `deployment:<deployment id>:created`. */
export function deploymentEventId(deployment: { id: number }): string {
  return sourceEventId("deployment", deployment.id, "created");
}

/** `deployment_status:<status id>` (status ids are globally unique and immutable). */
export function deploymentStatusEventId(status: { id: number }): string {
  return sourceEventId("deployment_status", status.id);
}

export type DeploymentReviewState = "approved" | "rejected";

/**
 * `deployment_review:<run id>:<run_attempt>:<environments>:<reviewer id>:<state>`,
 * environments lower-cased, sorted and comma-joined.
 *
 * The run attempt is part of the key so that a re-run that needs approval
 * again by the same reviewer is a new event. Polling uses
 * `GET /repos/{o}/{r}/actions/runs/{run_id}/approvals` together with the
 * run's `run_attempt` (see "To verify" in docs/connectors/github.md).
 */
export function deploymentReviewEventId(p: {
  runId: number;
  runAttempt?: number | null;
  environments: string[];
  reviewerId: number | string;
  state: DeploymentReviewState;
}): string {
  return sourceEventId(
    "deployment_review",
    p.runId,
    p.runAttempt ?? 1,
    normaliseEnvironments(p.environments).join(","),
    p.reviewerId,
    p.state,
  );
}

/**
 * `deployment_review:<run id>:<run_attempt>:<environments>:requested`.
 * Webhook only: a request for review is not listed by the REST API.
 */
export function deploymentReviewRequestedEventId(p: {
  runId: number;
  runAttempt?: number | null;
  environments: string[];
}): string {
  return sourceEventId(
    "deployment_review",
    p.runId,
    p.runAttempt ?? 1,
    normaliseEnvironments(p.environments).join(","),
    "requested",
  );
}

/** `deployment_protection_rule:<deployment id>:<environment>:requested`. Webhook only. */
export function deploymentProtectionRuleEventId(p: {
  deploymentId: number;
  environment: string;
}): string {
  return sourceEventId(
    "deployment_protection_rule",
    p.deploymentId,
    p.environment.toLowerCase(),
    "requested",
  );
}

/** `push:<repository id>:<ref>:<before>:<after>` (as in docs/event-model.md). */
export function pushEventId(p: {
  repositoryId: number;
  ref: string;
  before: string;
  after: string;
}): string {
  return sourceEventId("push", p.repositoryId, p.ref, p.before, p.after);
}

export type PullRequestTransition = "opened" | "reopened" | "synchronize" | "closed" | "merged";

/**
 * Pull request transitions:
 * - `pull_request:<id>:opened` and `pull_request:<id>:merged` happen once;
 * - `pull_request:<id>:synchronize:<new head sha>`;
 * - `pull_request:<id>:closed:<closed_at>` and `pull_request:<id>:reopened:<updated_at>`
 *   (a PR can be closed and reopened many times).
 */
export function pullRequestEventId(
  pr: { id: number; head?: { sha?: string }; closed_at?: string | null; updated_at?: string },
  transition: PullRequestTransition,
): string {
  switch (transition) {
    case "opened":
    case "merged":
      return sourceEventId("pull_request", pr.id, transition);
    case "synchronize":
      return sourceEventId("pull_request", pr.id, transition, pr.head?.sha ?? "unknown");
    case "closed":
      return sourceEventId("pull_request", pr.id, transition, pr.closed_at ?? "unknown");
    case "reopened":
      return sourceEventId("pull_request", pr.id, transition, pr.updated_at ?? "unknown");
  }
}

/**
 * `repository_dispatch:<repository id>:<delivery id>`.
 *
 * The one exception to "never key on the delivery id": a repository dispatch
 * has no id, timestamp or REST representation, so polling can never observe
 * it and the delivery GUID (kept by GitHub on redelivery) is its only
 * identity. The workflow runs it starts are keyed normally.
 */
export function repositoryDispatchEventId(p: { repositoryId: number; deliveryId: string }): string {
  return sourceEventId("repository_dispatch", p.repositoryId, p.deliveryId);
}

function normaliseEnvironments(envs: string[]): string[] {
  return [...new Set(envs.map((e) => e.toLowerCase()))].sort();
}
