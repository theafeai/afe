import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createMemoryEventSink,
  FixedWindowRetention,
  type CanonicalEventInputLike,
  type RetentionPolicy,
} from "@afe/core";
import { ingestEvent, listEvents } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import {
  buildAfe,
  createRetentionModule,
  defaultModules,
  InlineJobQueue,
  loadConfig,
  RETENTION_JOBS,
  runRetentionPurge,
} from "../src/index.ts";
import {
  clampReconcileToRetention,
  DEFAULT_GITHUB_RECONCILE_CONFIG,
} from "../src/connectors/github.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const DAY = 24 * 3600_000;

function ev(id: string, ageDays: number, now = Date.now()): CanonicalEventInputLike {
  return {
    source: "github",
    sourceEventId: id,
    action: "deployment.created",
    actor: { type: "user", login: "octocat" },
    target: { type: "repository", id: "acme/api" },
    trigger: { type: "push" },
    outcome: "succeeded",
    occurredAt: new Date(now - ageDays * DAY),
    observedAt: new Date(now),
    observation: { method: "webhook" },
    rawPayload: { contentType: "application/json", body: `{"id":"${id}"}` },
  };
}

describe("AFE_EVENT_RETENTION_DAYS", () => {
  const base = { DATABASE_URL: "postgres://x" };

  it("defaults to 30 days", () => {
    expect(loadConfig(base).eventRetentionDays).toBe(30);
  });

  it("accepts 1..60 days", () => {
    expect(loadConfig({ ...base, AFE_EVENT_RETENTION_DAYS: "1" }).eventRetentionDays).toBe(1);
    expect(loadConfig({ ...base, AFE_EVENT_RETENTION_DAYS: "60" }).eventRetentionDays).toBe(60);
  });

  it("refuses to start above the open-source maximum of 60 days, or below 1", () => {
    for (const v of ["61", "90", "0", "30d"]) {
      expect(() => loadConfig({ ...base, AFE_EVENT_RETENTION_DAYS: v }), v).toThrow(
        /AFE_EVENT_RETENTION_DAYS must be a whole number of days from 1 to 60/,
      );
    }
  });
});

describe("retention in the server", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM events");
    await pool.query("DELETE FROM raw_payloads");
  });

  it("the default sink drops events outside the configured window", async () => {
    const { app, context } = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      config: { ...loadConfig({ DATABASE_URL: "unused", AFE_EVENT_RETENTION_DAYS: "7" }) },
    });
    expect(context.retention).toBeInstanceOf(FixedWindowRetention);
    expect((context.retention as FixedWindowRetention).days).toBe(7);
    expect((await context.sink.ingest("default", ev("old", 8))).status).toBe("expired");
    expect((await context.sink.ingest("default", ev("new", 6))).status).toBe("inserted");
    const { events } = await listEvents(pool, "default");
    expect(events.map((e) => e.sourceEventId)).toEqual(["new"]);
    await app.close();
  });

  it("buildAfe accepts a replacement sink and retention policy (the extension seams)", async () => {
    const sink = createMemoryEventSink();
    const policy: RetentionPolicy = { cutoff: () => null, maxWindowMs: null };
    const { app, context } = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      sink,
      retentionPolicy: policy,
    });
    expect(context.sink).toBe(sink);
    expect(context.retention).toBe(policy);
    await app.close();
  });

  it("registers retention.purge by default, hourly", async () => {
    const { app, jobDefinitions } = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      connectors: defaultModules,
    });
    const purge = jobDefinitions.find((j) => j.name === RETENTION_JOBS.PURGE);
    expect(purge?.schedule).toMatch(/^\d+ \* \* \* \*$/);
    expect(jobDefinitions.map((j) => j.name)).not.toContain("anchor.publish");
    await app.close();
  });

  it("the purge job deletes expired events and their raw payloads, per tenant", async () => {
    await pool.query("INSERT INTO tenants (id, name) VALUES ('t2', 't2') ON CONFLICT DO NOTHING");
    for (const [id, age] of [
      ["a", 40],
      ["b", 31],
      ["c", 29],
      ["d", 1],
    ] as const) {
      await ingestEvent(pool, "default", ev(id, age));
    }
    await ingestEvent(pool, "t2", ev("x", 45));
    await ingestEvent(pool, "t2", ev("y", 2));

    const jobs = new InlineJobQueue();
    const { app, jobDefinitions } = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      jobs,
      connectors: [createRetentionModule({ purge: { batchSize: 1, maxBatches: 1 } })],
    });
    jobs.register(jobDefinitions);
    await jobs.send(RETENTION_JOBS.PURGE, {});
    // Each run deletes one event per tenant and enqueues a follow-up until done.
    await jobs.drain();

    const left = async (t: string) =>
      (await listEvents(pool, t)).events.map((e) => e.sourceEventId).sort();
    expect(await left("default")).toEqual(["c", "d"]);
    expect(await left("t2")).toEqual(["y"]);
    const raw = await pool.query("SELECT count(*)::int AS n FROM raw_payloads");
    expect(raw.rows[0].n).toBe(3);
    await app.close();
  });

  it("runRetentionPurge skips tenants whose policy keeps everything", async () => {
    await ingestEvent(pool, "default", ev("ancient", 400));
    const jobs = new InlineJobQueue();
    const log = { info: () => {} } as never;
    const r = await runRetentionPurge({
      pool,
      jobs,
      log,
      retention: { cutoff: () => null, maxWindowMs: null },
    });
    expect(r).toMatchObject({ tenants: 0, events: 0 });
    expect((await listEvents(pool, "default")).events).toHaveLength(1);
  });
});

describe("connector lookbacks never exceed the retention window", () => {
  it("clamps GitHub backfill days and the reconcile lookback, with a log line", () => {
    const lines: unknown[] = [];
    const log = { info: (...a: unknown[]) => void lines.push(a) };
    const cfg = clampReconcileToRetention(
      { ...DEFAULT_GITHUB_RECONCILE_CONFIG, backfillDays: 90, lookbackMs: 20 * DAY },
      new FixedWindowRetention(14),
      log,
    );
    expect(cfg.backfillDays).toBe(14);
    expect(cfg.lookbackMs).toBe(14 * DAY);
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).toMatch(/AFE_GITHUB_BACKFILL_DAYS exceeds/);

    const lines2: unknown[] = [];
    const unchanged = clampReconcileToRetention(
      DEFAULT_GITHUB_RECONCILE_CONFIG,
      new FixedWindowRetention(30),
      {
        info: (...a: unknown[]) => void lines2.push(a),
      },
    );
    expect(unchanged).toEqual(DEFAULT_GITHUB_RECONCILE_CONFIG);
    expect(lines2).toEqual([]);
  });
});
