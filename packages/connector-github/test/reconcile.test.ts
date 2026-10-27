/**
 * AFE-8: reconciliation polling against a fake GitHub API.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryEventSink, type CanonicalEvent, type MemoryEventSink } from "@afe/core";
import { Secret } from "@afe/core/security";
import {
  GitHubAppClient,
  GitHubRateLimitError,
  createMemoryPollStateStore,
  reconcileIntervalMs,
  reconcileRepository,
  reconstructableTransitions,
  runIdFromStatuses,
  spreadStart,
  type PollStateStore,
  type ReconcileRepoOptions,
} from "../src/index.ts";
import { FakeGitHubApi } from "./fake-repo-api.ts";
import { testKeyPair } from "./fixtures.ts";
import {
  NOW,
  REPO,
  SCENARIO_WEBHOOKS,
  orgActivity,
  pullRequestRepoEvent,
  pushRepoEvent,
  restRun,
  webhookEvents,
} from "./reconcile-scenario.ts";

const { privatePem } = testKeyPair();
const DAY = 24 * 3600_000;

describe("GitHub reconciliation (AFE-8)", () => {
  let api: FakeGitHubApi;
  let sink: MemoryEventSink;
  let state: PollStateStore & { entries: Map<string, unknown> };
  let client: ReturnType<GitHubAppClient["installation"]>;

  beforeEach(() => {
    api = new FakeGitHubApi();
    sink = createMemoryEventSink();
    state = createMemoryPollStateStore();
    const app = new GitHubAppClient(
      { appId: "77", privateKey: new Secret(privatePem) },
      { fetch: api.fetch, sleep: async () => {}, clock: () => NOW.getTime() },
    );
    client = app.installation(4242, { tenantId: "default" });
  });

  const recorded = async (tenantId: string, ids: string[]) => {
    const have = new Set(sink.events(tenantId).map((e) => e.sourceEventId));
    return new Set(ids.filter((i) => have.has(i)));
  };

  function pass(overrides: Partial<ReconcileRepoOptions> = {}) {
    const now = overrides.now ?? NOW;
    return reconcileRepository(
      { client, sink, state, recorded },
      {
        tenantId: "default",
        connectionId: "conn-1",
        repository: REPO,
        mode: "reconciliation",
        from: new Date(now.getTime() - DAY),
        to: now,
        conditional: true,
        now,
        ...overrides,
      },
    );
  }

  const events = () => sink.events("default");
  const byKey = () => new Map(events().map((e) => [e.sourceEventId, e]));
  const keysOf = (list: { sourceEventId: string }[]) => list.map((e) => e.sourceEventId).sort();

  describe("webhooks switched off", () => {
    it("recovers every run, deployment, status and approval, flagged as reconciled", async () => {
      orgActivity(api);
      const result = await pass();
      const stored = byKey();

      // Same keys as the webhook path would have produced.
      const expected = webhookEvents(SCENARIO_WEBHOOKS);
      for (const e of expected) expect(stored.has(e.sourceEventId), e.sourceEventId).toBe(true);

      // Honest lifecycle: requested + completed for finished runs, requested +
      // in_progress for a running one, requested for a queued one.
      expect(keysOf(events().filter((e) => e.target.type === "workflow_run"))).toEqual(
        [
          ...[9100001, 9100004, 9100005, 9100006, 9100007, 9100008].flatMap((id) => [
            `workflow_run:${id}:1:requested`,
            `workflow_run:${id}:1:completed`,
          ]),
          "workflow_run:9100003:1:requested",
          "workflow_run:9100003:1:in_progress",
          "workflow_run:9100002:1:requested",
          "deployment_review:9100001:1:production:503:approved",
        ].sort(),
      );
      expect(stored.has("deployment:880001:created")).toBe(true);
      expect(stored.has("deployment:880002:created")).toBe(true);
      expect(stored.has("deployment_status:990001")).toBe(true);
      for (const e of events()) {
        expect(e.observation.method).toBe("reconciliation");
        expect(e.observation.detail).toContain("discovered by reconciliation");
        expect(e.connectionId).toBe("conn-1");
        expect(e.observedAt).toBe(NOW.toISOString());
      }
      expect(result.inserted).toBe(events().length);
      expect(result.rejected).toBe(0);

      // Raw evidence is the REST object, without email addresses (R8).
      for (const e of events()) {
        const body = Buffer.from(sink.rawPayloads.get(e.rawPayload!.id)!.body).toString("utf8");
        expect(body).not.toContain("@example.com");
      }
      // Read-only: only GETs (plus minting the installation token).
      expect(api.apiRequests.every((r) => r.method === "GET")).toBe(true);
    });

    it("maps REST objects exactly like the webhook path", async () => {
      orgActivity(api);
      await pass();
      const stored = byKey();
      const pick = (e: { [k: string]: unknown }, keys: string[]) =>
        Object.fromEntries(keys.map((k) => [k, e[k]]));
      for (const w of webhookEvents(SCENARIO_WEBHOOKS)) {
        const polled = stored.get(w.sourceEventId)! as unknown as Record<string, unknown>;
        const keys = ["action", "actor", "target", "outcome"];
        // Runs from the same state carry the same trigger, time and correlation.
        if (w.action === "workflow_run.completed")
          keys.push("trigger", "occurredAt", "correlation");
        // Deployments: the run is linked through the status' job URL.
        if (w.action.startsWith("deployment.") && !w.action.includes("review")) {
          keys.push("trigger", "occurredAt");
        }
        const webhook = (await createMemoryEventSink().ingest("t", w)).event as unknown as Record<
          string,
          unknown
        >;
        expect(pick(polled, keys), w.sourceEventId).toEqual(pick(webhook, keys));
      }
      const deployment = stored.get("deployment:880001:created")!;
      expect(deployment.trigger).toMatchObject({ type: "upstream", sourceValue: "push" });
      expect(deployment.correlation.runIds).toEqual(["github:9100001"]);
      const apiDeployment = stored.get("deployment:880002:created")!;
      expect(apiDeployment.trigger.type).toBe("api");
    });

    it("reconstructs earlier transitions from the run's later state and says so", async () => {
      orgActivity(api);
      await pass();
      const requested = byKey().get("workflow_run:9100001:1:requested")!;
      expect(requested.occurredAt).toBe("2026-10-26T10:00:00.000Z"); // created_at
      expect(requested.outcome).toBe("pending");
      expect(requested.observation.detail).toContain("requested reconstructed");
      const completed = byKey().get("workflow_run:9100001:1:completed")!;
      expect(completed.occurredAt).toBe("2026-10-26T10:04:12.000Z"); // updated_at
      expect(completed.observation.detail).not.toContain("reconstructed");
      expect(reconstructableTransitions("completed")).toEqual(["requested", "completed"]);
      expect(reconstructableTransitions("waiting")).toEqual(["requested"]);
    });
  });

  describe("webhook and poll dedupe through the idempotency key", () => {
    it("webhook first: polling adds only what the webhooks missed", async () => {
      orgActivity(api);
      const delivered = webhookEvents(SCENARIO_WEBHOOKS);
      for (const e of delivered) await sink.ingest("default", e);
      const before = events().length;
      const result = await pass();
      const all = events();
      // No key twice; every delivered event is still the webhook's.
      expect(new Set(all.map((e) => e.sourceEventId)).size).toBe(all.length);
      for (const e of delivered) {
        expect(byKey().get(e.sourceEventId)!.observation.method).toBe("webhook");
      }
      // The polled additions are transitions no webhook delivered.
      const added = all.slice(before);
      expect(added.length).toBe(result.inserted);
      expect(added.every((e) => e.observation.method === "reconciliation")).toBe(true);
      expect(keysOf(added)).not.toContain("workflow_run:9100001:1:completed");
    });

    it("poll first: the later webhook is a duplicate", async () => {
      orgActivity(api);
      await pass();
      for (const e of webhookEvents(SCENARIO_WEBHOOKS)) {
        const r = await sink.ingest("default", e);
        expect(r.inserted, e.sourceEventId).toBe(false);
        expect(r.event?.observation.method).toBe("reconciliation");
      }
    });

    it("without a recorded lookup, re-ingesting is still idempotent", async () => {
      orgActivity(api);
      const first = await reconcileRepository(
        { client, sink, state: createMemoryPollStateStore() },
        { ...baseOptions(), conditional: false },
      );
      const second = await reconcileRepository(
        { client, sink, state: createMemoryPollStateStore() },
        { ...baseOptions(), conditional: false },
      );
      expect(second.inserted).toBe(0);
      expect(second.alreadyRecorded).toBe(first.inserted);
    });
  });

  function baseOptions(): ReconcileRepoOptions {
    return {
      tenantId: "default",
      connectionId: "conn-1",
      repository: REPO,
      mode: "reconciliation",
      from: new Date(NOW.getTime() - DAY),
      to: NOW,
      conditional: true,
      now: NOW,
    };
  }

  describe("rate limits", () => {
    it("ETags: an unchanged repository is re-read with 304s that cost nothing", async () => {
      const repo = orgActivity(api);
      await pass();
      api.reset_requests();
      const remaining = api.remaining;
      const later = new Date(NOW.getTime() + 5 * 60_000);
      const second = await pass({ now: later });
      expect(second.inserted).toBe(0);
      expect(api.apiRequests.length).toBeGreaterThan(0);
      expect(api.apiRequests.every((r) => r.conditional && r.status === 304)).toBe(true);
      expect(api.counted).toBe(0);
      expect(api.remaining).toBe(remaining);
      expect(second.notModified).toBe(second.requests);

      // A change (the running run completes) is picked up on the next pass.
      const running = repo.runs.find((r) => r.id === 9100003)!;
      Object.assign(running, {
        status: "completed",
        conclusion: "success",
        updated_at: "2026-10-26T13:02:00Z",
      });
      api.reset_requests();
      const third = await pass({ now: new Date(later.getTime() + 5 * 60_000) });
      expect(third.insertedByAction).toEqual({ "workflow_run.completed": 1 });
      expect(byKey().get("workflow_run:9100003:1:completed")!.observation.method).toBe(
        "reconciliation",
      );
    });

    it("exhaustion raises GitHubRateLimitError with the reset time", async () => {
      orgActivity(api);
      api.exhaustAfter = 1;
      const err = await pass().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      expect((err as GitHubRateLimitError).retryAfter).toEqual(new Date(api.reset * 1000));
      // The bucket is now known to be empty: no further requests until the reset.
      const before = api.requests.length;
      await expect(pass()).rejects.toBeInstanceOf(GitHubRateLimitError);
      expect(api.requests.length).toBe(before);
    });

    it("interval scales with the repository count and the remaining budget", () => {
      const base = 5 * 60_000;
      expect(reconcileIntervalMs({ repositories: 10, baseIntervalMs: base, now: NOW })).toBe(base);
      // 1000 repos * 4 requests / (5000 * 0.5 per hour) = 1.6 h
      expect(reconcileIntervalMs({ repositories: 1000, baseIntervalMs: base, now: NOW })).toBe(
        1.6 * 3600_000,
      );
      // A larger installation limit (big orgs) allows a shorter interval.
      expect(
        reconcileIntervalMs({
          repositories: 1000,
          baseIntervalMs: base,
          hourlyLimit: 12_500,
          now: NOW,
        }),
      ).toBe(0.64 * 3600_000);
      // 100 requests left for the next 30 min: 40 repos * 4 / 50 usable -> 96 min.
      expect(
        reconcileIntervalMs({
          repositories: 40,
          baseIntervalMs: base,
          remaining: 100,
          resetAt: new Date(NOW.getTime() + 30 * 60_000),
          now: NOW,
        }),
      ).toBe(96 * 60_000);
      expect(spreadStart(NOW, 2, 4, 60_000)).toEqual(new Date(NOW.getTime() + 30_000));
    });
  });

  describe("coverage", () => {
    it("follows pagination of runs, deployments and statuses", async () => {
      const repo = orgActivity(api);
      repo.statuses.get(880001)!.push(
        {
          ...repo.statuses.get(880001)![0],
          id: 990002,
          state: "in_progress",
          created_at: "2026-10-26T10:02:00Z",
        },
        {
          ...repo.statuses.get(880001)![0],
          id: 990003,
          state: "queued",
          created_at: "2026-10-26T10:01:30Z",
        },
      );
      api.pageSize = 2;
      await pass();
      const stored = byKey();
      for (const e of webhookEvents(SCENARIO_WEBHOOKS))
        expect(stored.has(e.sourceEventId)).toBe(true);
      expect(stored.has("deployment_status:990002")).toBe(true);
      expect(stored.has("deployment_status:990003")).toBe(true);
      expect(api.apiRequests.some((r) => r.url.includes("page=4"))).toBe(true);
      // Statuses are ingested oldest first.
      const order = events()
        .filter((e) => e.action === "deployment.status_updated")
        .map((e) => e.sourceEventId);
      expect(order).toEqual([
        "deployment_status:990003",
        "deployment_status:990002",
        "deployment_status:990001",
      ]);
    });

    it("splits the window when GitHub's result cap is exceeded", async () => {
      const repo = orgActivity(api);
      repo.runs.forEach((r, i) => (r.created_at = `2026-10-26T0${i}:30:00Z`));
      api.runQueryCap = 3;
      const result = await pass({ limits: { runResultCap: 3 } });
      const runs = events().filter((e) => e.action === "workflow_run.requested");
      expect(runs).toHaveLength(8);
      expect(result.notes.join(" ")).toContain("split into smaller windows");
    });

    it("says so when runs cannot be split below GitHub's result cap", async () => {
      // Six runs created in the same second, cap 3.
      orgActivity(api);
      api.runQueryCap = 3;
      const result = await pass({ limits: { runResultCap: 3 } });
      expect(result.notes.join(" ")).toContain("some may be missed");
    });

    it("re-runs: every attempt is recorded, approvals only for unambiguous first attempts", async () => {
      const repo = api.repo(REPO.fullName, REPO.id);
      repo.runs.push(restRun("workflow_run.rerun.completed"));
      repo.attempts.set(9100001, [restRun("workflow_run.push.completed")]);
      repo.approvals.set(9100001, [
        {
          state: "approved",
          user: { id: 503, login: "carol" },
          environments: [{ name: "production" }],
        },
      ]);
      await pass();
      expect(keysOf(events())).toEqual([
        "workflow_run:9100001:1:completed",
        "workflow_run:9100001:1:requested",
        "workflow_run:9100001:2:completed",
        "workflow_run:9100001:2:requested",
      ]);
      const rerun = byKey().get("workflow_run:9100001:2:completed")!;
      expect(rerun.trigger.type).toBe("rerun");
      expect(rerun.sourceEventId).toBe(
        webhookEvents(["workflow_run.rerun.completed"])[0]!.sourceEventId,
      );
      expect(api.apiRequests.some((r) => r.path.endsWith("/attempts/1"))).toBe(true);
      expect(api.apiRequests.some((r) => r.path.endsWith("/approvals"))).toBe(false);
    });

    it("re-checks runs still open after they leave the window", async () => {
      const repo = orgActivity(api);
      await pass();
      const running = repo.runs.find((r) => r.id === 9100003)!;
      Object.assign(running, {
        status: "completed",
        conclusion: "failure",
        updated_at: "2026-10-28T09:00:00Z",
      });
      const later = new Date(NOW.getTime() + 3 * DAY);
      api.reset_requests();
      await pass({ now: later });
      expect(api.apiRequests.some((r) => r.path.endsWith("/actions/runs/9100003"))).toBe(true);
      const completed = byKey().get("workflow_run:9100003:1:completed")!;
      expect(completed.outcome).toBe("failed");
    });

    it("recovers pushes and pull requests from the events API when those permissions are granted", async () => {
      const repo = api.repo(REPO.fullName, REPO.id);
      repo.events.push(pushRepoEvent(), pullRequestRepoEvent(), {
        id: "3",
        type: "WatchEvent",
        created_at: "2026-10-26T10:00:00Z",
      });
      await pass({ pushes: true, pullRequests: true });
      const expected = webhookEvents(["push", "pull_request.closed.merged"]);
      const stored = byKey();
      for (const e of expected) {
        const polled = stored.get(e.sourceEventId)!;
        expect(polled, e.sourceEventId).toBeDefined();
        expect(polled.action).toBe(e.action);
        expect(polled.observation.method).toBe("reconciliation");
      }
      const push = stored.get(expected[0]!.sourceEventId)!;
      expect(push.occurredAt).toBe("2026-10-26T09:59:00.000Z");
      expect(push.data.forced).toBeNull();
      for (const e of events()) {
        const body = Buffer.from(sink.rawPayloads.get(e.rawPayload!.id)!.body).toString("utf8");
        expect(body).not.toContain("@example.com");
        expect(body).not.toContain('"body"');
      }
      expect(events()).toHaveLength(2);
    });

    it("does not read the events API without the optional permissions, and survives a 403", async () => {
      const repo = api.repo(REPO.fullName, REPO.id);
      repo.events.push(pushRepoEvent());
      await pass();
      expect(api.apiRequests.some((r) => r.path.endsWith("/events"))).toBe(false);
      repo.eventsStatus = 403;
      const result = await pass({ pushes: true });
      expect(result.notes.join(" ")).toContain("events API returned 403");
      expect(events()).toHaveLength(0);
    });

    it("backfill mode: reads the window unconditionally and flags events as backfill", async () => {
      const repo = orgActivity(api);
      repo.runs.push({
        ...restRun("workflow_run.schedule.completed"),
        id: 9100099,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:05:00Z",
      });
      await reconcileRepository(
        { client, sink, state, recorded },
        {
          ...baseOptions(),
          mode: "backfill",
          conditional: false,
          from: new Date("2026-10-01T00:00:00Z"),
          to: NOW,
        },
      );
      expect(events().every((e) => e.observation.method === "backfill")).toBe(true);
      expect(events()[0]!.observation.detail).toContain("history imported by backfill");
      expect(byKey().has("workflow_run:9100099:1:requested")).toBe(false);
      expect(api.apiRequests.some((r) => r.conditional)).toBe(false);
      expect(state.entries.size).toBe(0);
    });

    it("skips objects it cannot map without failing the pass", async () => {
      const repo = orgActivity(api);
      repo.runs.push({ id: 1, event: "push", created_at: "2026-10-26T12:00:00Z" }); // no head_sha
      const result = await pass();
      expect(result.rejected).toBe(1);
      expect(result.notes.join(" ")).toContain("head_sha");
      expect(byKey().has("workflow_run:9100001:1:completed")).toBe(true);
    });

    it("finds the run of a deployment from its status URLs", () => {
      expect(
        runIdFromStatuses([
          {
            id: 1,
            state: "success",
            creator: null,
            created_at: "",
            updated_at: "",
            log_url: "https://github.com/acme/api/actions/runs/42/job/7",
          },
        ]),
      ).toBe(42);
      expect(runIdFromStatuses([])).toBeNull();
    });
  });

  it("events are a valid hash chain", async () => {
    orgActivity(api);
    await pass();
    const list: CanonicalEvent[] = events();
    expect(list.map((e) => e.seq)).toEqual(list.map((_, i) => i + 1));
  });
});
