import { describe, expect, it } from "vitest";
import { createMemoryEventSink, parseEventInput, type CanonicalEventInput } from "@afe/core";
import {
  GitHubPayloadError,
  deploymentEvent,
  deploymentStatusEvent,
  githubRawPayload,
  isRepositorySelected,
  mapWebhookDelivery,
  mentionedCommitShas,
  pushEventId,
  workflowRunEvent,
  workflowRunEventId,
  workflowRunTransition,
  type MapResult,
} from "../src/index.ts";
import { loadWebhook, variant, type WebhookFixture } from "./fixtures/webhooks.ts";

const SHA = "8f3c2a1b9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70";
const RECEIVED = "2026-10-26T10:05:00.000Z";

function map(f: WebhookFixture, deliveryId = "11111111-2222-3333-4444-555555555555"): MapResult {
  return mapWebhookDelivery({
    event: f.event,
    payload: f.payload,
    rawBody: JSON.stringify(f.payload),
    deliveryId,
    receivedAt: RECEIVED,
    connectionId: "conn-1",
  });
}

/** Maps a fixture and returns the single validated, normalised event. */
function one(f: WebhookFixture | string): CanonicalEventInput {
  const r = map(typeof f === "string" ? loadWebhook(f) : f);
  if (r.status !== "mapped") throw new Error(`not mapped: ${r.reason}`);
  expect(r.events).toHaveLength(1);
  return parseEventInput(r.events[0]);
}

describe("workflow_run triggers", () => {
  it("push", () => {
    const e = one("workflow_run.push.completed");
    expect(e).toMatchObject({
      source: "github",
      sourceEventId: "workflow_run:9100001:1:completed",
      connectionId: "conn-1",
      action: "workflow_run.completed",
      actor: { type: "user", id: "501", login: "alice" },
      target: {
        type: "workflow_run",
        id: "acme/api/actions/runs/9100001",
        name: "Deploy",
        repository: "acme/api",
        ref: "main",
        url: "https://github.com/acme/api/actions/runs/9100001",
      },
      trigger: { type: "push", sourceValue: "push" },
      outcome: "succeeded",
      occurredAt: "2026-10-26T10:04:12.000Z",
      observedAt: RECEIVED,
      observation: { method: "webhook", deliveryId: "11111111-2222-3333-4444-555555555555" },
      correlation: {
        commitShas: [SHA],
        refs: ["main"],
        repositories: ["github.com/acme/api"],
        runIds: ["github:9100001"],
      },
    });
    expect(e.actor.triggeredBy).toBeUndefined();
    expect(e.data).toMatchObject({
      run: {
        id: 9100001,
        attempt: 1,
        event: "push",
        workflowId: 7700001,
        path: ".github/workflows/deploy.yml",
        headSha: SHA,
      },
      conclusion: "success",
    });
  });

  it("pull request", () => {
    const e = one("workflow_run.pull_request.requested");
    expect(e).toMatchObject({
      sourceEventId: "workflow_run:9100002:1:requested",
      action: "workflow_run.requested",
      trigger: { type: "pull_request", sourceValue: "pull_request" },
      outcome: "pending",
      actor: { login: "bob" },
      correlation: { pullRequests: ["github.com/acme/api#77"], refs: ["feature/login"] },
    });
  });

  it("manual dispatch (by a user)", () => {
    const e = one("workflow_run.workflow_dispatch.in_progress");
    expect(e).toMatchObject({
      sourceEventId: "workflow_run:9100003:1:in_progress",
      action: "workflow_run.in_progress",
      trigger: { type: "manual", sourceValue: "workflow_dispatch" },
      outcome: "in_progress",
      actor: { type: "user", login: "carol" },
      occurredAt: "2026-10-26T11:00:03.000Z",
    });
    expect(e.trigger.detail).toMatch(/does not distinguish/);
  });

  it("API-triggered dispatch (by an app)", () => {
    const e = one("workflow_run.workflow_dispatch.api.completed");
    expect(e.trigger).toMatchObject({ type: "api", sourceValue: "workflow_dispatch" });
    expect(e.actor).toMatchObject({ type: "bot", login: "acme-release-bot[bot]" });
  });

  it("schedule", () => {
    const e = one("workflow_run.schedule.completed");
    expect(e).toMatchObject({
      trigger: { type: "schedule", sourceValue: "schedule" },
      outcome: "failed",
      target: { name: "Nightly deploy" },
    });
  });

  it("re-run: attempt in the key, triggering actor as triggeredBy", () => {
    const e = one("workflow_run.rerun.completed");
    expect(e).toMatchObject({
      sourceEventId: "workflow_run:9100001:2:completed",
      trigger: { type: "rerun", sourceValue: "push", detail: "attempt 2; original trigger push" },
      actor: { login: "alice", triggeredBy: { type: "user", id: "502", login: "bob" } },
    });
    // A different attempt of the same run is a different event.
    expect(e.sourceEventId).not.toBe(one("workflow_run.push.completed").sourceEventId);
  });

  it("reusable (called) workflows", () => {
    const e = one("workflow_run.reusable.completed");
    expect(e.data.referencedWorkflows).toEqual([
      {
        path: "acme/shared-workflows/.github/workflows/deploy-k8s.yml@v3",
        sha: "fedcba9876543210fedcba9876543210fedcba98",
        ref: "refs/tags/v3",
      },
      { path: "acme/api/.github/workflows/build.yml@main", sha: SHA, ref: null },
    ]);
  });

  it("repository dispatch", () => {
    const e = one("workflow_run.repository_dispatch.completed");
    expect(e.trigger).toMatchObject({ type: "api", sourceValue: "repository_dispatch" });
  });

  it("chained workflow_run", () => {
    const e = one("workflow_run.workflow_run.completed");
    expect(e.trigger).toMatchObject({ type: "upstream", sourceValue: "workflow_run" });
  });

  it("maps unknown run events to unknown rather than guessing", () => {
    const e = one(
      variant("workflow_run.push.completed", (f) => (f.payload.workflow_run.event = "label")),
    );
    expect(e.trigger).toEqual({ type: "unknown", sourceValue: "label" });
  });

  it("ignores unknown workflow_run actions", () => {
    const r = map(variant("workflow_run.push.completed", (f) => (f.payload.action = "fancy")));
    expect(r.status).toBe("ignored");
  });
});

