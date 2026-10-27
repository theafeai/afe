import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { EnvKeyProvider } from "@afe/core/security";
import { getConnection } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import {
  AGENT_PATHS,
  AGENT_PROTOCOL_VERSION,
  agentRequestHeaders,
  type AgentItem,
} from "@afe/connector-argocd";
import {
  FakeApplication,
  TEST_CA_PEM,
  startFakeArgoCd,
  type FakeArgoCd,
} from "@afe/connector-argocd/testing";
import { InlineJobQueue, buildAfe, createHealthModule, loadConfig } from "../src/index.ts";
import { ARGOCD_RECONCILE_JOB, createArgoCdModule } from "../src/connectors/argocd.ts";
import {
  AGENT_HEARTBEAT_CHECK_JOB,
  AGENT_SWEEP_JOB,
  createArgoCdAgentModule,
} from "../src/connectors/argocd-agent.ts";
import { getAgentRow, probeAgentConnection } from "../src/connectors/argocd-agent-state.ts";
import { tokenMapAuth } from "./helpers/auth.ts";

const SHA1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ARGOCD_TOKEN = "afe-agent-test-argocd-token";
const A = { authorization: "Bearer tenant-a-token" };
const B = { authorization: "Bearer tenant-b-token" };
const MIN = 60_000;

interface EventRow {
  action: string;
  connection_id: string;
  source_event_id: string;
  observation: { method: string; detail?: string };
  data: Record<string, unknown>;
}

