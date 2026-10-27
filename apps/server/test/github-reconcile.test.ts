/**
 * AFE-8: GitHub reconciliation polling and backfill, server wiring:
 * scheduler -> github.reconcile-repo jobs -> audit log (PostgreSQL), poll
 * state (migration 0013), health reporting, first-install and gap backfill.
 * GitHub is a local fake (no network).
 */
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { CanonicalEvent, Connection, HealthReporter } from "@afe/core";
import { EnvKeyProvider, Secret, signHmac } from "@afe/core/security";
import {
  createPgEventSink,
  getConnection,
  listEvents,
  upsertConnection,
  verifyTenantChain,
} from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { GitHubRateLimitError, type GitHubAppConfig } from "@afe/connector-github";
import { FakeGitHubApi } from "../../../packages/connector-github/test/fake-repo-api.ts";
import {
  installationFixture,
  testKeyPair,
} from "../../../packages/connector-github/test/fixtures.ts";
import { loadWebhook } from "../../../packages/connector-github/test/fixtures/webhooks.ts";
import {
  NOW,
  SCENARIO_WEBHOOKS,
  orgActivity,
  restRun,
  webhookEvents,
} from "../../../packages/connector-github/test/reconcile-scenario.ts";
import { buildAfe, InlineJobQueue, type AfeApp } from "../src/index.ts";
import {
  GITHUB_JOBS,
  createGitHubModule,
  githubRuntime,
  runReconcileRepoJob,
  scheduleReconciliation,
  type GitHubModuleOptions,
  type GitHubReconcileRepoJob,
} from "../src/connectors/github.ts";
import type { ConnectorModule } from "../src/context.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const WEBHOOK_SECRET = "whsec-AFE8-TEST-SECRET";
const TOKEN = "ghs_FAKE_INSTALLATION_TOKEN_AFE8";
const { privatePem } = testKeyPair();
const appConfig: GitHubAppConfig = {
  appId: "77",
  slug: "afe-test",
  privateKey: new Secret(privatePem),
  webhookSecret: new Secret(WEBHOOK_SECRET),
};
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });

describe("GitHub reconciliation and backfill (AFE-8)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let module: ConnectorModule;
  let jobs: InlineJobQueue;
  let api: FakeGitHubApi;
  let logLines: string[];
  let healthCalls: unknown[][];
  let canAttempt: boolean;
  let connection: Connection;
  let deliveries = 0;
  let tenants = 0;
  // A tenant per test: the append-only log (and its idempotency keys) outlives each test.
  let tenant = "afe8-0";

  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  async function start(options: Partial<GitHubModuleOptions> = {}) {
    api = new FakeGitHubApi();
    jobs = new InlineJobQueue();
    logLines = [];
    module = createGitHubModule({
      app: appConfig,
      http: { fetch: api.fetch, sleep: async () => {}, clock: () => NOW.getTime() },
      clock: () => NOW.getTime(),
      env: {},
      adoptInstallationsInto: tenant,
      ...options,
      reconcile: { backfillDays: 0, ...options.reconcile },
    });
    afe = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      jobs,
      sink: createPgEventSink(pool),
      keys,
      logLevel: "debug",
      logStream: new Writable({
        write(chunk, _enc, cb) {
          logLines.push(String(chunk));
          cb();
        },
      }),
      connectors: [module],
    });
    jobs.register(afe.jobDefinitions);
    healthCalls = [];
    canAttempt = true;
    const health: HealthReporter = {
      reportSuccess: async (...args) => void healthCalls.push(["success", ...args]),
      reportFailure: async (...args) => void healthCalls.push(["failure", ...args]),
      canAttempt: async () => canAttempt,
    };
    afe.context.health = health;
  }

  async function connect(
    repositories: unknown = [{ id: 11, fullName: "acme/api" }],
    permissions: Record<string, string> = installationFixture().permissions,
  ) {
    connection = await upsertConnection(pool, tenant, {
      source: "github",
      externalId: "4242",
      name: "acme",
      status: "active",
      config: {
        ...installationFixture(),
        installationId: 4242,
        repositories,
        permissions,
      } as never,
    });
  }

  beforeEach(async () => {
    await pool.query("DELETE FROM connections; DELETE FROM webhook_deliveries");
    tenant = `afe8-${++tenants}-${Date.now()}`;
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1)", [tenant]);
    await start();
    // A repository that is not selected on the connection.
    api.repo("acme/secret", 13).runs.push({ ...restRun("workflow_run.push.completed"), id: 777 });
  });

  afterEach(async () => {
    await afe.app.close();
    const logs = logLines.join("");
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(WEBHOOK_SECRET);
    expect(logs).not.toContain("@example.com");
  });

  const rt = () => githubRuntime(afe.context)!;
  const allEvents = async (): Promise<CanonicalEvent[]> =>
    (await listEvents(pool, tenant, { limit: 1000 })).events;
  /** GitHub events of this test's connection (the append-only log outlives each test). */
  const github = async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM connections WHERE source = 'github'",
    );
    const ids = new Set(rows.map((r) => r.id));
    return (await allEvents()).filter((e) => e.source === "github" && ids.has(e.connectionId!));
  };
  const repoJob = (repositoryId = 11, fullName = "acme/api"): GitHubReconcileRepoJob => ({
    tenantId: tenant,
    connectionId: connection.id,
    repositoryId,
    fullName,
  });

  function sendWebhook(event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return afe.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": `afe8-${++deliveries}`,
        "x-hub-signature-256": signHmac("sha256", WEBHOOK_SECRET, body, "sha256="),
      },
      payload: body,
    });
  }

  it("webhooks switched off: every run and deployment is in the audit log, flagged reconciled", async () => {
    orgActivity(api);
    await connect();
    await jobs.send(GITHUB_JOBS.RECONCILE, {});
    const queued: string[] = [];
    const send = jobs.send.bind(jobs);
    jobs.send = async (name, data, options) => {
      queued.push(`${name}:${(data as { repositoryId?: number }).repositoryId ?? ""}`);
      return send(name, data, options);
    };
    await jobs.drain();
    expect(queued).toEqual([`${GITHUB_JOBS.RECONCILE_REPO}:11`]);

    const events = await github();
    const keys = new Set(events.map((e) => e.sourceEventId));
    for (const e of webhookEvents(SCENARIO_WEBHOOKS)) expect(keys.has(e.sourceEventId)).toBe(true);
    const runs = new Set(
      events.filter((e) => e.target.type === "workflow_run").map((e) => e.target.id),
    );
    expect(runs.size).toBe(8);
    expect(events.filter((e) => e.target.type === "deployment").length).toBe(3);
    for (const e of events) {
      expect(e.observation.method).toBe("reconciliation");
      expect(e.observation.detail).toMatch(/^discovered by reconciliation/);
      expect(e.connectionId).toBe(connection.id);
    }
    expect((await verifyTenantChain(pool, tenant)).ok).toBe(true);
    // Unselected repository never read.
    expect(api.requests.some((r) => r.path.includes("acme/secret"))).toBe(false);
    expect(healthCalls).toContainEqual(["success", tenant, connection.id, NOW, { via: "poll" }]);
    expect(logLines.join("")).toContain("recorded events missed by webhooks");
  });

  it("stores ETags in github_poll_state: an unchanged repository costs no rate limit", async () => {
    orgActivity(api);
    await connect();
    await runReconcileRepoJob(rt(), repoJob());
    const { rows } = await pool.query(
      "SELECT endpoint, etag FROM github_poll_state WHERE connection_id = $1 ORDER BY endpoint",
      [connection.id],
    );
    expect(rows.map((r) => r.endpoint)).toEqual(
      expect.arrayContaining(["repo", "deployments#1", "runs?created>=2026-10-25#1"]),
    );
    expect(rows.find((r) => r.endpoint === "deployments#1")!.etag).toMatch(/^W\//);
    const count = (await github()).length;
    api.reset_requests();
    await runReconcileRepoJob(rt(), repoJob());
    const calls = api.apiRequests;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((r) => r.status === 304)).toBe(true);
    expect((await github()).length).toBe(count);
  });

  it("schedules each repository once per interval, spread out, and skips connections backing off", async () => {
    orgActivity(api);
    await connect("all");
    api.installationRepositories = [
      { id: 11, full_name: "acme/api" },
      { id: 13, full_name: "acme/secret" },
    ];
    const first = await scheduleReconciliation(rt());
    expect(first.enqueued).toBe(2);
    const sent = jobs.sent.filter((j) => j.name === GITHUB_JOBS.RECONCILE_REPO);
    expect(sent.map((j) => (j.data as GitHubReconcileRepoJob).fullName)).toEqual([
      "acme/api",
      "acme/secret",
    ]);
    // Spread over the 5 minute interval.
    expect(sent.map((j) => j.options.startAfter)).toEqual([NOW, new Date(NOW.getTime() + 150_000)]);
    // Not due again within the interval.
    expect((await scheduleReconciliation(rt())).enqueued).toBe(0);
    // The installation's repository list was read with a conditional request the second time.
    const listings = api.requests.filter((r) => r.path === "/installation/repositories");
    expect(listings.map((r) => r.status)).toEqual([200, 304]);

    await pool.query("DELETE FROM github_poll_state");
    canAttempt = false;
    expect((await scheduleReconciliation(rt())).enqueued).toBe(0);
  });

  it("does not read repositories that are not selected", async () => {
    await connect();
    const outcome = await runReconcileRepoJob(rt(), repoJob(13, "acme/secret"));
    expect(outcome).toMatchObject({ status: "skipped", reason: "repository not selected" });
    expect(api.apiRequests).toHaveLength(0);
  });

  it("rate limit exhaustion: reports rate_limited with retryAfter and reschedules the pass", async () => {
    orgActivity(api);
    await connect();
    api.exhaustAfter = 0;
    const outcome = await runReconcileRepoJob(rt(), repoJob());
    const reset = new Date(api.reset * 1000);
    expect(outcome).toMatchObject({ status: "rate_limited", retryAfter: reset });
    expect(healthCalls).toContainEqual([
      "failure",
      tenant,
      connection.id,
      "rate_limited",
      "GitHub rate limit exhausted",
      reset,
      NOW,
    ]);
    const again = jobs.sent.find((j) => j.name === GITHUB_JOBS.RECONCILE_REPO)!;
    expect(again.data).toEqual(repoJob());
    expect(again.options.startAfter).toEqual(reset);
    expect(await github()).toHaveLength(0);
    // While the bucket is empty, the next attempt makes no request.
    const before = api.requests.length;
    await runReconcileRepoJob(rt(), repoJob());
    expect(api.requests.length).toBe(before);
  });

  it("first install: the installation webhook enqueues a one-time history backfill", async () => {
    await afe.app.close();
    await start({ reconcile: { backfillDays: 30 } });
    const repo = orgActivity(api);
    // Older than the 30-day window.
    repo.runs.push({
      ...restRun("workflow_run.schedule.completed"),
      id: 9100099,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:05:00Z",
    });
    const installed = {
      action: "created",
      installation: installationFixture(),
      repositories: [{ id: 11, name: "api", full_name: "acme/api" }],
      sender: { id: 501, login: "octocat", type: "User" },
    };
    expect((await sendWebhook("installation", installed)).statusCode).toBe(200);
    const backfills = jobs.sent.filter((j) => j.name === GITHUB_JOBS.BACKFILL);
    expect(backfills).toHaveLength(1);
    expect(backfills[0]!.data).toMatchObject({
      kind: "install",
      from: "2026-09-26T13:00:00.000Z",
      to: NOW.toISOString(),
    });
    await jobs.drain();

    const events = await github();
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((e) => e.observation.method === "backfill")).toBe(true);
    const keys = new Set(events.map((e) => e.sourceEventId));
    for (const e of webhookEvents(SCENARIO_WEBHOOKS)) expect(keys.has(e.sourceEventId)).toBe(true);
    expect(keys.has("workflow_run:9100099:1:requested")).toBe(false);
    const { rows } = await pool.query("SELECT status FROM github_backfills");
    expect(rows).toEqual([{ status: "succeeded" }]);
    expect(
      healthCalls.some((c) => c[0] === "success" && (c[4] as { via: string }).via === "backfill"),
    ).toBe(true);

    // Not again: a redelivered/second installation webhook, or the scheduler.
    jobs.sent.length = 0;
    await sendWebhook("installation", installed);
    const conn = (await pool.query("SELECT id FROM connections")).rows[0].id as string;
    connection = (await getConnection(pool, tenant, conn))!;
    await scheduleReconciliation(rt());
    expect(jobs.sent.filter((j) => j.name === GITHUB_JOBS.BACKFILL)).toHaveLength(0);
  });

  it("the scheduler enqueues the install backfill for connections that never had one", async () => {
    await afe.app.close();
    await start({ reconcile: { backfillDays: 7 } });
    await connect();
    await scheduleReconciliation(rt());
    expect(jobs.sent.filter((j) => j.name === GITHUB_JOBS.BACKFILL)).toHaveLength(1);
    await scheduleReconciliation(rt());
    expect(jobs.sent.filter((j) => j.name === GITHUB_JOBS.BACKFILL)).toHaveLength(1);
  });

  it("gap backfill hook: re-reads the gap window and flags what it finds as reconciled", async () => {
    await afe.app.close();
    await start({ reconcile: { lookbackMs: 3600_000 } });
    orgActivity(api);
    await connect();
    const hooks = module.health!(afe.context);
    const from = new Date("2026-10-26T10:30:00Z");
    const to = new Date("2026-10-26T12:00:00Z");
    await hooks.backfill!(connection, from, to);
    const events = await github();
    const keys = new Set(events.map((e) => e.sourceEventId));
    // Runs created from one lookback before the gap: 10:00 and 11:00, not 03:00.
    expect(keys.has("workflow_run:9100001:1:completed")).toBe(true);
    expect(keys.has("workflow_run:9100003:1:in_progress")).toBe(true);
    expect(keys.has("workflow_run:9100005:1:requested")).toBe(false);
    expect(keys.has("deployment:880001:created")).toBe(true);
    for (const e of events) {
      expect(e.observation.method).toBe("reconciliation");
      expect(e.observation.detail).toContain("observation gap 2026-10-26T10:30:00.000Z");
    }
    // Backfills read unconditionally and do not touch the routine poll state.
    expect(api.apiRequests.some((r) => r.conditional)).toBe(false);

    api.exhaustAfter = 0;
    api.remaining = 5000;
    await expect(hooks.backfill!(connection, from, to)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
    expect(healthCalls.some((c) => c[0] === "failure" && c[3] === "rate_limited")).toBe(true);
  });

  it("webhook first, then poll: delivered events are not duplicated", async () => {
    orgActivity(api);
    await connect();
    const f = loadWebhook("workflow_run.push.completed");
    expect((await sendWebhook(f.event, f.payload)).statusCode).toBe(202);
    await jobs.drain();
    await runReconcileRepoJob(rt(), repoJob());
    const events = await github();
    const completed = events.filter((e) => e.sourceEventId === "workflow_run:9100001:1:completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.observation.method).toBe("webhook");
    // The requested transition the webhook path never saw is filled in by reconciliation.
    const requested = events.find((e) => e.sourceEventId === "workflow_run:9100001:1:requested")!;
    expect(requested.observation.method).toBe("reconciliation");
    expect(new Set(events.map((e) => e.sourceEventId)).size).toBe(events.length);
  });

  it("poll first, then webhook: the later delivery dedupes", async () => {
    orgActivity(api);
    await connect();
    await runReconcileRepoJob(rt(), repoJob());
    const before = (await github()).length;
    const f = loadWebhook("deployment_status.success");
    expect((await sendWebhook(f.event, f.payload)).statusCode).toBe(202);
    await jobs.drain();
    expect((await github()).length).toBe(before);
    const status = (await github()).find((e) => e.sourceEventId === "deployment_status:990001")!;
    expect(status.observation.method).toBe("reconciliation");
  });

  it("can be disabled", async () => {
    await afe.app.close();
    await start({ reconcile: { enabled: false } });
    orgActivity(api);
    await connect();
    expect(await scheduleReconciliation(rt())).toMatchObject({ enqueued: 0 });
    expect(api.requests).toHaveLength(0);
  });
});