describe("workflow_job", () => {
  it("completed job of a called workflow, with runner", () => {
    const e = one("workflow_job.completed");
    expect(e).toMatchObject({
      sourceEventId: "workflow_job:51000001:completed",
      action: "workflow_job.completed",
      outcome: "succeeded",
      target: { name: "deploy / deploy-k8s", type: "workflow_run" },
      correlation: { runIds: ["github:9100006"], commitShas: [SHA] },
      data: { job: { runnerName: "prod-runner-3", runnerGroupName: "production" } },
    });
  });

  it("ignores queued / in_progress / waiting jobs", () => {
    for (const action of ["queued", "in_progress", "waiting"]) {
      expect(
        map(variant("workflow_job.completed", (f) => (f.payload.action = action))).status,
      ).toBe("ignored");
    }
  });
});

describe("deployments", () => {
  it("deployment created by a workflow run", () => {
    const e = one("deployment.created");
    expect(e).toMatchObject({
      sourceEventId: "deployment:880001:created",
      action: "deployment.created",
      actor: { type: "user", login: "alice" },
      target: {
        type: "deployment",
        id: "acme/api/deployments/880001",
        environment: "production",
        repository: "acme/api",
        ref: "main",
      },
      trigger: { type: "upstream", sourceValue: "push" },
      outcome: "pending",
      occurredAt: "2026-10-26T10:01:00.000Z",
      correlation: {
        commitShas: [SHA],
        environments: ["production"],
        deploymentIds: ["github:880001"],
        runIds: ["github:9100001"],
        refs: ["main"],
      },
      data: { deployment: { performedViaGithubApp: "github-actions", task: "deploy" } },
    });
    // The deployment's free-form payload is never copied into the event.
    expect(JSON.stringify(e.data)).not.toContain('"payload"');
  });

  it("deployment created through the API by an app", () => {
    const e = one("deployment.api.created");
    expect(e).toMatchObject({
      actor: { type: "bot", login: "acme-release-bot[bot]" },
      trigger: { type: "api", sourceValue: "deployment" },
      target: { environment: "staging", ref: "v1.4.2" },
    });
    expect(e.correlation.runIds).toBeUndefined();
    expect(JSON.stringify(e.data)).not.toContain("OPS-1234");
  });

  it("deployment status", () => {
    const e = one("deployment_status.success");
    expect(e).toMatchObject({
      sourceEventId: "deployment_status:990001",
      action: "deployment.status_updated",
      outcome: "succeeded",
      actor: { type: "bot", login: "github-actions[bot]", triggeredBy: { login: "alice" } },
      correlation: {
        deploymentIds: ["github:880001"],
        runIds: ["github:9100001"],
        deploymentUrls: ["api.acme.example", "github.com"],
      },
      data: {
        status: { state: "success", environmentUrl: "https://API.acme.example/" },
      },
    });
    expect(e.data.correlationHints).toBeUndefined();
  });

  it("maps every deployment status state", () => {
    const expected: Record<string, string> = {
      pending: "pending",
      queued: "pending",
      in_progress: "in_progress",
      success: "succeeded",
      failure: "failed",
      error: "failed",
      inactive: "none",
    };
    for (const [state, outcome] of Object.entries(expected)) {
      const e = one(
        variant("deployment_status.success", (f) => (f.payload.deployment_status.state = state)),
      );
      expect(e.outcome).toBe(outcome);
    }
  });

  it("environment approval", () => {
    const e = one("deployment_review.approved");
    expect(e).toMatchObject({
      sourceEventId: "deployment_review:9100001:1:production:503:approved",
      action: "deployment.review_approved",
      actor: { type: "user", id: "503", login: "carol" },
      trigger: { type: "manual", sourceValue: "deployment_review.approved" },
      target: { type: "workflow_run", environment: "production" },
      correlation: { environments: ["production"], runIds: ["github:9100001"], commitShas: [SHA] },
      occurredAt: "2026-10-26T10:02:30.000Z",
      data: { hasComment: true },
    });
  });

  it("environment rejection", () => {
    const e = one("deployment_review.rejected");
    expect(e).toMatchObject({
      sourceEventId: "deployment_review:9100001:1:production:503:rejected",
      action: "deployment.review_rejected",
      actor: { login: "carol" },
    });
  });

  it("approval of a re-run attempt is a separate event", () => {
    const e = one(
      variant("deployment_review.approved", (f) => (f.payload.workflow_run.run_attempt = 2)),
    );
    expect(e.sourceEventId).toBe("deployment_review:9100001:2:production:503:approved");
  });

  it("review requested", () => {
    const e = one("deployment_review.requested");
    expect(e).toMatchObject({
      sourceEventId: "deployment_review:9100001:1:production:requested",
      action: "deployment.review_requested",
      actor: { login: "alice" },
      data: {
        reviewers: [
          { type: "User", login: "carol" },
          { type: "Team", login: "sre" },
        ],
      },
    });
  });

  it("protection rule requested", () => {
    const e = one("deployment_protection_rule.requested");
    expect(e).toMatchObject({
      sourceEventId: "deployment_protection_rule:880001:production:requested",
      action: "deployment.protection_rule_requested",
      trigger: { type: "push", sourceValue: "push" },
      correlation: { runIds: ["github:9100001"], deploymentIds: ["github:880001"] },
    });
  });
});

