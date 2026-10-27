/**
 * AFE-7: GitHub repository events end to end: signed delivery -> route
 * (verify, replay guard, enqueue) -> github.webhook job -> canonical events.
 */
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createMemoryEventSink,
  type EventSink,
  type HealthReporter,
  type MemoryEventSink,
} from "@afe/core";
import { EnvKeyProvider, Secret, signHmac } from "@afe/core/security";
import { createPgEventSink, listEvents, upsertConnection } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import type { GitHubAppConfig } from "@afe/connector-github";
import {
  installationFixture,
  testKeyPair,
} from "../../../packages/connector-github/test/fixtures.ts";
import {
  loadWebhook,
  variant,
  type WebhookFixture,
} from "../../../packages/connector-github/test/fixtures/webhooks.ts";
import { buildAfe, InlineJobQueue, type AfeApp } from "../src/index.ts";
import { createGitHubModule } from "../src/connectors/github.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const WEBHOOK_SECRET = "whsec-AFE7-TEST-SECRET";
const { privatePem } = testKeyPair();
const appConfig: GitHubAppConfig = {
  appId: "77",
  slug: "afe-test",
  privateKey: new Secret(privatePem),
  webhookSecret: new Secret(WEBHOOK_SECRET),
};
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });

/** Every trigger type in AFE-7, one fixture each. */
const TRIGGERS: [string, string, string][] = [
  ["push (workflow run)", "workflow_run.push.completed", "push"],
  ["push (ref)", "push", "push"],
  ["pull request (workflow run)", "workflow_run.pull_request.requested", "pull_request"],
  ["pull request (event)", "pull_request.closed.merged", "pull_request"],
  ["manual dispatch", "workflow_run.workflow_dispatch.in_progress", "manual"],
  ["schedule", "workflow_run.schedule.completed", "schedule"],
  ["API-triggered run", "workflow_run.workflow_dispatch.api.completed", "api"],
  ["re-run", "workflow_run.rerun.completed", "rerun"],
  ["reusable / called workflow", "workflow_run.reusable.completed", "push"],
  ["chained workflow_run", "workflow_run.workflow_run.completed", "upstream"],
  ["repository dispatch (run)", "workflow_run.repository_dispatch.completed", "api"],
  ["repository dispatch (event)", "repository_dispatch", "api"],
  ["deployment", "deployment.created", "upstream"],
  ["deployment status", "deployment_status.success", "upstream"],
  ["environment approval", "deployment_review.approved", "manual"],
  ["environment rejection", "deployment_review.rejected", "manual"],
];

