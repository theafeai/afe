import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryEventSink, type MemoryEventSink } from "@afe/core";
import { Secret } from "@afe/core/security";
import {
  ScopedVercelReader,
  VercelClient,
  VercelPoller,
  captureWebhookEvent,
  classifyProductionChange,
  normalizeDeployment,
  type VercelDeployment,
  type VercelWebhookInput,
} from "../src/index.ts";
import { FakeVercelApi, MemoryVercelCaptureStore } from "../src/testing.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = 1_800_000_000_000;
const TEAM = { id: "team_acme", slug: "acme", name: "Acme" };
const USER = { id: "usr_alice", username: "alice" };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const TENANT = "t1";
const CONN = "conn-1";

describe("vercel event capture", () => {
  let api: FakeVercelApi;
  let sink: MemoryEventSink;
  let store: MemoryVercelCaptureStore;
  let reader: ScopedVercelReader;
  let clock: number;
  let seq = 0;

  beforeEach(() => {
    clock = T0;
    api = new FakeVercelApi()
      .addUser(USER)
      .addTeam(TEAM)
      .addProject(TEAM.id, {
        id: "prj_web",
        name: "web",
        updatedAt: 2,
        link: { type: "github", org: "acme", repo: "web" },
      })
      .addProject(TEAM.id, { id: "prj_secret", name: "secret", updatedAt: 1 })
      .grant("tok", USER.id, [TEAM.id]);
    const client = new VercelClient({
      token: new Secret("tok"),
      fetch: api.fetch,
      sleep: async () => {},
    });
    reader = new ScopedVercelReader(client, TEAM.id, {
      mode: "selected",
      projectIds: ["prj_web"],
    });
    sink = createMemoryEventSink();
    store = new MemoryVercelCaptureStore();
  });

  const poller = () =>
    new VercelPoller({
      reader,
      sink,
      store,
      tenantId: TENANT,
      connectionId: CONN,
      now: () => clock,
    });
  const events = () => sink.events(TENANT);
  const byKey = (key: string) => events().find((e) => e.sourceEventId === key);
  const keys = () => events().map((e) => e.sourceEventId);

  function deploy(id: string, over: Partial<VercelDeployment> = {}, projectId = "prj_web") {
    api.addDeployment(TEAM.id, {
      id,
      name: projectId === "prj_web" ? "web" : "secret",
      projectId,
      url: `${id.replace(/_/g, "-")}.vercel.app`,
      // Distinct creation times: Vercel paginates by timestamp.
      createdAt: clock + seq++,
      readyState: "READY",
      ready: clock + 2 * MIN,
      aliasAssigned: clock + 2 * MIN,
      creator: { uid: USER.id, username: USER.username },
      ...over,
    });
  }

  const githubMeta = (over: Record<string, string> = {}) => ({
    githubCommitSha: SHA,
    githubCommitRef: "main",
    githubCommitOrg: "acme",
    githubCommitRepo: "web",
    githubCommitAuthorLogin: "octocat",
    githubCommitAuthorName: "Octo Cat",
    githubCommitMessage: "secret plans", // must not be copied into the event
    ...over,
  });

  function hook(
    type: string,
    deploymentId: string,
    over: Partial<VercelWebhookInput> = {},
  ): VercelWebhookInput {
    const projectId = over.projectId ?? "prj_web";
    return {
      deliveryId: `${type}-${deploymentId}`,
      type,
      createdAt: clock,
      projectId,
      payload: {
        team: { id: TEAM.id },
        user: { id: USER.id },
        project: { id: projectId },
        deployment: { id: deploymentId, name: "web", url: `${deploymentId}.vercel.app`, meta: {} },
        target: "production",
      },
      ...over,
    };
  }

  const capture = (event: VercelWebhookInput) =>
    captureWebhookEvent({
      event,
      reader,
      sink,
      store,
      tenantId: TENANT,
      connectionId: CONN,
      observedAt: new Date(clock),
    });

  it("records every trigger type and outcome by polling alone (webhooks disabled), flagged as reconciliation", async () => {
    // First poll: backfill of an empty history.
    await poller().poll();
    expect(events()).toHaveLength(0);
    clock += MIN;

    deploy("dpl_git", { source: "git", target: "production", meta: githubMeta() });
    deploy("dpl_pr", {
      source: "git",
      target: null,
      meta: githubMeta({ githubCommitRef: "feature/x", githubPrId: "42" }),
    });
    deploy("dpl_cli", { source: "cli", target: "production", meta: { gitDirty: "1" } });
    deploy("dpl_api", { source: "api-trigger-git-deploy", meta: githubMeta() });
    deploy("dpl_hook", {
      source: "deploy-hook",
      meta: { deployHookId: "hk_1", deployHookName: "cms publish", deployHookRef: "main" },
    });
    deploy("dpl_redeploy", { source: "redeploy", target: "production" });
    deploy("dpl_import", { source: "import" });
    deploy("dpl_fail", { source: "git", meta: githubMeta(), readyState: "ERROR" });
    deploy("dpl_cancel", {
      source: "cli",
      readyState: "CANCELED",
      ready: null,
      canceledAt: clock + MIN,
      aliasAssigned: null,
    });
    deploy("dpl_staging", { source: "cli", target: "staging" });

    clock += 10 * MIN;
    const result = await poller().poll();
    expect(result.truncated).toBe(false);

    const all = events();
    expect(all.every((e) => e.observation.method === "reconciliation")).toBe(true);
    expect(all.every((e) => e.connectionId === CONN && e.source === "vercel")).toBe(true);
    // created + one final state each
    expect(all).toHaveLength(20);

    const git = byKey("deployment:dpl_git:succeeded")!;
    expect(git).toMatchObject({
      action: "deployment.status_updated",
      outcome: "succeeded",
      actor: {
        type: "user",
        id: USER.id,
        login: "alice",
        triggeredBy: { type: "user", login: "octocat", name: "Octo Cat" },
      },
      trigger: { type: "push", sourceValue: "git" },
      target: {
        type: "deployment",
        id: "dpl_git",
        project: "prj_web",
        environment: "production",
        repository: "acme/web",
        ref: "refs/heads/main",
        url: "https://dpl-git.vercel.app",
      },
      correlation: {
        commitShas: [SHA],
        refs: ["refs/heads/main"],
        repositories: ["github.com/acme/web"],
        environments: ["production"],
        deploymentIds: ["vercel:dpl_git"],
        deploymentUrls: ["dpl-git.vercel.app"],
      },
      occurredAt: new Date(T0 + 3 * MIN).toISOString(),
    });
    expect(git.data).toMatchObject({
      triggerKind: "git_push",
      aliasAssigned: true,
      target: "production",
    });
    expect(git.data.correlationHints).toBeUndefined();
    expect(JSON.stringify(git.data)).not.toContain("secret plans");
    expect(byKey("deployment:dpl_git:created")).toMatchObject({
      action: "deployment.created",
      outcome: "pending",
      occurredAt: new Date(T0 + MIN).toISOString(),
    });
    expect(byKey("deployment:dpl_git:created")!.data.aliasAssigned).toBeUndefined();

    expect(byKey("deployment:dpl_pr:created")).toMatchObject({
      trigger: { type: "pull_request" },
      target: { environment: "preview", ref: "refs/heads/feature/x" },
      correlation: { pullRequests: ["github.com/acme/web#42"], environments: ["preview"] },
      data: { triggerKind: "git_pull_request", target: "preview" },
    });
    const cli = byKey("deployment:dpl_cli:created")!;
    expect(cli).toMatchObject({
      actor: { type: "user", id: USER.id },
      trigger: { type: "cli" },
      // CLI deploy without Git metadata: repository from the project's Git link.
      correlation: { repositories: ["github.com/acme/web"] },
      data: { triggerKind: "cli", git: { dirty: true, repoFromProjectLink: true } },
    });
    expect(cli.correlation.commitShas).toBeUndefined();
    expect(cli.actor.triggeredBy).toBeUndefined();
    expect(byKey("deployment:dpl_api:created")).toMatchObject({
      trigger: { type: "api", sourceValue: "api-trigger-git-deploy" },
      data: { triggerKind: "api" },
    });
    expect(byKey("deployment:dpl_hook:created")).toMatchObject({
      actor: {
        type: "token",
        id: "deploy_hook:hk_1",
        login: "cms publish",
        onBehalfOf: { type: "user", id: USER.id },
      },
      trigger: { type: "api", sourceValue: "deploy-hook" },
      data: { triggerKind: "deploy_hook", deployHook: { id: "hk_1", name: "cms publish" } },
    });
    expect(byKey("deployment:dpl_redeploy:created")).toMatchObject({
      trigger: { type: "redeploy" },
      data: { triggerKind: "redeploy" },
    });
    expect(byKey("deployment:dpl_import:created")).toMatchObject({
      trigger: { type: "manual", sourceValue: "import" },
    });
    expect(byKey("deployment:dpl_fail:failed")).toMatchObject({
      action: "deployment.status_updated",
      outcome: "failed",
    });
    expect(byKey("deployment:dpl_cancel:cancelled")).toMatchObject({
      action: "deployment.cancelled",
      outcome: "cancelled",
      occurredAt: new Date(T0 + 2 * MIN).toISOString(),
    });
    expect(byKey("deployment:dpl_staging:created")!.target.environment).toBe("staging");

    // Raw evidence is the API object, without env values.
    const raw = sink.rawPayloads.get(git.rawPayload!.id)!;
    expect(Buffer.from(raw.body).toString()).toContain("dpl_git");
    // Read-only and project-scoped.
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
    expect(api.requests.some((r) => r.query.projectId === "prj_secret")).toBe(false);

    // Polling again adds nothing (idempotent).
    clock += 5 * MIN;
    const again = await poller().poll();
    expect(again.inserted).toBe(0);
    expect(events()).toHaveLength(20);
  });

  it("backfills history on first connect and for newly selected projects", async () => {
    clock = T0;
    deploy("dpl_old", { source: "git", createdAt: T0 - 3 * DAY, ready: T0 - 3 * DAY + MIN });
    deploy("dpl_ancient", { createdAt: T0 - 40 * DAY, ready: T0 - 40 * DAY + MIN });
    deploy("dpl_s", { createdAt: T0 - 2 * DAY, ready: T0 - 2 * DAY + MIN }, "prj_secret");
    api.pageSize = 1; // exercise pagination
    await poller().poll();
    expect(keys().sort()).toEqual(["deployment:dpl_old:created", "deployment:dpl_old:succeeded"]);
    expect(events().every((e) => e.observation.method === "backfill")).toBe(true);
    expect(store.pollState!.backfilled).toEqual({ mode: "selected", projectIds: ["prj_web"] });

    // The user adds prj_secret: its history is backfilled on the next poll.
    reader = new ScopedVercelReader(
      new VercelClient({ token: new Secret("tok"), fetch: api.fetch, sleep: async () => {} }),
      TEAM.id,
      { mode: "selected", projectIds: ["prj_web", "prj_secret"] },
    );
    clock += 3 * MIN;
    await poller().poll();
    expect(byKey("deployment:dpl_s:created")!.observation.method).toBe("backfill");
    expect(events()).toHaveLength(4);
  });

  it("defers young transitions and re-checks open deployments until they finish", async () => {
    await poller().poll();
    clock += 5 * MIN;
    // Created 20 s ago: left for the next poll so a webhook can win.
    deploy("dpl_young", { createdAt: clock - 20_000, readyState: "BUILDING", ready: null });
    // A long build that started before the window and is still building.
    deploy("dpl_long", { createdAt: clock - 15 * MIN, readyState: "BUILDING", ready: null });
    const r1 = await poller().poll();
    expect(r1.deferred).toBe(1);
    expect(keys()).toEqual(["deployment:dpl_long:created"]);
    expect(store.pollState!.openDeployments.map((d) => d.id).sort()).toEqual([
      "dpl_long",
      "dpl_young",
    ]);

    // 40 minutes later both finished; dpl_long is now outside the window.
    clock += 40 * MIN;
    api.updateDeployment("dpl_long", { readyState: "ERROR", ready: clock - 5 * MIN });
    api.updateDeployment("dpl_young", { readyState: "READY", ready: clock - 30 * MIN });
    await poller().poll();
    expect(keys().sort()).toEqual([
      "deployment:dpl_long:created",
      "deployment:dpl_long:failed",
      "deployment:dpl_young:created",
      "deployment:dpl_young:succeeded",
    ]);
    expect(store.pollState!.openDeployments).toEqual([]);
    expect(api.requests.some((r) => r.path === "/v13/deployments/dpl_long")).toBe(true);
  });

  it("webhook first, then poll: one event per transition, recorded as webhook", async () => {
    await poller().poll();
    clock += MIN;
    deploy("dpl_git", {
      source: "git",
      target: "production",
      meta: githubMeta(),
      ready: null,
      readyState: "BUILDING",
    });
    expect((await capture(hook("deployment.created", "dpl_git"))).status).toBe("ingested");
    clock += 2 * MIN;
    api.updateDeployment("dpl_git", { readyState: "READY", ready: clock });
    expect((await capture(hook("deployment.succeeded", "dpl_git"))).status).toBe("ingested");
    // deployment.ready for the same deployment is the same transition.
    expect((await capture(hook("deployment.ready", "dpl_git"))).status).toBe("duplicate");

    clock += 10 * MIN;
    const r = await poller().poll();
    expect(r.inserted).toBe(0);
    expect(events()).toHaveLength(2);
    expect(events().every((e) => e.observation.method === "webhook")).toBe(true);
    // Enriched from the API: creator, trigger and Git author as for polling.
    expect(byKey("deployment:dpl_git:created")).toMatchObject({
      actor: { type: "user", id: USER.id, triggeredBy: { login: "octocat" } },
      trigger: { type: "push" },
      correlation: { commitShas: [SHA] },
      observation: { method: "webhook", deliveryId: "deployment.created-dpl_git" },
      data: { enriched: true, webhookType: "deployment.created" },
    });
    expect(byKey("deployment:dpl_git:succeeded")!.occurredAt).toBe(
      new Date(T0 + 3 * MIN).toISOString(),
    );
  });

  it("poll first, then webhook: the webhook is a duplicate and the event stays flagged reconciliation", async () => {
    await poller().poll();
    clock += MIN;
    deploy("dpl_x", {
      source: "cli",
      readyState: "CANCELED",
      ready: null,
      canceledAt: clock + MIN,
    });
    clock += 10 * MIN;
    await poller().poll();
    expect(events()).toHaveLength(2);
    const res = await capture(hook("deployment.canceled", "dpl_x"));
    expect(res.status).toBe("duplicate");
    expect(events()).toHaveLength(2);
    expect(byKey("deployment:dpl_x:cancelled")!.observation.method).toBe("reconciliation");
  });

  it("maps a webhook from its payload when the deployment cannot be read", async () => {
    const res = await capture({
      ...hook("deployment.error", "dpl_gone"),
      payload: {
        ...hook("deployment.error", "dpl_gone").payload,
        deployment: { id: "dpl_gone", url: "gone.vercel.app", meta: githubMeta() },
      },
    });
    expect(res.status).toBe("ingested");
    expect(res.enrichmentError).toBeDefined();
    expect(byKey("deployment:dpl_gone:failed")).toMatchObject({
      actor: { type: "user", id: USER.id },
      outcome: "failed",
      correlation: { commitShas: [SHA] },
      data: { enriched: false, actorSource: "webhook payload.user" },
    });
  });

  it("ignores unselected projects and non-deployment events", async () => {
    deploy("dpl_s", {}, "prj_secret");
    api.requests.length = 0;
    expect(
      (await capture(hook("deployment.created", "dpl_s", { projectId: "prj_secret" }))).status,
    ).toBe("not_selected");
    expect((await capture(hook("project.created", "dpl_s"))).status).toBe("ignored");
    expect(api.requests).toHaveLength(0);
    clock += 10 * MIN;
    await poller().poll();
    expect(events()).toHaveLength(0);
    expect(
      api.requests.some(
        (r) =>
          r.query.projectId === "prj_secret" ||
          r.path.includes("prj_secret") ||
          r.path.includes("dpl_s"),
      ),
    ).toBe(false);
  });

  describe("promotions and rollbacks", () => {
    function setupProduction() {
      deploy("dpl_a", {
        source: "git",
        target: "production",
        meta: githubMeta(),
        createdAt: T0 - DAY,
        ready: T0 - DAY + MIN,
      });
      api.setProduction(TEAM.id, "prj_web", "dpl_a");
    }
    const alias = () =>
      events().filter(
        (e) => e.action === "deployment.promoted" || e.action === "deployment.rolled_back",
      );

    it("infers rollbacks and promotions from the production deployment, and uses lastAliasRequest when present", async () => {
      setupProduction();
      await poller().poll(); // baseline: dpl_a is production; no alias event
      expect(alias()).toHaveLength(0);

      // A new production build goes live by itself: lifecycle events only.
      clock += MIN;
      deploy("dpl_b", { source: "git", target: "production", meta: githubMeta() });
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", "dpl_b");
      await poller().poll();
      expect(alias()).toHaveLength(0);

      // Instant rollback to the older dpl_a (no new deployment).
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", "dpl_a");
      await poller().poll();
      const rollback = byKey("production_alias:prj_web:dpl_b:dpl_a")!;
      expect(rollback).toMatchObject({
        action: "deployment.rolled_back",
        trigger: { type: "rollback", sourceValue: "inferred" },
        actor: { type: "unknown" },
        outcome: "succeeded",
        target: { id: "dpl_a", environment: "production", project: "prj_web" },
        observation: { method: "reconciliation" },
        // The live deployment's commit (read from the API) for AFE-15.
        correlation: {
          commitShas: [SHA],
          deploymentIds: ["vercel:dpl_a", "vercel:dpl_b"],
          environments: ["production"],
        },
        data: {
          confidence: "inferred",
          fromDeploymentId: "dpl_b",
          toDeploymentId: "dpl_a",
          aliasAssigned: true,
          occurredAtApproximate: true,
        },
      });

      // Promote dpl_b again; Vercel reports lastAliasRequest.
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", "dpl_b", {
        type: "promote",
        fromDeploymentId: "dpl_a",
        toDeploymentId: "dpl_b",
        requestedAt: clock - MIN,
        jobStatus: "succeeded",
      });
      await poller().poll();
      expect(byKey("production_alias:prj_web:dpl_a:dpl_b")).toMatchObject({
        action: "deployment.promoted",
        trigger: { type: "promotion" },
        occurredAt: new Date(clock - MIN).toISOString(),
        data: { confidence: "reported" },
      });

      // Promote a preview build to production without rebuilding.
      clock += MIN;
      deploy("dpl_p", { source: "git", target: null, meta: githubMeta({ githubPrId: "7" }) });
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", "dpl_p", null);
      await poller().poll();
      expect(byKey("production_alias:prj_web:dpl_b:dpl_p")).toMatchObject({
        action: "deployment.promoted",
        data: { confidence: "inferred" },
      });

      // A staged production build (domains not assigned) promoted later.
      clock += MIN;
      deploy("dpl_staged", { source: "git", target: "production", aliasAssigned: null });
      clock += 10 * MIN;
      await poller().poll();
      expect(byKey("deployment:dpl_staged:succeeded")!.data.aliasAssigned).toBe(false);
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", "dpl_staged");
      await poller().poll();
      expect(byKey("production_alias:prj_web:dpl_p:dpl_staged")).toMatchObject({
        action: "deployment.promoted",
        data: { confidence: "inferred" },
      });
      expect(alias()).toHaveLength(4);
    });

    it("dedupes a promotion seen by webhook first and by poll later", async () => {
      setupProduction();
      await poller().poll();
      clock += MIN;
      deploy("dpl_b", {
        source: "git",
        target: "production",
        meta: githubMeta(),
        aliasAssigned: null,
      });
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", "dpl_b");
      const res = await capture(hook("deployment.promoted", "dpl_b"));
      expect(res.status).toBe("ingested");
      expect(byKey("production_alias:prj_web:dpl_a:dpl_b")).toMatchObject({
        action: "deployment.promoted",
        actor: { type: "user", id: USER.id },
        observation: { method: "webhook" },
        correlation: { commitShas: [SHA] },
        data: { confidence: "reported", fromDeploymentId: "dpl_a" },
      });
      clock += 5 * MIN;
      await poller().poll();
      expect(alias()).toHaveLength(1);
    });

    it("dedupes a rollback seen by poll first and by webhook later", async () => {
      setupProduction();
      clock += MIN;
      deploy("dpl_b", { source: "git", target: "production" });
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", "dpl_b");
      await poller().poll(); // baseline dpl_b
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", "dpl_a");
      await poller().poll();
      expect(alias()).toHaveLength(1);
      const res = await capture(hook("deployment.promoted", "dpl_a"));
      expect(res.status).toBe("duplicate");
      expect(alias()).toHaveLength(1);
      expect(alias()[0]!.observation.method).toBe("reconciliation");
    });
  });

  it("classifies production changes", () => {
    const d = (id: string, over: object = {}) =>
      normalizeDeployment({ id, createdAt: 100, target: "production", ready: 150, ...over });
    const prev = { deploymentId: "a", deploymentCreatedAt: 200, lastSeenAt: 300 };
    expect(classifyProductionChange({ previous: null, current: d("b") })).toBeNull();
    expect(
      classifyProductionChange({ previous: { ...prev, deploymentId: "b" }, current: d("b") }),
    ).toBeNull();
    expect(classifyProductionChange({ previous: prev, current: d("b") })!.kind).toBe("rollback");
    expect(
      classifyProductionChange({ previous: prev, current: d("b", { createdAt: 250, ready: 400 }) }),
    ).toBeNull();
    expect(
      classifyProductionChange({
        previous: prev,
        current: d("b", { createdAt: 250, ready: 400 }),
        aliasRequest: { type: "rollback", toDeploymentId: "b", requestedAt: 500 },
      }),
    ).toMatchObject({ kind: "rollback", confidence: "reported", occurredAt: 500 });
    expect(
      classifyProductionChange({ previous: null, current: d("b"), webhookAt: 9 }),
    ).toMatchObject({ kind: "promotion", fromDeploymentId: null, occurredAt: 9 });
  });
});