describe("source control events", () => {
  it("push", () => {
    const e = one("push");
    expect(e).toMatchObject({
      sourceEventId: pushEventId({
        repositoryId: 11,
        ref: "refs/heads/main",
        before: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
        after: SHA,
      }),
      action: "ref.pushed",
      actor: { type: "user", id: "501", login: "alice" },
      target: { type: "ref", id: "acme/api:refs/heads/main", ref: "refs/heads/main" },
      trigger: { type: "push" },
      outcome: "none",
      occurredAt: new Date(1793008740 * 1000).toISOString(),
      correlation: {
        commitShas: ["2b2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", SHA],
        refs: ["refs/heads/main"],
        repositories: ["github.com/acme/api"],
        upstreamCommitShas: ["0123456789abcdef0123456789abcdef01234567"],
      },
      data: {
        headCommit: SHA,
        commitCount: 2,
        forced: false,
      },
    });
    expect(e.data.correlationHints).toBeUndefined();
    // Commit messages and emails stay out of the event (R8).
    expect(JSON.stringify(e.data)).not.toMatch(/Bump API version|@example\.com/);
  });

  it("branch creation, deletion and tag creation", () => {
    const zero = "0".repeat(40);
    const created = one(
      variant("push", (f) => {
        f.payload.created = true;
        f.payload.before = zero;
      }),
    );
    expect(created.action).toBe("ref.created");
    const deleted = one(
      variant("push", (f) => {
        f.payload.deleted = true;
        f.payload.after = zero;
        f.payload.commits = [];
        f.payload.head_commit = null;
      }),
    );
    expect(deleted.action).toBe("ref.deleted");
    expect(deleted.correlation.commitShas).toBeUndefined();
    const tag = one(
      variant("push", (f) => {
        f.payload.created = true;
        f.payload.ref = "refs/tags/v1.4.2";
      }),
    );
    expect(tag.trigger.type).toBe("tag");
  });

  it("pull request opened, synchronized, merged", () => {
    const opened = one("pull_request.opened");
    expect(opened).toMatchObject({
      sourceEventId: "pull_request:66000077:opened",
      action: "pull_request.opened",
      actor: { login: "bob" },
      trigger: { type: "pull_request", sourceValue: "pull_request.opened" },
      correlation: {
        pullRequests: ["github.com/acme/api#77"],
        refs: ["refs/heads/feature/login", "refs/heads/main"],
        upstreamCommitShas: ["0123456789abcdef0123456789abcdef01234567"],
      },
    });
    expect(opened.data.correlationHints).toBeUndefined();
    expect(JSON.stringify(opened.data)).not.toMatch(/Implements login|bob@example/);

    const sync = one("pull_request.synchronize");
    expect(sync.sourceEventId).toBe(
      "pull_request:66000077:synchronize:c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
    );
    expect(sync.action).toBe("pull_request.synchronized");

    const merged = one("pull_request.closed.merged");
    expect(merged).toMatchObject({
      sourceEventId: "pull_request:66000077:merged",
      action: "pull_request.merged",
      actor: { login: "carol" },
      occurredAt: "2026-10-26T09:45:00.000Z",
      correlation: {
        commitShas: [
          "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
          "e1e2e3e4e5e6e7e8e9e0e1e2e3e4e5e6e7e8e9e0",
        ],
      },
    });
  });

  it("pull request closed without merge, and ignored actions", () => {
    const closed = one(
      variant("pull_request.closed.merged", (f) => {
        f.payload.pull_request.merged = false;
        f.payload.pull_request.merged_by = null;
        f.payload.pull_request.merge_commit_sha = null;
      }),
    );
    expect(closed).toMatchObject({
      action: "pull_request.closed",
      sourceEventId: "pull_request:66000077:closed:2026-10-26T09%3A45%3A00Z",
    });
    expect(map(variant("pull_request.opened", (f) => (f.payload.action = "labeled"))).status).toBe(
      "ignored",
    );
  });

  it("repository dispatch", () => {
    const e = one("repository_dispatch");
    expect(e).toMatchObject({
      sourceEventId: "repository_dispatch:11:11111111-2222-3333-4444-555555555555",
      action: "repository_dispatch.received",
      actor: { type: "bot", login: "acme-release-bot[bot]" },
      trigger: { type: "api", sourceValue: "repository_dispatch" },
      target: { type: "repository", id: "acme/api", ref: "refs/heads/main" },
      occurredAt: RECEIVED,
      data: { eventType: "deploy-requested", branch: "main" },
    });
    // client_payload is arbitrary: never copied into the event.
    expect(JSON.stringify(e.data)).not.toContain("1.4.2");
  });
});