describe("GitHub repository events (AFE-7)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let jobs: InlineJobQueue;
  let sink: MemoryEventSink;
  let logLines: string[];
  let connectionId: string;
  let deliveries = 0;
  let healthCalls: unknown[][];

  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  async function start(eventSink?: EventSink) {
    jobs = new InlineJobQueue();
    sink = createMemoryEventSink();
    logLines = [];
    afe = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      jobs,
      sink: eventSink ?? sink,
      keys,
      logLevel: "debug",
      logStream: new Writable({
        write(chunk, _enc, cb) {
          logLines.push(String(chunk));
          cb();
        },
      }),
      connectors: [createGitHubModule({ app: appConfig })],
    });
    jobs.register(afe.jobDefinitions);
    healthCalls = [];
    const health: HealthReporter = {
      reportSuccess: async (...args) => void healthCalls.push(["success", ...args]),
      reportFailure: async (...args) => void healthCalls.push(["failure", ...args]),
      canAttempt: async () => true,
    };
    afe.context.health = health;
  }

  async function connect(repositories: unknown = [{ id: 11, fullName: "acme/api" }]) {
    const conn = await upsertConnection(pool, "default", {
      source: "github",
      externalId: "4242",
      name: "acme",
      status: "active",
      config: { ...installationFixture(), installationId: 4242, repositories } as never,
    });
    connectionId = conn.id;
  }

  beforeEach(async () => {
    await pool.query("DELETE FROM connections; DELETE FROM webhook_deliveries");
    await start();
    await connect();
  });

  afterEach(async () => {
    await afe.app.close();
    const logs = logLines.join("");
    expect(logs).not.toContain(WEBHOOK_SECRET);
    expect(logs).not.toMatch(/sha256=[0-9a-f]{64}/);
    // No payload content in logs (R4/R8).
    expect(logs).not.toContain("@example.com");
    expect(logs).not.toContain("Implements login");
  });

  function send(f: WebhookFixture, deliveryId = `d-${++deliveries}`, bodyOverride?: string) {
    const body = bodyOverride ?? JSON.stringify(f.payload);
    return afe.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": f.event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signHmac("sha256", WEBHOOK_SECRET, body, "sha256="),
      },
      payload: body,
    });
  }

  async function deliver(f: WebhookFixture, deliveryId?: string) {
    const res = await send(f, deliveryId);
    expect(res.statusCode).toBe(202);
    await jobs.drain();
  }

  describe("each trigger produces a correct event", () => {
    for (const [label, fixture, trigger] of TRIGGERS) {
      it(label, async () => {
        const f = loadWebhook(fixture);
        const deliveryId = `delivery-${fixture.replace(/[^A-Za-z0-9-]/g, "-")}`;
        await deliver(f, deliveryId);
        const events = sink.events("default");
        expect(events).toHaveLength(1);
        const e = events[0]!;
        expect(e).toMatchObject({
          source: "github",
          connectionId,
          trigger: { type: trigger },
          observation: { method: "webhook", deliveryId },
        });
        expect(e.correlation.repositories).toContain("github.com/acme/api");
        expect(e.rawPayload).not.toBeNull();
        const raw = Buffer.from(sink.rawPayloads.get(e.rawPayload!.id)!.body).toString("utf8");
        expect(JSON.parse(raw).repository.full_name).toBe("acme/api");
        expect(raw).not.toContain("@example.com");
        expect(healthCalls).toEqual([
          ["success", "default", connectionId, expect.any(Date), { via: "webhook" }],
        ]);
      });
    }
  });

  it("re-run by a different person records actor and triggering actor", async () => {
    await deliver(loadWebhook("workflow_run.push.completed"));
    await deliver(loadWebhook("workflow_run.rerun.completed"));
    const [first, rerun] = sink.events("default");
    expect(first!.actor).toEqual({ type: "user", id: "501", login: "alice" });
    expect(rerun!.actor).toEqual({
      type: "user",
      id: "501",
      login: "alice",
      triggeredBy: { type: "user", id: "502", login: "bob" },
    });
    expect(rerun!.sourceEventId).toBe("workflow_run:9100001:2:completed");
  });

  it("reusable workflow: called workflows on the run, called jobs from workflow_job", async () => {
    await deliver(loadWebhook("workflow_run.reusable.completed"));
    await deliver(loadWebhook("workflow_job.completed"));
    const [run, job] = sink.events("default");
    expect(run!.data.referencedWorkflows).toHaveLength(2);
    expect(job).toMatchObject({
      action: "workflow_job.completed",
      target: { name: "deploy / deploy-k8s" },
      correlation: { runIds: ["github:9100006"] },
    });
  });

  it("redelivery of the same state with a new delivery id is stored once", async () => {
    const f = loadWebhook("deployment_status.success");
    await deliver(f, "first");
    // GitHub "redeliver" keeps the id and is stopped by the replay guard.
    expect((await send(f, "first")).json()).toMatchObject({ duplicate: true });
    // The same state reported again under a new delivery id dedupes on the key.
    await deliver(f, "second");
    expect(sink.events("default")).toHaveLength(1);
    expect(sink.events("default")[0]!.observation.deliveryId).toBe("first");
  });

  it("ignores unknown events safely", async () => {
    await deliver(loadWebhook("check_run.completed"));
    await deliver({ event: "star", payload: { action: "created", ...repoEnvelope() } });
    expect(sink.events("default")).toHaveLength(0);
    // Still a successful observation of the connection.
    expect(healthCalls).toHaveLength(2);
  });

  it("ignores events from repositories not selected in the installation", async () => {
    const f = variant("workflow_run.push.completed", (x) => {
      x.payload.repository.id = 999;
      x.payload.repository.full_name = "acme/secret-project";
    });
    await deliver(f);
    expect(sink.events("default")).toHaveLength(0);
    expect(logLines.join("")).toContain("repository not selected");
  });

  it("accepts every repository when the installation covers all of them", async () => {
    await pool.query("DELETE FROM connections");
    await connect("all");
    const f = variant("workflow_run.push.completed", (x) => {
      x.payload.repository.id = 999;
      x.payload.repository.full_name = "acme/other";
    });
    await deliver(f);
    expect(sink.events("default")).toHaveLength(1);
  });

  it("malformed payload: job completes without retry, nothing ingested, error logged", async () => {
    const f = variant("deployment.created", (x) => delete x.payload.deployment.sha);
    await deliver(f, "malformed-1"); // drain would throw if the job failed
    expect(sink.events("default")).toHaveLength(0);
    expect(healthCalls).toHaveLength(0);
    const logs = logLines.join("");
    expect(logs).toContain("malformed payload, delivery dropped");
    expect(logs).toContain("deployment.sha");
    // Later deliveries still work: the queue is not poisoned.
    await deliver(loadWebhook("deployment.created"));
    expect(sink.events("default")).toHaveLength(1);
  });

  it("an event that fails validation is dropped, not retried", async () => {
    const f = variant("repository_dispatch", (x) => (x.payload.action = "bad\u0000type"));
    await deliver(f);
    expect(sink.events("default")).toHaveLength(0);
    expect(logLines.join("")).toContain("failed validation");
  });

  it("transient sink errors propagate so the job is retried", async () => {
    await afe.app.close();
    let fail = true;
    const inner = createMemoryEventSink();
    await start({
      ingest: async (tenant, input) => {
        if (fail) throw new Error("database unavailable");
        return inner.ingest(tenant, input);
      },
    });
    await connect();
    const res = await send(loadWebhook("deployment.created"));
    expect(res.statusCode).toBe(202);
    const job = jobs.sent[0]!;
    await expect(jobs.drain()).rejects.toThrow("database unavailable");
    fail = false;
    jobs.sent.push(job);
    await jobs.drain();
    expect(inner.events("default")).toHaveLength(1);
  });

  it("accepts signed payloads larger than 1 MiB", async () => {
    const f = loadWebhook("push");
    f.payload.commits = Array.from({ length: 1200 }, (_, i) => ({
      ...f.payload.commits[0],
      id: i.toString(16).padStart(40, "0"),
      message: "x".repeat(1000),
    }));
    const body = JSON.stringify(f.payload);
    expect(body.length).toBeGreaterThan(1024 * 1024);
    const res = await send(f, "big-1", body);
    expect(res.statusCode).toBe(202);
    await jobs.drain();
    expect(sink.events("default")).toHaveLength(1);
  });

  it("stores events and stripped raw payloads in PostgreSQL", async () => {
    await afe.app.close();
    await start(createPgEventSink(pool));
    await connect();
    await deliver(loadWebhook("pull_request.opened"));
    await deliver(loadWebhook("deployment.api.created"));
    const { events } = await listEvents(pool, "default", {});
    const mine = events.filter((e) => e.connectionId === connectionId);
    expect(mine.map((e) => e.action)).toEqual(["pull_request.opened", "deployment.created"]);
    const { rows } = await pool.query<{ body: Buffer }>(
      "SELECT body FROM raw_payloads WHERE tenant_id = 'default' AND id = $1",
      [mine[0]!.rawPayload!.id],
    );
    expect(rows[0]!.body.toString("utf8")).not.toContain("bob@example.com");
  });
});

function repoEnvelope() {
  const f = loadWebhook("repository_dispatch");
  return { repository: f.payload.repository, installation: f.payload.installation };
}
