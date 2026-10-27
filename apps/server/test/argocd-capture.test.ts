import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { DEFAULT_TENANT_ID, type Connection } from "@afe/core";
import { EnvKeyProvider } from "@afe/core/security";
import { getConnection, verifyTenantChain } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import type { CaptureObservation } from "@afe/connector-argocd";
import {
  FakeApplication,
  TEST_CA_PEM,
  startFakeArgoCd,
  type FakeArgoCd,
} from "@afe/connector-argocd/testing";
import { InlineJobQueue, buildAfe, loadConfig, type ServerContext } from "../src/index.ts";
import {
  ARGOCD_RECONCILE_JOB,
  ARGOCD_WATCH_JOB,
  createArgoCdModule,
  watchArgoCdConnection,
  type ArgoCdModuleOptions,
} from "../src/connectors/argocd.ts";
import { createPgCaptureStateStore } from "../src/connectors/argocd-state.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const TOKEN = "afe-capture-token-SECRET";
const SHA1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA3 = "cccccccccccccccccccccccccccccccccccccccc";

interface Row {
  action: string;
  method: string;
  source_event_id: string;
  occurred_at: Date;
  actor: { type: string; login?: string; id?: string };
}

describe("ArgoCD capture jobs (database)", () => {
  let pool: pg.Pool;
  let fake: FakeArgoCd;
  let app: FastifyInstance;
  let ctx: ServerContext;
  let jobs: InlineJobQueue;
  let connection: Connection;
  const logs: string[] = [];
  const observations: CaptureObservation[] = [];
  const t = (sec: number) => new Date(start + sec * 1000).toISOString();
  let start = 0;
  const options: ArgoCdModuleOptions = {
    retries: 0,
    requeueWatch: false,
    watchSliceMs: 60_000,
    watchBackoffMs: () => 20,
    onObservation: (_ctx, _c, o) => {
      observations.push(o);
    },
  };
  const module = createArgoCdModule(options);
  const old = new FakeApplication({ name: "legacy-app", createdAt: "2026-01-01T00:00:00Z" });
  old
    .startSync({ at: "2026-01-02T00:00:00Z", by: "alice", revision: SHA1 })
    .finishSync({ at: "2026-01-02T00:01:00Z" });

  const rows = async (): Promise<Row[]> =>
    (
      await pool.query<Row>(
        `SELECT action, observation->>'method' AS method, source_event_id, occurred_at, actor
         FROM events WHERE tenant_id = $1 AND source = 'argocd' ORDER BY seq`,
        [DEFAULT_TENANT_ID],
      )
    ).rows;

  async function waitFor(cond: () => Promise<boolean>, what: string, ms = 8000) {
    const until = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    pool = await createTestPool();
    fake = await startFakeArgoCd({ accounts: { [TOKEN]: { username: "afe" } }, applications: [] });
    fake.apply(old.snapshot(), { emit: false });
    jobs = new InlineJobQueue();
    const built = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "debug",
      logStream: new Writable({
        write(chunk, _e, cb) {
          logs.push(String(chunk));
          cb();
        },
      }),
      keys: new EnvKeyProvider({ keys: { default: randomBytes(32) } }),
      jobs,
      config: loadConfig({ DATABASE_URL: "unused", AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "true" }),
      connectors: [module],
    });
    app = built.app;
    ctx = built.context;
    jobs.register(built.jobDefinitions);
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/argocd",
      payload: { url: fake.url, token: TOKEN, caPem: TEST_CA_PEM },
    });
    expect(res.statusCode).toBe(201);
    connection = (await getConnection(pool, DEFAULT_TENANT_ID, res.json().connection.id))!;
    start = Date.now() + 1000;
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
    await pool.end();
  });

  it("registers a scheduled reconcile and a watch job", () => {
    const defs = module.jobs!(ctx);
    expect(defs.map((d) => d.name)).toEqual([ARGOCD_RECONCILE_JOB, ARGOCD_WATCH_JOB]);
    expect(defs[0]!.schedule).toBe("*/5 * * * *");
  });

  it("scheduled reconcile fans out per connection and backfills existing history", async () => {
    await jobs.send(ARGOCD_RECONCILE_JOB, {});
    // Run the fan-out and the per-connection reconcile, but not the watch.
    const fanOut = jobs.sent.shift()!;
    await module.jobs!(ctx)[0]!.handler(fanOut.data);
    expect(jobs.sent.map((j) => [j.name, j.options.singletonKey])).toEqual([
      [ARGOCD_RECONCILE_JOB, `${DEFAULT_TENANT_ID}:${connection.id}`],
      [ARGOCD_WATCH_JOB, `${DEFAULT_TENANT_ID}:${connection.id}`],
    ]);
    const reconcile = jobs.sent.shift()!;
    jobs.sent.length = 0;
    await module.jobs!(ctx)[0]!.handler(reconcile.data);
    const r = await rows();
    expect(r.map((x) => x.action).sort()).toEqual([
      "argocd.application.created",
      "argocd.sync.started",
      "argocd.sync.succeeded",
    ]);
    expect(new Set(r.map((x) => x.method))).toEqual(new Set(["backfill"]));
    // State persisted: running again records nothing new.
    await module.jobs!(ctx)[0]!.handler(reconcile.data);
    expect(await rows()).toHaveLength(3);
  });

  it("watch records changes as stream; after an outage reconciliation recovers the rest", async () => {
    const pollsBefore = observations.filter((o) => o.ok && o.via === "poll").length;
    const ctrl = new AbortController();
    const running = watchArgoCdConnection(ctx, connection, options, ctrl.signal);
    await fake.waitForStreams(1);
    // Wait for the catch-up reconciliation that starts when the stream opens.
    await waitFor(
      async () => observations.filter((o) => o.ok && o.via === "poll").length > pollsBefore,
      "catch-up",
    );
    // A second watch for the same connection in this process is a no-op.
    await watchArgoCdConnection(ctx, connection, options, ctrl.signal);

    old.startSync({ at: t(1), by: "bob", revision: SHA2 });
    fake.apply(old.snapshot());
    old.finishSync({ at: t(2) });
    fake.apply(old.snapshot());
    await waitFor(
      async () =>
        (await rows()).some((x) => x.action === "argocd.sync.succeeded" && x.method === "stream"),
      "stream sync",
    );

    fake.setUnavailable(true);
    await waitFor(async () => observations.some((o) => !o.ok), "failure observation");
    old.startSync({ at: t(3), by: "automated", revision: SHA3 }).finishSync({ at: t(4) });
    fake.apply(old.snapshot(), { emit: false });
    const fresh = new FakeApplication({ name: "new-app", createdAt: t(3) });
    fake.apply(fresh.snapshot(), { emit: false });
    fake.setUnavailable(false);

    await waitFor(
      async () =>
        (await rows()).filter(
          (x) => x.method === "reconciliation" && x.action === "argocd.sync.succeeded",
        ).length === 1 &&
        (await rows()).some(
          (x) => x.action === "argocd.application.created" && x.method === "reconciliation",
        ),
      "reconciled events",
    );
    ctrl.abort();
    await running;

    const recovered = (await rows()).find(
      (x) => x.method === "reconciliation" && x.action === "argocd.sync.succeeded",
    )!;
    expect(recovered.actor).toMatchObject({ type: "system", id: "argocd-application-controller" });
    expect(recovered.occurred_at.toISOString()).toBe(t(4));
    const cursor = await createPgCaptureStateStore(
      pool,
      DEFAULT_TENANT_ID,
      connection.id,
    ).getConnectionState();
    expect(cursor?.resourceVersion).toMatch(/^\d+$/);
    expect(cursor?.lastReconciledAt).toBeDefined();
    // Each source event is stored once and the chain is intact.
    const keys = (await rows()).map((x) => x.source_event_id);
    expect(new Set(keys).size).toBe(keys.length);
    expect((await verifyTenantChain(pool, DEFAULT_TENANT_ID)).ok).toBe(true);
  });

  it("backfill hook finds deletions that happened during a gap", async () => {
    fake.remove("new-app", { emit: false });
    await module.health!(ctx).backfill!(connection, new Date(start), new Date());
    const del = (await rows()).filter((x) => x.action === "argocd.application.deleted");
    expect(del).toHaveLength(1);
    expect(del[0]!.method).toBe("reconciliation");
  });

  it("capture state is tenant-scoped", async () => {
    const mine = createPgCaptureStateStore(pool, DEFAULT_TENANT_ID, connection.id);
    const other = createPgCaptureStateStore(pool, "other-tenant", connection.id);
    expect((await mine.listLiveApps()).length).toBeGreaterThan(0);
    expect(await other.listLiveApps()).toEqual([]);
    expect(await other.getConnectionState()).toBeNull();
    // Updating another tenant's cursor changes nothing.
    await other.updateConnectionState({ resourceVersion: "999999" });
    expect((await mine.getConnectionState())?.resourceVersion).not.toBe("999999");
  });

  it("never logs the token", () => {
    expect(logs.join("\n")).not.toContain("SECRET");
    expect(logs.join("\n")).toContain("argocd reconciliation finished");
  });
});