describe("raw payload evidence (R8)", () => {
  it("keeps the exact bytes when nothing is stripped", () => {
    const f = loadWebhook("deployment.api.created");
    const body = JSON.stringify(f.payload, null, 1);
    expect(githubRawPayload(body, f.payload)).toEqual({
      rawPayload: { contentType: "application/json", body },
      stripped: [],
    });
  });

  it("strips emails and pull request bodies and says so", () => {
    const r = map(loadWebhook("pull_request.opened"));
    if (r.status !== "mapped") throw new Error("not mapped");
    const raw = r.events[0]!.rawPayload!.body as string;
    expect(raw).not.toContain("bob@example.com");
    expect(raw).not.toContain("Implements login");
    expect(JSON.parse(raw).pull_request.title).toBe("Add login endpoint");
    expect(r.events[0]!.observation.detail).toContain("pull_request.body");

    const push = map(loadWebhook("push"));
    if (push.status !== "mapped") throw new Error("not mapped");
    const pushRaw = push.events[0]!.rawPayload!.body as string;
    expect(pushRaw).not.toMatch(/@example\.com/);
    // Commit messages are commit metadata and stay in the evidence.
    expect(pushRaw).toContain("Bump API version");
  });

  it("keeps repository_dispatch client_payload only in the raw payload", () => {
    const r = map(loadWebhook("repository_dispatch"));
    if (r.status !== "mapped") throw new Error("not mapped");
    const raw = JSON.parse(r.events[0]!.rawPayload!.body as string);
    expect(raw.client_payload).toMatchObject({ environment: "production", version: "1.4.2" });
  });
});

