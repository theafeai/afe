/**
 * Org activity for reconciliation tests (AFE-8): the same runs, deployments,
 * statuses and reviews as the AFE-7 webhook fixtures, served as REST objects
 * by the fake API, so polling can be compared with webhook capture.
 */
import type { CanonicalEventInputLike } from "@afe/core";
import { mapWebhookDelivery } from "../src/index.ts";
import type { FakeGitHubApi, FakeRepo } from "./fake-repo-api.ts";
import { loadWebhook } from "./fixtures/webhooks.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

export const NOW = new Date("2026-10-26T13:00:00Z");
export const REPO = { id: 11, fullName: "acme/api" };

/** Run fixtures served by the REST API in the basic scenario (no re-run). */
export const RUN_FIXTURES = [
  "workflow_run.push.completed",
  "workflow_run.pull_request.requested",
  "workflow_run.workflow_dispatch.in_progress",
  "workflow_run.workflow_dispatch.api.completed",
  "workflow_run.schedule.completed",
  "workflow_run.reusable.completed",
  "workflow_run.repository_dispatch.completed",
  "workflow_run.workflow_run.completed",
];

/** Webhook fixtures whose objects the scenario serves (for key comparison). */
export const SCENARIO_WEBHOOKS = [
  ...RUN_FIXTURES,
  "deployment.created",
  "deployment.api.created",
  "deployment_status.success",
  "deployment_review.approved",
];

export function payloadOf(fixture: string): Obj {
  return loadWebhook(fixture).payload as Obj;
}

/** The REST object for a fixture's `workflow_run` (REST runs carry `repository`). */
export function restRun(fixture: string): Obj {
  const p = payloadOf(fixture);
  return {
    ...p.workflow_run,
    repository: { id: p.repository.id, full_name: p.repository.full_name },
  };
}

/** Fills the fake API with the basic scenario on acme/api and returns the repo. */
export function orgActivity(api: FakeGitHubApi): FakeRepo {
  const repo = api.repo(REPO.fullName, REPO.id);
  for (const f of RUN_FIXTURES) repo.runs.push(restRun(f));
  const created = payloadOf("deployment.created");
  const api2 = payloadOf("deployment.api.created");
  repo.deployments.push(structuredClone(created.deployment), structuredClone(api2.deployment));
  repo.statuses.set(created.deployment.id, [
    structuredClone(payloadOf("deployment_status.success").deployment_status),
  ]);
  const review = payloadOf("deployment_review.approved");
  repo.approvals.set(review.workflow_run.id, [
    {
      state: "approved",
      comment: review.comment,
      user: review.approver,
      environments: [{ id: 1, name: "production" }],
    },
  ]);
  return repo;
}

/** Events the webhook path produces for fixtures (AFE-7 mapping). */
export function webhookEvents(fixtures: string[]): CanonicalEventInputLike[] {
  const out: CanonicalEventInputLike[] = [];
  for (const name of fixtures) {
    const f = loadWebhook(name);
    const r = mapWebhookDelivery({
      event: f.event,
      payload: f.payload,
      rawBody: JSON.stringify(f.payload),
      deliveryId: `delivery-${name}`,
      receivedAt: "2026-10-26T12:00:00Z",
      connectionId: "conn-1",
    });
    if (r.status === "mapped") out.push(...r.events);
  }
  return out;
}

/** A repository events API entry built from a webhook fixture. */
export function pushRepoEvent(): Obj {
  const p = payloadOf("push");
  return {
    id: "40000001",
    type: "PushEvent",
    actor: { id: p.sender.id, login: p.sender.login, display_login: p.sender.login },
    repo: { id: p.repository.id, name: p.repository.full_name },
    payload: {
      repository_id: p.repository.id,
      push_id: 7000001,
      size: p.commits.length,
      distinct_size: p.commits.length,
      ref: p.ref,
      head: p.after,
      before: p.before,
      commits: p.commits.map((c: Obj) => ({
        sha: c.id,
        author: { email: "alice@example.com", name: "Alice" },
        message: c.message,
        distinct: true,
      })),
    },
    created_at: "2026-10-26T09:59:00Z",
  };
}

export function pullRequestRepoEvent(): Obj {
  const p = payloadOf("pull_request.closed.merged");
  return {
    id: "40000002",
    type: "PullRequestEvent",
    actor: { id: p.sender.id, login: p.sender.login },
    repo: { id: p.repository.id, name: p.repository.full_name },
    payload: { action: p.action, number: p.pull_request.number, pull_request: p.pull_request },
    created_at: p.pull_request.closed_at,
  };
}
