import { afterEach, describe, expect, it } from "vitest";
import { createMemoryEventSink, type CanonicalEvent, type MemoryEventSink } from "@afe/core";
import { Secret } from "@afe/core/security";
import {
  ArgoCdCapture,
  createArgoCdClient,
  createMemoryCaptureStateStore,
  type CaptureObservation,
} from "../src/index.ts";
import {
  FakeApplication,
  TEST_CA_PEM,
  auditEvent,
  startFakeArgoCd,
  type FakeArgoCd,
} from "../src/testing.ts";

const TOKEN = "capture-token-SECRET";
const TENANT = "t1";
const CONN = "00000000-0000-4000-8000-000000000010";
const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";
const SHA3 = "3333333333333333333333333333333333333333";
const T0 = Date.parse("2026-10-26T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

interface Harness {
  fake: FakeArgoCd;
  sink: MemoryEventSink;
  store: ReturnType<typeof createMemoryCaptureStateStore>;
  capture: ArgoCdCapture;
  observations: CaptureObservation[];
  clock: { now: number };
  events(): CanonicalEvent[];
  /** Applies an app version to the fake and waits until the capture processed it. */
  push(app: FakeApplication): Promise<void>;
  startWatch(): void;
  stopWatch(): Promise<void>;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

async function waitFor(cond: () => boolean, what = "condition", ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function harness(
  opts: {
    apps?: FakeApplication[];
    missingApplicationStatus?: 403 | 404;
    clockStart?: number;
  } = {},
): Promise<Harness> {
  const fake = await startFakeArgoCd({
    accounts: { [TOKEN]: { username: "afe" } },
    applications: [],
    ...(opts.missingApplicationStatus
      ? { missingApplicationStatus: opts.missingApplicationStatus }
      : {}),
  });
  for (const a of opts.apps ?? []) fake.apply(a.snapshot(), { emit: false });
  const handle = createArgoCdClient({
    config: { serverUrl: fake.url, caPem: TEST_CA_PEM },
    token: () => new Secret(TOKEN),
    policy: { allowPrivateNetworks: true },
    retries: 0,
  });
  const sink = createMemoryEventSink();
  const store = createMemoryCaptureStateStore();
  const clock = { now: opts.clockStart ?? T0 };
  const observations: CaptureObservation[] = [];
  const capture = new ArgoCdCapture({
    tenantId: TENANT,
    connectionId: CONN,
    client: handle.client,
    sink,
    store,
    now: () => new Date(clock.now),
    onObservation: (o) => {
      observations.push(o);
    },
  });
  let ctrl: AbortController | undefined;
  let running: Promise<unknown> | undefined;
  const h: Harness = {
    fake,
    sink,
    store,
    capture,
    observations,
    clock,
    events: () => sink.events(TENANT),
    async push(app) {
      const stored = fake.apply(app.snapshot());
      const rv = stored.metadata!.resourceVersion;
      await waitFor(() => store.apps.get(app.uid)?.lastResourceVersion === rv, `rv ${rv}`);
    },
    startWatch() {
      ctrl = new AbortController();
      running = capture.watch({ signal: ctrl.signal, backoffMs: () => 20 });
    },
    async stopWatch() {
      ctrl?.abort();
      await running;
    },
    async close() {
      await h.stopWatch();
      await handle.close();
      await fake.close();
    },
  };
  harnesses.push(h);
  return h;
}

/** Starts watching and waits for the initial catch-up reconciliation. */
async function watching(h: Harness) {
  h.startWatch();
  await h.fake.waitForStreams(1);
  await waitFor(() => h.observations.some((o) => o.ok && o.via === "poll"), "initial reconcile");
}

const byAction = (h: Harness, action: string) => h.events().filter((e) => e.action === action);

function newApp(
  name = "guestbook",
  extra: Partial<ConstructorParameters<typeof FakeApplication>[0]> = {},
) {
  return new FakeApplication({ name, createdAt: at(1), ...extra });
}

describe("ArgoCD capture: actions from the watch stream", () => {
  it("application create, attributed from the Kubernetes event", async () => {
    const h = await harness();
    await watching(h);
    const app = newApp();
    h.clock.now = T0 + 61_000;
    h.fake.addAppEvent(
      "guestbook",
      auditEvent("alice", "created application", at(1), "ResourceCreated"),
    );
    await h.push(app);
    const [created] = byAction(h, "argocd.application.created");
    expect(created).toMatchObject({
      source: "argocd",
      sourceEventId: `application:${app.uid}:created`,
      connectionId: CONN,
      actor: { type: "user", login: "alice" },
      trigger: { type: "manual" },
      target: {
        type: "application",
        id: "argocd/guestbook",
        project: "default",
        cluster: "https://kubernetes.default.svc",
        namespace: "guestbook",
        repository: "https://github.com/acme/deploy.git",
        ref: "main",
      },
      observation: { method: "stream", detail: "watch ADDED" },
      occurredAt: at(1),
      correlation: { repositories: ["github.com/acme/deploy"] },
      data: { attribution: { source: "kubernetes_event", confidence: "high" } },
    });
  });

  it("manual sync with prune, force and replace: started and succeeded", async () => {
    const app = newApp();
    const h = await harness({ apps: [app] });
    await watching(h);
    app.startSync({
      at: at(2),
      by: "alice",
      revision: SHA1,
      prune: true,
      force: true,
      replace: true,
    });
    await h.push(app);
    app.finishSync({ at: at(3), images: ["ghcr.io/acme/api:1.2.3@sha256:" + "a".repeat(64)] });
    await h.push(app);

    const [started] = byAction(h, "argocd.sync.started");
    const [done] = byAction(h, "argocd.sync.succeeded");
    expect(started).toMatchObject({
      sourceEventId: `sync:${app.uid}:${at(2).replace(/:/g, "%3A")}:started`,
      actor: { type: "user", login: "alice" },
      trigger: { type: "manual", sourceValue: "username" },
      outcome: "in_progress",
      occurredAt: at(2),
      observation: { method: "stream" },
      data: { prune: true, force: true, replace: true, revision: SHA1, phase: "Running" },
    });
    expect(done).toMatchObject({
      outcome: "succeeded",
      occurredAt: at(3),
      correlation: {
        commitShas: [SHA1],
        repositories: ["github.com/acme/deploy"],
        deploymentIds: ["argocd:argocd/guestbook:0"],
        imageRefs: ["ghcr.io/acme/api:1.2.3@sha256:" + "a".repeat(64)],
        imageDigests: ["sha256:" + "a".repeat(64)],
      },
      data: { historyId: "0", phase: "Succeeded" },
    });
    // The history entry the sync produced is not recorded a second time.
    expect(h.events().filter((e) => e.action.startsWith("argocd.sync."))).toHaveLength(2);
  });

  it("auto-sync after a Git change is attributed to the controller", async () => {
    const app = newApp("api", { automated: { prune: true, selfHeal: true } });
    app.startSync({ at: at(0.5), by: "automated", revision: SHA1 }).finishSync({ at: at(0.6) });
    const h = await harness({ apps: [app], clockStart: T0 - 60_000 });
    await watching(h);
    h.clock.now = T0 + 120_000;
    app.startSync({ at: at(2), by: "automated", revision: SHA2 });
    await h.push(app);
    app.finishSync({ at: at(2.5) });
    await h.push(app);
    const done = byAction(h, "argocd.sync.succeeded").find((e) => e.occurredAt === at(2.5))!;
    expect(done).toMatchObject({
      actor: { type: "system", id: "argocd-application-controller" },
      trigger: { type: "auto_sync", sourceValue: "automated", detail: "git_change" },
      correlation: { commitShas: [SHA2], deploymentIds: ["argocd:argocd/api:1"] },
      data: { autoSync: { reason: "git_change", selfHeal: true } },
      observation: { method: "stream" },
    });
  });

  it("rollback: confirmed by the Kubernetes event, recorded as deployment.rolled_back", async () => {
    const app = newApp();
    app.startSync({ at: at(1), by: "alice", revision: SHA1 }).finishSync({ at: at(1.1) });
    app.startSync({ at: at(1.5), by: "alice", revision: SHA2 }).finishSync({ at: at(1.6) });
    const h = await harness({ apps: [app], clockStart: T0 + 100_000 });
    await watching(h);
    h.fake.addAppEvent(
      "guestbook",
      auditEvent("bob", "initiated rollback to 0", at(3), "OperationStarted"),
    );
    app.rollback({ at: at(3), by: "bob", toId: 0 });
    await h.push(app);
    app.finishSync({ at: at(3.2) });
    await h.push(app);
    const [rb] = byAction(h, "deployment.rolled_back");
    expect(rb).toMatchObject({
      sourceEventId: `rollback:${app.uid}:${at(3).replace(/:/g, "%3A")}`,
      actor: { type: "user", login: "bob" },
      trigger: { type: "rollback" },
      outcome: "succeeded",
      correlation: { commitShas: [SHA1], deploymentIds: ["argocd:argocd/guestbook:2"] },
      data: { toHistoryId: "0", confidence: "high", revision: SHA1 },
    });
    const finished = byAction(h, "argocd.sync.succeeded").find((e) => e.occurredAt === at(3.2))!;
    expect(finished.trigger.type).toBe("rollback");
  });

  it("rollback without a Kubernetes event is inferred from history (medium confidence)", async () => {
    const app = newApp();
    app.startSync({ at: at(1), by: "alice", revision: SHA1 }).finishSync({ at: at(1.1) });
    app.startSync({ at: at(1.5), by: "alice", revision: SHA2 }).finishSync({ at: at(1.6) });
    const h = await harness({ apps: [app], clockStart: T0 + 100_000 });
    await watching(h);
    app.rollback({ at: at(3), by: "bob", toId: 0 });
    await h.push(app);
    app.finishSync({ at: at(3.2) });
    await h.push(app);
    const [rb] = byAction(h, "deployment.rolled_back");
    expect(rb?.data).toMatchObject({ toHistoryId: "0", confidence: "medium" });
  });

  it("explicit sync to an old revision (event says sync) is not called a rollback", async () => {
    const app = newApp();
    app.startSync({ at: at(1), by: "alice", revision: SHA1 }).finishSync({ at: at(1.1) });
    app.startSync({ at: at(1.5), by: "alice", revision: SHA2 }).finishSync({ at: at(1.6) });
    const h = await harness({ apps: [app], clockStart: T0 + 100_000 });
    await watching(h);
    h.fake.addAppEvent(
      "guestbook",
      auditEvent("carol", `initiated sync to ${SHA1}`, at(3), "OperationStarted"),
    );
    app.startSync({ at: at(3), by: "carol", revision: SHA1 });
    await h.push(app);
    expect(byAction(h, "deployment.rolled_back")).toHaveLength(0);
    const [started] = byAction(h, "argocd.sync.started").filter((e) => e.occurredAt === at(3));
    expect(started).toMatchObject({
      trigger: { type: "manual" },
      data: { rollback: { confidence: "low" } },
    });
  });

  it("refresh (hard) is recorded while the annotation is visible", async () => {
    const app = newApp();
    const h = await harness({ apps: [app] });
    await watching(h);
    h.clock.now = T0 + 5 * 60_000;
    h.fake.addAppEvent("guestbook", auditEvent("dave", "requested hard refresh", at(4.9)));
    app.requestRefresh("hard");
    await h.push(app);
    await h.push(app); // still annotated: no second event
    app.clearRefresh(at(5));
    await h.push(app);
    const refreshes = byAction(h, "argocd.application.refreshed");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({
      actor: { type: "user", login: "dave" },
      outcome: "none",
      data: { refreshType: "hard", confidence: "certain" },
    });
  });

  it("application update with an image override records the change and who made it", async () => {
    const app = newApp();
    const h = await harness({ apps: [app] });
    await watching(h);
    h.clock.now = T0 + 6 * 60_000;
    h.fake.addAppEvent("guestbook", auditEvent("erin", "updated application spec", at(5.9)));
    app.updateSpec((spec) => {
      spec.source!.kustomize = { images: ["ghcr.io/acme/api:hotfix-1022"] };
      spec.source!.helm = { values: "password: hunter2-SECRET" };
      spec.source!.targetRevision = "release-1";
    });
    await h.push(app);
    const [upd] = byAction(h, "argocd.application.updated");
    expect(upd).toMatchObject({
      sourceEventId: expect.stringMatching(new RegExp(`^application:${app.uid}:updated:1:`)),
      actor: { type: "user", login: "erin" },
      occurredAt: at(5.9),
      correlation: { imageRefs: ["ghcr.io/acme/api:hotfix-1022"] },
      data: {
        change: {
          fields: expect.arrayContaining([
            "source.helm.values",
            "source.kustomize.images",
            "source.targetRevision",
          ]),
          summary: { targetRevision: { from: "main", to: "release-1" } },
          imageOverrides: ["source.kustomize.images=ghcr.io/acme/api:hotfix-1022"],
        },
      },
    });
    // Helm values are never stored (data minimisation), neither in data nor raw payloads.
    expect(JSON.stringify(h.events())).not.toContain("hunter2");
    for (const p of h.sink.rawPayloads.values()) {
      expect(Buffer.from(p.body).toString()).not.toContain("hunter2");
    }
  });

  it("application delete: deletion requested, then deleted, attributed", async () => {
    const app = newApp();
    const h = await harness({ apps: [app] });
    await watching(h);
    h.clock.now = T0 + 7 * 60_000;
    h.fake.addAppEvent(
      "guestbook",
      auditEvent("frank", "deleted application", at(7), "ResourceDeleted"),
    );
    app.requestDeletion(at(7));
    await h.push(app);
    h.fake.remove("guestbook");
    await waitFor(() => !!h.store.apps.get(app.uid)?.deletedAt, "deleted");
    const del = byAction(h, "argocd.application.deleted");
    expect(del.map((e) => e.outcome)).toEqual(["in_progress", "succeeded"]);
    expect(del[1]).toMatchObject({
      sourceEventId: `application:${app.uid}:deleted`,
      actor: { type: "user", login: "frank" },
      observation: { method: "stream", detail: "watch DELETED" },
      data: { evidence: "watch DELETED event", confidence: "certain" },
    });
    expect(del[0]!.data).toMatchObject({ cascade: true });
  });

  it("health and sync status: only transitions are emitted, with the current sync's keys", async () => {
    const app = newApp();
    app
      .startSync({ at: at(0.5), by: "alice", revision: SHA1 })
      .finishSync({ at: at(0.6), images: ["ghcr.io/acme/api:1"] });
    const h = await harness({ apps: [app], clockStart: T0 + 60_000 });
    await watching(h);
    app.setHealth("Degraded", at(2));
    await h.push(app);
    app.setHealth("Degraded", at(3)); // same status: no event
    await h.push(app);
    app.setSyncStatus("OutOfSync", at(4), SHA2);
    await h.push(app);
    const health = byAction(h, "argocd.health.changed");
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({
      actor: { type: "system" },
      occurredAt: at(2),
      data: { from: "Healthy", to: "Degraded" },
      correlation: {
        commitShas: [SHA1],
        repositories: ["github.com/acme/deploy"],
        imageRefs: ["ghcr.io/acme/api:1"],
        deploymentIds: ["argocd:argocd/guestbook:0"],
      },
    });
    const sync = byAction(h, "argocd.sync_status.changed");
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({ data: { from: "Synced", to: "OutOfSync", revision: SHA2 } });
  });

  it("sync operation results: failed and terminated", async () => {
    const app = newApp();
    const h = await harness({ apps: [app] });
    await watching(h);
    h.clock.now = T0 + 10 * 60_000;
    app.startSync({ at: at(8), by: "alice", revision: SHA1 });
    await h.push(app);
    app.finishSync({
      at: at(8.5),
      phase: "Failed",
      message: "one or more objects failed to apply",
    });
    await h.push(app);
    h.fake.addAppEvent("guestbook", auditEvent("gina", "terminated running operation", at(9.5)));
    app.startSync({ at: at(9), by: "alice", revision: SHA2 });
    await h.push(app);
    app.terminate(at(9.5));
    await h.push(app);
    expect(byAction(h, "argocd.sync.failed")[0]).toMatchObject({
      outcome: "failed",
      occurredAt: at(8.5),
    });
    expect(byAction(h, "argocd.sync.terminated")[0]).toMatchObject({
      outcome: "cancelled",
      data: { terminatedBy: "gina" },
    });
  });

  it("multi-source apps carry every revision with its repository", async () => {
    const app = newApp("multi", {
      sources: [
        { repoURL: "https://github.com/acme/charts.git", path: "api", targetRevision: "main" },
        { repoURL: "https://github.com/acme/values.git", targetRevision: "main", ref: "values" },
      ],
    });
    const h = await harness({ apps: [app] });
    await watching(h);
    app.startSync({ at: at(2), by: "alice", revisions: [SHA1, SHA2] });
    await h.push(app);
    app.finishSync({ at: at(3) });
    await h.push(app);
    expect(byAction(h, "argocd.sync.succeeded")[0]).toMatchObject({
      correlation: {
        commitShas: [SHA1, SHA2],
        repositories: ["github.com/acme/charts", "github.com/acme/values"],
      },
      data: {
        revisions: [SHA1, SHA2],
        sources: [
          { repoURL: "https://github.com/acme/charts.git", revision: SHA1 },
          { repoURL: "https://github.com/acme/values.git", revision: SHA2 },
        ],
      },
    });
  });
});

describe("ArgoCD capture: outages, reconciliation and idempotency", () => {
  it("recovers what happened while the stream was down, flagged as reconciliation", async () => {
    const app = newApp("api", { automated: { prune: false, selfHeal: false } });
    const h = await harness({ apps: [app] });
    await watching(h);
    app.startSync({ at: at(2), by: "alice", revision: SHA1 });
    await h.push(app);

    // Outage: the stream drops and the API is unavailable for a while.
    h.fake.setUnavailable(true);
    await waitFor(() => h.observations.some((o) => !o.ok && o.via === "stream"), "failure report");
    h.clock.now = T0 + 20 * 60_000;
    app.finishSync({ at: at(3) });
    app.startSync({ at: at(5), by: "automated", revision: SHA2 }).finishSync({ at: at(6) });
    app.startSync({ at: at(7), by: "bob", revision: SHA3 }).finishSync({ at: at(8) });
    app.setHealth("Degraded", at(9));
    h.fake.apply(app.snapshot(), { emit: false });

    // Recovery: the watch reconnects and reconciles.
    h.fake.setUnavailable(false);
    await waitFor(() => byAction(h, "argocd.sync.succeeded").length === 3, "recovered syncs");
    const recoveredHealth = () =>
      byAction(h, "argocd.health.changed").filter((e) => e.observation.method === "reconciliation");
    await waitFor(() => recoveredHealth().length === 1, "health");
    const failure = h.observations.find((o) => !o.ok);
    expect(failure).toMatchObject({ ok: false, via: "stream", reason: "unreachable" });
    const lastFailure = h.observations
      .map((o, i) => (o.ok ? -1 : i))
      .reduce((a, b) => Math.max(a, b));
    expect(h.observations.slice(lastFailure + 1).some((o) => o.ok && o.via === "poll")).toBe(true);

    const syncs = byAction(h, "argocd.sync.succeeded").sort((x, y) =>
      x.occurredAt.localeCompare(y.occurredAt),
    );
    expect(
      syncs.map((e) => [e.occurredAt, e.observation.method, e.actor.login ?? e.actor.id]),
    ).toEqual([
      [at(3), "reconciliation", "alice"],
      [at(6), "reconciliation", "argocd-application-controller"],
      [at(8), "reconciliation", "bob"],
    ]);
    // The middle sync is only in history; it is still recorded with its start.
    const recovered = syncs[1]!;
    expect(recovered.data).toMatchObject({ recoveredFrom: "status.history", historyId: "1" });
    expect(recovered.trigger.type).toBe("auto_sync");
    expect(
      byAction(h, "argocd.sync.started")
        .map((e) => e.occurredAt)
        .sort(),
    ).toEqual([at(2), at(5), at(7)]);
    expect(recoveredHealth()[0]).toMatchObject({
      data: {
        from: "Progressing",
        to: "Degraded",
        note: expect.stringContaining("intermediate transitions"),
      },
    });
    // The watch resumed from the last seen resourceVersion.
    const watches = h.fake.requests.filter((r) => r.path === "/api/v1/stream/applications");
    expect(watches.length).toBeGreaterThanOrEqual(2);
    expect(watches.at(-1)!.query).toMatch(/resourceVersion=\d+/);
  });

  it("the same change seen by the stream and by reconciliation is stored once", async () => {
    const app = newApp();
    const h = await harness({ apps: [app] });
    await watching(h);
    app.startSync({ at: at(2), by: "alice", revision: SHA1 });
    await h.push(app);
    app.finishSync({ at: at(3) });
    await h.push(app);
    const before = h.events().length;
    const r = await h.capture.reconcile();
    expect(r.inserted).toBe(0);
    expect(h.events()).toHaveLength(before);

    // Even with no shared state (a second worker racing), keys collide and dedupe.
    const fresh = new ArgoCdCapture({
      tenantId: TENANT,
      connectionId: CONN,
      client: createClientFor(h.fake),
      sink: h.sink,
      store: createMemoryCaptureStateStore(),
      now: () => new Date(h.clock.now),
    });
    const second = await fresh.reconcile();
    expect(second.duplicates).toBeGreaterThan(0);
    const ops = h.events().filter((e) => e.action.startsWith("argocd.sync."));
    expect(ops).toHaveLength(2);
  });

  it("deletions while down are found by absence (404) and flagged as reconciliation", async () => {
    const a = newApp("a");
    const b = newApp("b");
    const h = await harness({ apps: [a, b] });
    await watching(h);
    h.fake.setUnavailable(true);
    h.clock.now = T0 + 30 * 60_000;
    h.fake.remove("a", { emit: false });
    h.fake.setUnavailable(false);
    await waitFor(() => byAction(h, "argocd.application.deleted").length === 1, "deleted");
    expect(byAction(h, "argocd.application.deleted")[0]).toMatchObject({
      sourceEventId: `application:${a.uid}:deleted`,
      target: { id: "argocd/a" },
      observation: { method: "reconciliation" },
      actor: { type: "unknown" },
      data: {
        evidence: "absent from list; GET returned 404",
        confidence: "certain",
        occurredAtApproximate: true,
      },
    });
    await h.capture.reconcile();
    expect(byAction(h, "argocd.application.deleted")).toHaveLength(1);
  });

  it("deletion by absence also works when ArgoCD answers 403 for missing apps, and on re-creation", async () => {
    const a = newApp("a");
    const h = await harness({ apps: [a], missingApplicationStatus: 403 });
    await h.capture.reconcile();
    h.fake.remove("a", { emit: false });
    await h.capture.reconcile();
    expect(byAction(h, "argocd.application.deleted")[0]?.data).toMatchObject({
      confidence: "high",
    });

    const b = newApp("b");
    h.fake.apply(b.snapshot(), { emit: false });
    await h.capture.reconcile();
    const b2 = newApp("b"); // same name, new uid
    h.fake.apply(b2.snapshot(), { emit: false });
    // Make the list miss the old one but GET return the new one.
    await h.capture.reconcile();
    const deleted = byAction(h, "argocd.application.deleted").map((e) => e.data.appUid);
    expect(deleted).toContain(b.uid);
    expect(byAction(h, "argocd.application.created").map((e) => e.data.appUid)).toContain(b2.uid);
  });

  it("older ArgoCD history (no deployStartedAt) does not duplicate a watched sync", async () => {
    const app = newApp("legacy", { legacyHistory: true });
    const h = await harness({ apps: [app] });
    await watching(h);
    app.startSync({ at: at(2), by: "alice", revision: SHA1 });
    await h.push(app);
    app.finishSync({ at: at(3) });
    await h.push(app);
    await h.capture.reconcile();
    expect(byAction(h, "argocd.sync.succeeded")).toHaveLength(1);
    // A sync missed entirely is recovered from history with a history key.
    app.startSync({ at: at(4), by: "bob", revision: SHA2 }).finishSync({ at: at(5) });
    app.startSync({ at: at(6), by: "bob", revision: SHA3 }).finishSync({ at: at(7) });
    h.fake.apply(app.snapshot(), { emit: false });
    await h.capture.reconcile();
    const syncs = byAction(h, "argocd.sync.succeeded");
    expect(syncs).toHaveLength(3);
    expect(syncs.find((e) => e.data.historyId === "1")).toMatchObject({
      sourceEventId: `history:${app.uid}:1`,
      actor: { type: "unknown" },
      data: { actorNote: expect.stringContaining("initiatedBy") },
    });
  });

  it("applications that existed before capture started are recorded as backfill", async () => {
    const app = new FakeApplication({ name: "old", createdAt: at(-600) });
    app.startSync({ at: at(-500), by: "alice", revision: SHA1 }).finishSync({ at: at(-499) });
    const h = await harness({ apps: [app] });
    await h.capture.reconcile();
    const methods = new Set(h.events().map((e) => e.observation.method));
    expect([...methods]).toEqual(["backfill"]);
    expect(byAction(h, "argocd.application.created")).toHaveLength(1);
    expect(byAction(h, "argocd.sync.succeeded")).toHaveLength(1);
  });

  it("reports reconciliation failures without throwing secrets", async () => {
    const h = await harness();
    h.fake.setUnavailable(true);
    await expect(h.capture.reconcile()).rejects.toThrow();
    expect(h.observations.at(-1)).toMatchObject({ ok: false, via: "poll", reason: "unreachable" });
    expect(JSON.stringify(h.observations)).not.toContain("SECRET");
  });

  it("only GET requests are made", async () => {
    const app = newApp();
    const h = await harness({ apps: [app] });
    await watching(h);
    app.startSync({ at: at(2), by: "alice", revision: SHA1 });
    await h.push(app);
    await h.capture.reconcile();
    expect(new Set(h.fake.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
  });
});

function createClientFor(fake: FakeArgoCd) {
  const handle = createArgoCdClient({
    config: { serverUrl: fake.url, caPem: TEST_CA_PEM },
    token: () => new Secret(TOKEN),
    policy: { allowPrivateNetworks: true },
    retries: 0,
  });
  harnessCleanup.push(() => handle.close());
  return handle.client;
}
const harnessCleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (harnessCleanup.length) await harnessCleanup.pop()!();
});
