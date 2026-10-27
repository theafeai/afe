import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import type { CanonicalEvent } from "@afe/core";
import { EnvKeyProvider } from "@afe/core/security";
import { createTestPool } from "@afe/db/testing";
import { getConnection, listEvents } from "@afe/db";
import { FakeVercelApi } from "@afe/connector-vercel/testing";
import { normalizeDeployment, productionChangeEvent } from "@afe/connector-vercel";
import { buildAfe, InlineJobQueue, type AfeConfig, type ServerContext } from "../src/index.ts";
import {
  createVercelModule,
  type VercelObservation,
  VERCEL_POLL_DISPATCH_JOB,
} from "../src/connectors/vercel.ts";
import {
  getVercelProductionState,
  loadVercelPollState,
  putVercelProductionState,
  saveVercelPollState,
} from "../src/connectors/vercel-state.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const KEEP_ALL = { cutoff: () => null, maxWindowMs: null };

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const TEAM = { id: "team_acme", slug: "acme", name: "Acme" };
const USER = { id: "usr_alice", username: "alice" };
const TOKEN = "pat-token-SECRET";
const WHSEC = "account-webhook-secret-SECRET";
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("vercel event capture (server wiring)", () => {
  let pool: pg.Pool;
  let api: FakeVercelApi;
  let app: FastifyInstance;
  let ctx: ServerContext;
  let jobs: InlineJobQueue;
  let module: ReturnType<typeof createVercelModule>;
  let clock = T0;
  let seq = 0;
  let baseline = 0;
  const logs: string[] = [];
  const observations: VercelObservation[] = [];
  const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });

  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM vercel_production_state");
    await pool.query("DELETE FROM vercel_poll_state");
    await pool.query("DELETE FROM connection_credentials");
    await pool.query("DELETE FROM connections");
    await pool.query("DELETE FROM webhook_deliveries");
    clock = T0;
    seq = 0;
    logs.length = 0;
    observations.length = 0;
    baseline = Math.max(
      0,
      ...(await listEvents(pool, "default", { limit: 1000 })).events.map((e) => e.seq),
    );
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
      .grant(TOKEN, USER.id, [TEAM.id]);
    jobs = new InlineJobQueue();
    const config: AfeConfig = {
      databaseUrl: "unused",
      host: "127.0.0.1",
      port: 0,
      logLevel: "info",
      allowPrivateNetworkTargets: false,
      allowInsecureHttpTargets: false,
      publicUrl: "https://afe.example.com",
    };
    module = createVercelModule({
      fetch: api.fetch,
      now: () => clock,
      onObservation: (o) => {
        observations.push(o);
      },
    });
    const built = await buildAfe({
      authProvider: trustedTestAuth(),
      // Fixtures use fixed October 2026 dates: keep them whatever today is
      // (retention has its own tests in retention.test.ts).
      retentionPolicy: KEEP_ALL,
      pool,
      keys,
      jobs,
      config,
      logLevel: "debug",
      logStream: new Writable({
        write(chunk, _e, cb) {
          logs.push(String(chunk));
          cb();
        },
      }),
      connectors: [module],
    });
    app = built.app;
    ctx = built.context;
    jobs.register(built.jobDefinitions);
  });

  /** Events of this test only (earlier tests' events stay in the database). */
  async function events(): Promise<CanonicalEvent[]> {
    return (await listEvents(pool, "default", { limit: 1000 })).events.filter(
      (e) => e.seq > baseline,
    );
  }

  async function connect(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/vercel",
      payload: { token: TOKEN, teamId: TEAM.id, webhookSecret: WHSEC },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().connection.id as string;
    const put = await app.inject({
      method: "PUT",
      url: `/api/connections/vercel/${id}/projects`,
      payload: { projectIds: ["prj_web"] },
    });
    expect(put.statusCode).toBe(200);
    // Selecting projects queues the first poll (backfill).
    expect(jobs.sent.map((j) => j.name)).toEqual(["vercel.poll"]);
    await jobs.drain();
    return id;
  }

  function deploy(id: string, over: Record<string, unknown> = {}, projectId = "prj_web") {
    api.addDeployment(TEAM.id, {
      id,
      name: "web",
      projectId,
      url: `${id}.vercel.app`,
      createdAt: clock + seq++,
      readyState: "READY",
      ready: clock + 2 * MIN,
      aliasAssigned: clock + 2 * MIN,
      source: "git",
      target: "production",
      creator: { uid: USER.id, username: USER.username },
      meta: {
        githubCommitSha: SHA,
        githubCommitRef: "main",
        githubCommitOrg: "acme",
        githubCommitRepo: "web",
      },
      ...over,
    });
  }

  async function sendWebhook(
    type: string,
    deploymentId: string,
    projectId = "prj_web",
    opts: { id?: string; createdAt?: number } = {},
  ) {
    const hook = api.signedWebhook(
      {
        id: opts.id ?? `evt_${type}_${deploymentId}`,
        type,
        createdAt: opts.createdAt ?? clock,
        payload: {
          team: { id: TEAM.id },
          user: { id: USER.id },
          project: { id: projectId },
          deployment: { id: deploymentId, url: `${deploymentId}.vercel.app`, meta: {} },
          target: "production",
        },
      },
      WHSEC,
    );
    const res = await app.inject({ method: "POST", url: `/webhooks/vercel/${TEAM.id}`, ...hook });
    expect(res.statusCode).toBe(200);
    await jobs.drain();
  }

  async function poll() {
    await jobs.send(VERCEL_POLL_DISPATCH_JOB, {});
    await jobs.drain();
  }

  it("ingests webhooks, polls (dispatch → per-connection poll) and dedupes across both", async () => {
    deploy("dpl_a", { createdAt: T0 - 60 * MIN, ready: T0 - 58 * MIN });
    api.setProduction(TEAM.id, "prj_web", "dpl_a");
    const id = await connect();
    // Backfill on first connect.
    expect((await events()).map((e) => [e.sourceEventId, e.observation.method])).toEqual([
      ["deployment:dpl_a:created", "backfill"],
      ["deployment:dpl_a:succeeded", "backfill"],
    ]);
    const state = await loadVercelPollState(pool, "default", id);
    expect(state).toMatchObject({ backfilled: { mode: "selected", projectIds: ["prj_web"] } });
    expect((await getVercelProductionState(pool, "default", id, "prj_web"))!.deploymentId).toBe(
      "dpl_a",
    );

    // Webhook first.
    clock += MIN;
    deploy("dpl_b", { readyState: "BUILDING", ready: null });
    await sendWebhook("deployment.created", "dpl_b");
    // Unselected project: not queued, not ingested.
    deploy("dpl_s", {}, "prj_secret");
    await sendWebhook("deployment.created", "dpl_s", "prj_secret");

    // Webhooks missed: dpl_b finishes and a rollback to dpl_a happens.
    clock += 3 * MIN;
    api.updateDeployment("dpl_b", { readyState: "READY", ready: clock - MIN });
    api.setProduction(TEAM.id, "prj_web", "dpl_b");
    clock += 5 * MIN;
    await poll();
    clock += 5 * MIN;
    api.setProduction(TEAM.id, "prj_web", "dpl_a");
    await poll();
    // The late webhook for the rollback is a duplicate.
    await sendWebhook("deployment.promoted", "dpl_a");

    const all = await events();
    expect(all.map((e) => [e.sourceEventId, e.action, e.observation.method])).toEqual([
      ["deployment:dpl_a:created", "deployment.created", "backfill"],
      ["deployment:dpl_a:succeeded", "deployment.status_updated", "backfill"],
      ["deployment:dpl_b:created", "deployment.created", "webhook"],
      ["deployment:dpl_b:succeeded", "deployment.status_updated", "reconciliation"],
      [
        expect.stringMatching(/^production_alias:prj_web:dpl_b:dpl_a:\d+$/),
        "deployment.rolled_back",
        "reconciliation",
      ],
    ]);
    expect(all.find((e) => e.action === "deployment.rolled_back")).toMatchObject({
      correlation: { commitShas: [SHA], deploymentIds: ["vercel:dpl_a", "vercel:dpl_b"] },
      data: { confidence: "inferred", aliasAssigned: true },
    });
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
    expect(api.requests.some((r) => JSON.stringify(r).includes("prj_secret"))).toBe(false);
    expect(observations.some((o) => o.ok && o.kind === "webhook")).toBe(true);
    expect(observations.filter((o) => o.kind === "poll").every((o) => o.ok)).toBe(true);
    expect(logs.join("")).not.toContain("SECRET");
  });

  const aliasEvents = async () =>
    (await events()).filter(
      (e) => e.action === "deployment.promoted" || e.action === "deployment.rolled_back",
    );

  it("records repeated identical production changes once each, across webhook and poll (AFE-30)", async () => {
    deploy("dpl_a", { createdAt: T0 - 60 * MIN, ready: T0 - 58 * MIN });
    deploy("dpl_b", { target: null, createdAt: T0 - 30 * MIN, ready: T0 - 28 * MIN });
    api.setProduction(TEAM.id, "prj_web", "dpl_a");
    const id = await connect(); // baseline: dpl_a

    // A→B: webhook first, then poll.
    clock += 5 * MIN;
    api.setProduction(TEAM.id, "prj_web", "dpl_b");
    await sendWebhook("deployment.promoted", "dpl_b", "prj_web", { id: "evt_1" });
    clock += 5 * MIN;
    await poll();
    // B→A: poll first, then the (late) webhook.
    clock += 5 * MIN;
    api.setProduction(TEAM.id, "prj_web", "dpl_a");
    const rolledBackAt = clock;
    clock += 3 * MIN;
    await poll();
    await sendWebhook("deployment.promoted", "dpl_a", "prj_web", {
      id: "evt_2",
      createdAt: rolledBackAt,
    });
    // A→B again.
    clock += 5 * MIN;
    api.setProduction(TEAM.id, "prj_web", "dpl_b");
    await sendWebhook("deployment.promoted", "dpl_b", "prj_web", { id: "evt_3" });
    clock += 5 * MIN;
    await poll();

    const alias = await aliasEvents();
    expect(
      alias.map((e) => [e.data.fromDeploymentId, e.data.toDeploymentId, e.observation.method]),
    ).toEqual([
      ["dpl_a", "dpl_b", "webhook"],
      ["dpl_b", "dpl_a", "reconciliation"],
      ["dpl_a", "dpl_b", "webhook"],
    ]);
    expect(new Set(alias.map((e) => e.sourceEventId)).size).toBe(3);
    const state = (await getVercelProductionState(pool, "default", id, "prj_web"))!;
    expect(state.deploymentId).toBe("dpl_b");
    expect(state.changes.map((c) => c.key).slice(1)).toEqual(alias.map((e) => e.sourceEventId));
  });

  it("upgrade: a production state row stored before migration 0015 is the baseline (AFE-30)", async () => {
    deploy("dpl_a", { createdAt: T0 - 60 * MIN, ready: T0 - 58 * MIN });
    deploy("dpl_b", { target: null, createdAt: T0 - 30 * MIN, ready: T0 - 28 * MIN });
    api.setProduction(TEAM.id, "prj_web", "dpl_b");
    const id = await connect();
    // Replace the state with a row as written before AFE-30 (no `changes`),
    // and the event recorded then under the old key.
    await pool.query("DELETE FROM vercel_production_state");
    await pool.query(
      `INSERT INTO vercel_production_state
         (tenant_id, connection_id, project_id, deployment_id, deployment_created_at,
          previous_deployment_id, previous_deployment_created_at, last_seen_at, changed_at)
       VALUES ('default', $1, 'prj_web', 'dpl_b', $2, 'dpl_a', $3, $4, $4)`,
      [id, new Date(T0 - 30 * MIN), new Date(T0 - 60 * MIN), new Date(T0)],
    );
    expect((await getVercelProductionState(pool, "default", id, "prj_web"))!.changes).toEqual([]);
    const legacyKey = "production_alias:prj_web:dpl_a:dpl_b";
    await ctx.sink.ingest(
      "default",
      productionChangeEvent({
        projectId: "prj_web",
        deployment: normalizeDeployment({ id: "dpl_b", projectId: "prj_web", target: null }),
        change: {
          kind: "promotion",
          confidence: "inferred",
          reason: "recorded before AFE-30",
          fromDeploymentId: "dpl_a",
          occurredAt: null,
        },
        provenance: { method: "reconciliation", observedAt: new Date(T0), connectionId: id },
        occurrence: { source: "observed", at: T0, notBefore: null },
        sourceEventId: legacyKey,
        raw: {},
      }),
    );

    // Polls and a late webhook for that change emit nothing new.
    clock += MIN;
    await poll();
    await sendWebhook("deployment.promoted", "dpl_b", "prj_web", { id: "late", createdAt: T0 });
    expect((await aliasEvents()).map((e) => e.sourceEventId)).toEqual([legacyKey]);

    // Later changes, including A→B again, get occurrence-qualified keys.
    for (const to of ["dpl_a", "dpl_b"]) {
      clock += 5 * MIN;
      api.setProduction(TEAM.id, "prj_web", to);
      clock += 5 * MIN;
      await poll();
    }
    const alias = await aliasEvents();
    expect(alias.map((e) => e.sourceEventId)).toEqual([
      legacyKey,
      expect.stringMatching(/^production_alias:prj_web:dpl_b:dpl_a:\d+$/),
      expect.stringMatching(/^production_alias:prj_web:dpl_a:dpl_b:\d+$/),
    ]);
  });

  it("re-observes a gap through the health backfill hook", async () => {
    const id = await connect();
    clock += 30 * MIN;
    deploy("dpl_gap", { createdAt: T0 + 5 * MIN, ready: T0 + 7 * MIN });
    const conn = (await getConnection(pool, "default", id))!;
    await module.health!(ctx).backfill!(conn, new Date(T0), new Date(T0 + 20 * MIN));
    const all = await events();
    expect(all.map((e) => [e.sourceEventId, e.observation.method])).toEqual([
      ["deployment:dpl_gap:created", "reconciliation"],
      ["deployment:dpl_gap:succeeded", "reconciliation"],
    ]);
    expect(observations.at(-1)).toMatchObject({ ok: true, kind: "reconcile" });
  });

  it("reports failures to the observation callback and revokes on 401", async () => {
    const id = await connect();
    api.rateLimitNext = 10;
    clock += 5 * MIN;
    await expect(poll()).rejects.toThrow(/429/);
    expect(observations.at(-1)).toMatchObject({ ok: false, kind: "poll", reason: "rate_limited" });
    const before = await loadVercelPollState(pool, "default", id);

    api.rateLimitNext = 0;
    api.revoke(TOKEN);
    await poll(); // not retried: the connection is revoked
    expect(observations.at(-1)).toMatchObject({ ok: false, kind: "poll", reason: "auth_failed" });
    expect((await getConnection(pool, "default", id))!.status).toBe("revoked");
    // The cursor did not move on failure.
    expect(await loadVercelPollState(pool, "default", id)).toEqual(before);
    // Revoked connections are no longer polled.
    jobs.sent.length = 0;
    await jobs.send(VERCEL_POLL_DISPATCH_JOB, {});
    await jobs.drain();
    expect(logs.join("")).not.toContain("SECRET");
  });

  it("reports observations to connection health by default", async () => {
    const id = await connect();
    const reports: unknown[][] = [];
    const defaultModule = createVercelModule({ fetch: api.fetch, now: () => clock });
    const built = await buildAfe({
      authProvider: trustedTestAuth(),
      // Fixtures use fixed October 2026 dates: keep them whatever today is
      // (retention has its own tests in retention.test.ts).
      retentionPolicy: KEEP_ALL,
      pool,
      keys,
      jobs: new InlineJobQueue(),
      config: ctx.config,
      logLevel: "silent",
      connectors: [defaultModule],
    });
    built.context.health = {
      reportSuccess: async (...args) => void reports.push(["success", ...args]),
      reportFailure: async (...args) => void reports.push(["failure", ...args]),
      canAttempt: async () => true,
    };
    const q = built.context.jobs as InlineJobQueue;
    q.register(built.jobDefinitions);

    clock += 5 * MIN;
    await q.send(VERCEL_POLL_DISPATCH_JOB, {});
    await q.drain();
    expect(reports.at(-1)).toMatchObject([
      "success",
      "default",
      id,
      new Date(clock),
      { via: "poll" },
    ]);

    api.rateLimitNext = 10;
    clock += 5 * MIN;
    await q.send(VERCEL_POLL_DISPATCH_JOB, {});
    await expect(q.drain()).rejects.toThrow(/429/);
    expect(reports.at(-1)?.slice(0, 4)).toMatchObject(["failure", "default", id, "rate_limited"]);
    api.rateLimitNext = 0;
    await built.app.close();
  });

  it("keeps capture state per tenant (R5.10)", async () => {
    const id = await connect();
    const s = {
      deploymentId: "dpl_x",
      deploymentCreatedAt: null,
      previousDeploymentId: null,
      previousDeploymentCreatedAt: null,
      lastSeenAt: T0,
      changedAt: T0,
      changes: [],
    };
    await putVercelProductionState(pool, "default", id, "prj_web", s);
    expect(await getVercelProductionState(pool, "tenant-b", id, "prj_web")).toBeNull();
    expect(await loadVercelPollState(pool, "tenant-b", id)).toBeNull();
    await expect(
      saveVercelPollState(
        pool,
        "tenant-b",
        id,
        { cursor: 1, openDeployments: [], backfilled: { mode: "none" } },
        T0,
      ),
    ).rejects.toThrow(); // no such connection in tenant-b (foreign key)
    expect((await loadVercelPollState(pool, "default", id))!.cursor).not.toBe(1);
  });
});