describe("ArgoCD in-cluster agent ingest (database)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let jobs: InlineJobQueue;
  let fake: FakeArgoCd;
  const logs: string[] = [];
  let clock = Date.now();
  const now = () => new Date(clock);
  const advance = (ms: number) => {
    clock += ms;
    return now();
  };

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
    fake = await startFakeArgoCd({ accounts: { [ARGOCD_TOKEN]: { username: "afe" } }, applications: [] });
    jobs = new InlineJobQueue();
    const built = await buildAfe({
      authProvider: tokenMapAuth({
        "tenant-a-token": { tenantId: "default", roles: ["admin"] },
        "tenant-b-token": { tenantId: "other", roles: ["admin"] },
      }),
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
      connectors: [
        createArgoCdModule({ retries: 0, requeueWatch: false, scheduleWatch: false, now }),
        createArgoCdAgentModule({ now, maxPendingBatches: 5 }),
        createHealthModule({ env: {}, now, random: () => 0 }),
      ],
    });
    app = built.app;
    jobs.register(built.jobDefinitions);
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
    await pool.end();
  });

  // ---- helpers -----------------------------------------------------------------

  interface Agent {
    id: string;
    secret: string;
    runId: string;
    seq: number;
    dropped: number;
  }

  async function register(instanceId = `cluster-${randomUUID().slice(0, 8)}`): Promise<Agent> {
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/argocd/agents",
      headers: A,
      payload: { instanceId, name: "prod cluster" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    return { id: body.agentId, secret: body.secret, runId: randomUUID(), seq: 0, dropped: 0 };
  }

  function post(
    agent: Agent,
    path: string,
    body: object,
    opts: { secret?: string; at?: Date; mutate?: (raw: string) => string } = {},
  ) {
    const raw = JSON.stringify(body);
    const headers = agentRequestHeaders(agent.id, opts.secret ?? agent.secret, raw, opts.at ?? now());
    return app.inject({
      method: "POST",
      url: path,
      headers,
      payload: opts.mutate ? opts.mutate(raw) : raw,
    });
  }

  const envelope = (agent: Agent) => ({
    protocol: AGENT_PROTOCOL_VERSION,
    agentId: agent.id,
    runId: agent.runId,
    sentAt: now().toISOString(),
    agentVersion: "0.1.0",
    mode: "kubernetes",
    droppedTotal: agent.dropped,
  });

  function batchBody(agent: Agent, items: AgentItem[], batchId = randomUUID()) {
    agent.seq++;
    return { ...envelope(agent), batchId, sequence: agent.seq, items };
  }

  async function sendBatch(agent: Agent, items: AgentItem[]) {
    const res = await post(agent, AGENT_PATHS.batches, batchBody(agent, items));
    expect(res.statusCode, res.body).toBe(202);
    await jobs.drain();
  }

  async function heartbeat(agent: Agent) {
    const res = await post(agent, AGENT_PATHS.heartbeat, {
      ...envelope(agent),
      heartbeatId: randomUUID(),
      lastSequence: agent.seq,
      buffered: 0,
      watching: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    await jobs.drain();
    return res.json() as { resync: boolean; heartbeatIntervalSeconds: number };
  }

  function snapshotItems(apps: FakeApplication[], listedAt = now()): AgentItem[] {
    const snapshotId = randomUUID();
    return [
      ...apps.map(
        (a): AgentItem => ({
          kind: "snapshot",
          snapshotId,
          observedAt: now().toISOString(),
          application: a.snapshot(),
        }),
      ),
      {
        kind: "snapshot_end",
        snapshotId,
        listedAt: listedAt.toISOString(),
        droppedTotalAtStart: 0,
        uids: apps.map((a) => a.snapshot().metadata!.uid!),
      },
    ];
  }

  const watch = (type: "ADDED" | "MODIFIED" | "DELETED", a: FakeApplication): AgentItem => ({
    kind: "watch",
    type,
    observedAt: now().toISOString(),
    application: a.snapshot(),
  });

  const events = async (connectionId?: string) =>
    (
      await pool.query<EventRow>(
        `SELECT action, connection_id, source_event_id, observation, data FROM events
         WHERE tenant_id = 'default' ${connectionId ? "AND connection_id = $1" : ""} ORDER BY seq`,
        connectionId ? [connectionId] : [],
      )
    ).rows;
  const gaps = async (id: string) =>
    (await events(id)).filter((e) => e.action.startsWith("observation_gap.")).map((e) => e.action);
  const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

  // ---- registration and management ---------------------------------------------

  it("registers an agent: one connection (mode agent), a secret shown once", async () => {
    const agent = await register("prod-eu-1");
    expect(agent.secret).toMatch(/^afeag_[A-Za-z0-9_-]{43}$/);
    const c = (await getConnection(pool, "default", agent.id))!;
    expect(c).toMatchObject({ source: "argocd", externalId: "agent:prod-eu-1", status: "active" });
    expect(c.config).toMatchObject({ mode: "agent", instanceId: "prod-eu-1" });
    const again = await app.inject({
      method: "POST",
      url: "/api/connections/argocd/agents",
      headers: A,
      payload: { instanceId: "prod-eu-1" },
    });
    expect(again.statusCode).toBe(409);
    const list = await app.inject({ method: "GET", url: "/api/connections/argocd/agents", headers: A });
    expect(list.json().agents.map((a: { id: string }) => a.id)).toContain(agent.id);
    expect(list.body).not.toContain(agent.secret);
    const stored = await pool.query("SELECT kind FROM credentials WHERE tenant_id = 'default'");
    expect(stored.rows.map((r) => r.kind)).toContain("argocd_agent_secret");
    // Other tenant: not listed, cannot rotate.
    const other = await app.inject({ method: "GET", url: "/api/connections/argocd/agents", headers: B });
    expect(other.json().agents).toEqual([]);
    const rot = await app.inject({
      method: "POST",
      url: `/api/connections/argocd/agents/${agent.id}/rotate-secret`,
      headers: B,
      payload: {},
    });
    expect(rot.statusCode).toBe(404);
    const noAuth = await app.inject({ method: "GET", url: "/api/connections/argocd/agents" });
    expect(noAuth.statusCode).toBe(401);
  });

  // ---- authentication ----------------------------------------------------------

  it("rejects unknown agents, bad signatures, tampered bodies and clock skew > 5 min", async () => {
    const agent = await register();
    const body = batchBody(agent, []);
    const unknown = { ...agent, id: randomUUID() };
    expect((await post(unknown, AGENT_PATHS.batches, { ...body, agentId: unknown.id })).statusCode).toBe(401);
    expect((await post(agent, AGENT_PATHS.batches, body, { secret: "afeag_wrong" })).statusCode).toBe(401);
    const tampered = await post(agent, AGENT_PATHS.batches, body, {
      mutate: (raw) => raw.replace('"items":[]', '"items":[ ]'),
    });
    expect(tampered.statusCode).toBe(401);
    const stale = await post(agent, AGENT_PATHS.batches, body, { at: new Date(clock - 6 * MIN) });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: "clock_skew" });
    const future = await post(agent, AGENT_PATHS.batches, body, { at: new Date(clock + 6 * MIN) });
    expect(future.statusCode).toBe(401);
    const mismatch = await post(agent, AGENT_PATHS.batches, { ...body, agentId: randomUUID() });
    expect(mismatch.statusCode).toBe(400);
    const noHeaders = await app.inject({
      method: "POST",
      url: AGENT_PATHS.batches,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
    expect(noHeaders.statusCode).toBe(401);
    expect((await post(agent, AGENT_PATHS.batches, { ...body, items: [{ kind: "nope" }] })).statusCode).toBe(400);
    // Valid one is accepted; the same batchId again is a duplicate, staged once.
    expect((await post(agent, AGENT_PATHS.batches, body)).statusCode).toBe(202);
    const replay = await post(agent, AGENT_PATHS.batches, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: "duplicate" });
    const staged = await pool.query(
      "SELECT count(*)::int AS n FROM argocd_agent_batches WHERE connection_id = $1",
      [agent.id],
    );
    expect(staged.rows[0].n).toBe(1);
    await jobs.drain();
    // The secret is never logged.
    expect(logs.join("")).not.toContain(agent.secret);
  });

  it("rotates the secret, with an optional grace period for the previous one", async () => {
    const agent = await register();
    const rotate = async (graceSeconds?: number) => {
      const r = await app.inject({
        method: "POST",
        url: `/api/connections/argocd/agents/${agent.id}/rotate-secret`,
        headers: A,
        payload: graceSeconds === undefined ? {} : { graceSeconds },
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as { secret: string; previousSecretValidUntil: string | null };
    };
    const old = agent.secret;
    const r1 = await rotate(600);
    expect(r1.previousSecretValidUntil).not.toBeNull();
    expect((await post(agent, AGENT_PATHS.batches, batchBody(agent, []), { secret: old })).statusCode).toBe(202);
    expect((await post(agent, AGENT_PATHS.batches, batchBody(agent, []), { secret: r1.secret })).statusCode).toBe(202);
    advance(11 * MIN);
    expect((await post(agent, AGENT_PATHS.batches, batchBody(agent, []), { secret: old })).statusCode).toBe(401);
    const r2 = await rotate();
    expect((await post(agent, AGENT_PATHS.batches, batchBody(agent, []), { secret: r1.secret })).statusCode).toBe(401);
    expect((await post(agent, AGENT_PATHS.batches, batchBody(agent, []), { secret: r2.secret })).statusCode).toBe(202);
    await jobs.drain();
  });

  // ---- capture -------------------------------------------------------------------

  it("maps snapshots (reconciliation) and watch events (stream) with the AFE-10 code", async () => {
    const agent = await register();
    const guestbook = new FakeApplication({ name: "guestbook-agent", createdAt: iso(-60 * MIN) });
    guestbook.startSync({ at: iso(-30 * MIN), by: "alice", revision: SHA1 }).finishSync({ at: iso(-29 * MIN) });
    await sendBatch(agent, snapshotItems([guestbook]));
    const first = await events(agent.id);
    expect(first.length).toBeGreaterThan(0);
    for (const e of first) expect(["reconciliation", "backfill"]).toContain(e.observation.method);

    advance(MIN);
    guestbook.startSync({ at: iso(0), by: "bob", revision: SHA2 });
    await sendBatch(agent, [watch("MODIFIED", guestbook)]);
    advance(MIN);
    guestbook.finishSync({ at: iso(0) });
    await sendBatch(agent, [watch("MODIFIED", guestbook)]);
    const stream = (await events(agent.id)).filter(
      (e) => e.observation.method === "stream" && e.action.startsWith("argocd.sync."),
    );
    expect(stream.map((e) => e.action)).toEqual(["argocd.sync.started", "argocd.sync.succeeded"]);
    expect(stream[0]!.observation.detail).toBe("in-cluster agent: watch MODIFIED");
    const row = (await getAgentRow(pool, "default", agent.id))!;
    expect(row.lastSequence).toBe(agent.seq);
  });

  it("a full snapshot records applications missing from it as deleted (certain)", async () => {
    const agent = await register();
    const keep = new FakeApplication({ name: "keep", createdAt: iso(-60 * MIN) });
    const gone = new FakeApplication({ name: "gone", createdAt: iso(-60 * MIN) });
    await sendBatch(agent, snapshotItems([keep, gone]));
    advance(MIN);
    const listedAt = now();
    advance(1000);
    // Created after the list was taken: must not be treated as deleted.
    const late = new FakeApplication({ name: "late", createdAt: iso(0) });
    await sendBatch(agent, [watch("ADDED", late)]);
    await sendBatch(agent, snapshotItems([keep], listedAt));
    const deleted = (await events(agent.id)).filter((e) => e.action === "argocd.application.deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.data).toMatchObject({ confidence: "certain" });
    expect(deleted[0]!.data.evidence).toContain("in-cluster agent");
    expect(deleted[0]!.observation.method).toBe("reconciliation");
  });

  it("dedupes with pull mode: the same sync seen by pull and by the agent is stored once", async () => {
    const shared = new FakeApplication({ name: "shared-app", createdAt: iso(-60 * MIN) });
    // Pull mode connection (AFE-9/10) against the fake ArgoCD.
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/argocd",
      headers: A,
      payload: { url: fake.url, token: ARGOCD_TOKEN, caPem: TEST_CA_PEM },
    });
    expect(res.statusCode, res.body).toBe(201);
    const pullId = res.json().connection.id;
    advance(MIN);
    shared.startSync({ at: iso(0), by: "alice", revision: SHA1 });
    advance(MIN);
    shared.finishSync({ at: iso(0) });
    advance(MIN);
    fake.apply(shared.snapshot(), { emit: false });
    await jobs.send(ARGOCD_RECONCILE_JOB, { tenantId: "default", connectionId: pullId });
    await jobs.drain();
    const key = (e: EventRow) => e.source_event_id;
    const pullSync = (await events(pullId)).filter((e) => e.action.startsWith("argocd.sync."));
    expect(pullSync.map((e) => e.action)).toEqual(["argocd.sync.started", "argocd.sync.succeeded"]);

    const agent = await register();
    await sendBatch(agent, snapshotItems([shared]));
    const all = (await events()).filter((e) => pullSync.map(key).includes(key(e)));
    expect(all).toHaveLength(2); // the agent's observations deduplicated into pull's events
    expect((await events(agent.id)).filter((e) => e.action.startsWith("argocd.sync."))).toEqual([]);
    // The scheduled pull reconciliation fans out to pull connections only.
    const sent: string[] = [];
    const send = jobs.send.bind(jobs);
    jobs.send = async (name, data, options) => {
      sent.push(`${name} ${JSON.stringify(data)}`);
      return send(name, data, options);
    };
    try {
      await jobs.send(ARGOCD_RECONCILE_JOB, {});
      await jobs.drain();
    } finally {
      jobs.send = send;
    }
    expect(sent.some((s) => s.includes(pullId))).toBe(true);
    expect(sent.some((s) => s.includes(agent.id))).toBe(false);
    await pool.query("UPDATE connections SET status = 'disconnected' WHERE id = $1", [pullId]);
  });

  // ---- health: heartbeats, gaps, drops ------------------------------------------

  it("missing heartbeats open a gap; it closes after the agent's next full snapshot", async () => {
    const agent = await register();
    const app1 = new FakeApplication({ name: "hb-app", createdAt: iso(-60 * MIN) });
    expect((await heartbeat(agent)).resync).toBe(false);
    await sendBatch(agent, snapshotItems([app1]));
    expect(await probeAgentConnection(pool, (await getConnection(pool, "default", agent.id))!, { now })).toEqual({
      ok: true,
    });

    advance(5 * MIN);
    await jobs.send(AGENT_HEARTBEAT_CHECK_JOB, {});
    await jobs.drain();
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened"]);
    // Reported once per silence.
    await jobs.send(AGENT_HEARTBEAT_CHECK_JOB, {});
    await jobs.drain();
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened"]);

    advance(MIN);
    const hb = await heartbeat(agent);
    expect(hb.resync).toBe(true); // Afe asks for a full snapshot
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened"]); // not closed by a heartbeat
    const probe = await probeAgentConnection(pool, (await getConnection(pool, "default", agent.id))!, { now });
    expect(probe).toMatchObject({ ok: false, reason: "error" });

    advance(1000);
    await sendBatch(agent, snapshotItems([app1]));
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened", "observation_gap.closed"]);
    expect((await heartbeat(agent)).resync).toBe(false);
  });

  it("dropped observations open a gap that only a later snapshot closes", async () => {
    const agent = await register();
    const a = new FakeApplication({ name: "drop-app", createdAt: iso(-60 * MIN) });
    await heartbeat(agent);
    await sendBatch(agent, snapshotItems([a]));
    advance(MIN);
    agent.dropped = 7;
    const hb = await heartbeat(agent);
    expect(hb.resync).toBe(true);
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened"]);
    // A snapshot that started before the drops does not close it.
    advance(1000);
    const old = snapshotItems([a]);
    (old.at(-1) as { droppedTotalAtStart: number }).droppedTotalAtStart = 3;
    await sendBatch(agent, old);
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened"]);
    // One taken after them does.
    advance(1000);
    const fresh = snapshotItems([a]);
    (fresh.at(-1) as { droppedTotalAtStart: number }).droppedTotalAtStart = 7;
    await sendBatch(agent, fresh);
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened", "observation_gap.closed"]);
  });

  it("an agent restart and a sequence gap are treated as possible loss", async () => {
    const agent = await register();
    const a = new FakeApplication({ name: "restart-app", createdAt: iso(-60 * MIN) });
    await heartbeat(agent);
    await sendBatch(agent, snapshotItems([a]));
    advance(MIN);
    agent.seq += 2; // batches never arrived
    await sendBatch(agent, [watch("MODIFIED", a)]);
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened"]);
    advance(1000);
    await sendBatch(agent, snapshotItems([a]));
    expect(await gaps(agent.id)).toEqual(["observation_gap.opened", "observation_gap.closed"]);

    advance(MIN);
    agent.runId = randomUUID();
    agent.seq = 0;
    const hb = await heartbeat(agent);
    expect(hb.resync).toBe(false); // a new run sends its snapshot by itself
    expect((await gaps(agent.id)).at(-1)).toBe("observation_gap.opened");
    advance(1000);
    await sendBatch(agent, snapshotItems([a]));
    expect((await gaps(agent.id)).at(-1)).toBe("observation_gap.closed");
  });

  it("applies backpressure (429) when too many batches wait, and the sweeper catches up", async () => {
    const agent = await register();
    for (let i = 0; i < 5; i++) {
      expect((await post(agent, AGENT_PATHS.batches, batchBody(agent, []))).statusCode).toBe(202);
    }
    const busy = await post(agent, AGENT_PATHS.batches, batchBody(agent, []));
    expect(busy.statusCode).toBe(429);
    expect(busy.headers["retry-after"]).toBe("10");
    jobs.sent.length = 0; // lose the queued jobs: the sweeper must re-queue them
    await jobs.send(AGENT_SWEEP_JOB, {});
    await jobs.drain();
    const left = await pool.query(
      "SELECT count(*)::int AS n FROM argocd_agent_batches WHERE connection_id = $1",
      [agent.id],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("a disconnected agent can no longer send", async () => {
    const agent = await register();
    const del = await app.inject({
      method: "DELETE",
      url: `/api/connections/argocd/${agent.id}`,
      headers: A,
    });
    expect(del.statusCode).toBe(200);
    expect((await post(agent, AGENT_PATHS.batches, batchBody(agent, []))).statusCode).toBe(401);
    expect((await post(agent, AGENT_PATHS.heartbeat, {})).statusCode).toBe(401);
  });
});