describe("robustness", () => {
  it("ignores events Afe does not record", () => {
    expect(map(loadWebhook("check_run.completed"))).toMatchObject({ status: "ignored" });
    expect(map({ event: "star", payload: {} })).toMatchObject({ status: "ignored" });
  });

  it("throws GitHubPayloadError on malformed payloads", () => {
    const cases: WebhookFixture[] = [
      { event: "workflow_run", payload: null },
      variant("workflow_run.push.completed", (f) => delete f.payload.repository),
      variant("workflow_run.push.completed", (f) => (f.payload.workflow_run.id = "x")),
      variant("workflow_run.push.completed", (f) => (f.payload.workflow_run.head_sha = "abc123")),
      variant("deployment.created", (f) => delete f.payload.deployment.environment),
      variant("deployment_review.approved", (f) => {
        f.payload.workflow_job_runs = [];
      }),
      variant("push", (f) => delete f.payload.after),
    ];
    for (const f of cases) expect(() => map(f)).toThrow(GitHubPayloadError);
  });

  it("produces events the memory sink accepts, idempotently", async () => {
    const sink = createMemoryEventSink();
    const names = [
      "workflow_run.push.completed",
      "workflow_run.pull_request.requested",
      "workflow_run.workflow_dispatch.in_progress",
      "workflow_run.workflow_dispatch.api.completed",
      "workflow_run.schedule.completed",
      "workflow_run.rerun.completed",
      "workflow_run.reusable.completed",
      "workflow_run.repository_dispatch.completed",
      "workflow_run.workflow_run.completed",
      "workflow_job.completed",
      "deployment.created",
      "deployment.api.created",
      "deployment_status.success",
      "deployment_review.requested",
      "deployment_review.approved",
      "deployment_review.rejected",
      "deployment_protection_rule.requested",
      "push",
      "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.closed.merged",
      "repository_dispatch",
    ];
    for (const round of [1, 2]) {
      for (const n of names) {
        const r = map(loadWebhook(n));
        if (r.status !== "mapped") throw new Error(n);
        for (const ev of r.events) {
          expect((await sink.ingest("t1", ev)).inserted).toBe(round === 1);
        }
      }
    }
    expect(sink.events("t1")).toHaveLength(names.length);
  });
});

describe("shared builders (webhook and polling produce the same keys)", () => {
  it("REST run objects yield the webhook's key for the same state", () => {
    const f = loadWebhook("workflow_run.push.completed");
    const run = f.payload.workflow_run;
    expect(workflowRunTransition(run.status)).toBe("completed");
    expect(workflowRunTransition("queued")).toBe("requested");
    expect(workflowRunTransition("waiting")).toBe("requested");
    const polled = workflowRunEvent(run, f.payload.repository, workflowRunTransition(run.status), {
      connectionId: "conn-1",
      observedAt: RECEIVED,
      method: "reconciliation",
    });
    expect(polled.sourceEventId).toBe(workflowRunEventId(run, "completed"));
    expect(polled.sourceEventId).toBe(one(f).sourceEventId);
  });

  it("deployment and status builders work without a webhook envelope", () => {
    const f = loadWebhook("deployment_status.success");
    const ctx = { connectionId: null, observedAt: RECEIVED, method: "poll" as const };
    const d = parseEventInput(
      deploymentEvent(f.payload.deployment, f.payload.repository, null, ctx),
    );
    expect(d.sourceEventId).toBe("deployment:880001:created");
    expect(d.trigger.type).toBe("api");
    const s = parseEventInput(
      deploymentStatusEvent(
        f.payload.deployment_status,
        f.payload.deployment,
        f.payload.repository,
        null,
        ctx,
      ),
    );
    expect(s.sourceEventId).toBe("deployment_status:990001");
  });
});

describe("helpers", () => {
  it("repository selection", () => {
    expect(isRepositorySelected({ repositories: "all" }, 5)).toBe(true);
    expect(isRepositorySelected({ repositories: [{ id: 11, fullName: "acme/api" }] }, 11)).toBe(
      true,
    );
    expect(isRepositorySelected({ repositories: [{ id: 11, fullName: "acme/api" }] }, 12)).toBe(
      false,
    );
    expect(isRepositorySelected({}, 11)).toBe(false);
  });

  it("mentionedCommitShas extracts full SHAs only", () => {
    expect(
      mentionedCommitShas(
        [`see ${"a".repeat(40)} and abc1234 and ${"B".repeat(64)}`, null],
        ["a".repeat(40)],
      ),
    ).toEqual(["b".repeat(64)]);
  });
});
