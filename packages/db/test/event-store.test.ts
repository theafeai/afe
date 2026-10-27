import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  EventValidationError,
  FixedWindowRetention,
  observationGapClosed,
  observationGapOpened,
  type CanonicalEventInputLike,
} from "@afe/core";
import {
  createPgEventSink,
  findEventBySourceId,
  getEvent,
  getLatestSeq,
  ingestEvent,
  listEvents,
  listTenantsWithEvents,
  purgeEventsBefore,
} from "../src/index.ts";
import { createTestPool } from "../src/testing.ts";

const SHA = "4f2c9b8e1d7a6b5c3e2f1a0b9c8d7e6f5a4b3c2d";

function input(
  n: number,
  overrides: Partial<CanonicalEventInputLike> = {},
): CanonicalEventInputLike {
  return {
    source: "github",
    sourceEventId: `deployment:${n}:created`,
    connectionId: "conn_gh_1",
    action: "deployment.created",
    actor: { type: "user", id: "583231", login: "octocat" },
    target: { type: "environment", id: "acme/api:production", repository: "acme/api" },
    trigger: { type: "manual", sourceValue: "workflow_dispatch" },
    outcome: "pending",
    occurredAt: new Date(Date.UTC(2026, 9, 1, 10, 0, n)),
    observedAt: new Date(Date.UTC(2026, 9, 1, 10, 0, n, 500)),
    observation: { method: "webhook", deliveryId: `delivery-${n}` },
    correlation: { commitShas: [SHA], environments: ["production"] },
    data: { n, nested: { list: [1, 2.5, "x", null, true], big: 1e21, small: 1e-7 } },
    rawPayload: { contentType: "application/json", body: `{"deployment":{"id":${n}},"é":"ü"}` },
    ...overrides,
  };
}

let tenantCounter = 0;

describe("event store", () => {
  let pool: pg.Pool;
  let tenant: string;

  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    tenant = `t${++tenantCounter}`;
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1)", [tenant]);
  });

  it("stores an event and reads it back identically", async () => {
    const a = await ingestEvent(pool, tenant, input(1));
    const b = await ingestEvent(pool, tenant, input(2));
    expect(a.status).toBe("inserted");
    expect(a.inserted).toBe(true);
    expect(a.event!.seq).toBe(1);
    expect(b.event!.seq).toBe(2);
    expect(a.event).not.toHaveProperty("hash");
    expect(a.event).not.toHaveProperty("prevHash");
    expect(await getLatestSeq(pool, tenant)).toBe(2);

    const read = await getEvent(pool, tenant, a.event!.id);
    expect(read).toEqual(a.event);
    expect(await getEvent(pool, "default", a.event!.id)).toBeNull();

    const raw = await pool.query(
      "SELECT body, content_type, size_bytes FROM raw_payloads WHERE id = $1",
      [a.event!.rawPayload!.id],
    );
    expect(raw.rows[0].body.toString("utf8")).toBe('{"deployment":{"id":1},"é":"ü"}');
    expect(raw.rows[0].size_bytes).toBe(Buffer.byteLength('{"deployment":{"id":1},"é":"ü"}'));
  });

  it("is idempotent: webhook then poll stores once and keeps the first", async () => {
    const viaWebhook = await ingestEvent(pool, tenant, input(1));
    const viaPoll = await ingestEvent(
      pool,
      tenant,
      input(1, {
        observation: { method: "poll", jobId: "job-9" },
        observedAt: "2026-10-01T11:00:00Z",
        rawPayload: { contentType: "application/json", body: '{"different":"body"}' },
      }),
    );
    expect(viaPoll.status).toBe("duplicate");
    expect(viaPoll.event).toEqual(viaWebhook.event);
    expect(viaPoll.event!.observation.method).toBe("webhook");
    const count = await pool.query(
      "SELECT (SELECT count(*) FROM events WHERE tenant_id = $1)::int AS e, " +
        "(SELECT count(*) FROM raw_payloads WHERE tenant_id = $1)::int AS r",
      [tenant],
    );
    expect(count.rows[0]).toEqual({ e: 1, r: 1 });

    // Same sourceEventId from another source or tenant is a different event.
    expect((await ingestEvent(pool, tenant, input(1, { source: "vercel" }))).inserted).toBe(true);
    expect((await ingestEvent(pool, "default", input(1))).inserted).toBe(true);
    expect(await findEventBySourceId(pool, tenant, "github", "deployment:1:created")).toEqual(
      viaWebhook.event,
    );
  });

  it("rejects invalid input without writing", async () => {
    await expect(
      ingestEvent(pool, tenant, { ...input(1), action: "Not An Action" }),
    ).rejects.toBeInstanceOf(EventValidationError);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM events WHERE tenant_id = $1",
      [tenant],
    );
    expect(rows[0].n).toBe(0);
  });

  it("rejects unknown tenants", async () => {
    await expect(ingestEvent(pool, "no-such-tenant", input(1))).rejects.toThrow(/foreign key/);
  });

  it("assigns unique, gap-free seqs under concurrent ingestion, including duplicates", async () => {
    const other = `${tenant}-b`;
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1)", [other]);
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      jobs.push(ingestEvent(pool, tenant, input(i)));
      jobs.push(ingestEvent(pool, tenant, input(i, { observation: { method: "poll" } })));
      jobs.push(ingestEvent(pool, other, input(i)));
    }
    const results = (await Promise.all(jobs)) as { inserted: boolean }[];
    expect(results.filter((r) => r.inserted)).toHaveLength(80);

    for (const t of [tenant, other]) {
      const { events } = await listEvents(pool, t, { limit: 1000 });
      // Duplicates roll their seq allocation back, so nothing is skipped here.
      expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(new Set(events.map((e) => e.sourceEventId)).size).toBe(40);
      expect(await getLatestSeq(pool, t)).toBe(40);
    }
  });

  it("stores observation gaps as events", async () => {
    const gap = {
      gapId: "gap-1",
      connectionId: "conn_gh_1",
      source: "github",
      startedAt: "2026-10-01T10:00:00Z",
      reason: "rate_limited" as const,
    };
    await ingestEvent(pool, tenant, observationGapOpened(gap));
    const closed = await ingestEvent(
      pool,
      tenant,
      observationGapClosed({ ...gap, endedAt: "2026-10-01T10:30:00Z" }),
    );
    expect(closed.event!.data.gap).toMatchObject({ endedAt: "2026-10-01T10:30:00.000Z" });
    expect(closed.event!.source).toBe("afe");
    expect((await listEvents(pool, tenant)).events).toHaveLength(2);
  });

  it("lists events by time range with a cursor", async () => {
    for (let i = 0; i < 10; i++) await ingestEvent(pool, tenant, input(i));
    const page1 = await listEvents(pool, tenant, { limit: 3 });
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    const page2 = await listEvents(pool, tenant, { limit: 3, cursor: page1.nextCursor });
    expect(page2.events.map((e) => e.seq)).toEqual([4, 5, 6]);

    const ranged = await listEvents(pool, tenant, {
      occurredFrom: "2026-10-01T10:00:02Z",
      occurredTo: new Date("2026-10-01T10:00:05Z"),
    });
    expect(ranged.events.map((e) => e.data.n)).toEqual([2, 3, 4]);
    expect(ranged.nextCursor).toBeNull();

    const desc = await listEvents(pool, tenant, { order: "desc", limit: 4 });
    expect(desc.events.map((e) => e.seq)).toEqual([10, 9, 8, 7]);
    const desc2 = await listEvents(pool, tenant, { order: "desc", cursor: desc.nextCursor });
    expect(desc2.events.map((e) => e.seq)).toEqual([6, 5, 4, 3, 2, 1]);

    await expect(listEvents(pool, tenant, { cursor: "garbage" })).rejects.toThrow(/cursor/);
  });

  it("supports correlation-key containment queries", async () => {
    await ingestEvent(pool, tenant, input(1));
    await ingestEvent(pool, tenant, input(2, { correlation: {} }));
    const { rows } = await pool.query(
      "SELECT seq FROM events WHERE tenant_id = $1 AND correlation @> $2::jsonb",
      [tenant, JSON.stringify({ commitShas: [SHA] })],
    );
    expect(rows).toEqual([{ seq: "1" }]);
  });

  describe("retention", () => {
    const DAY = 24 * 3600_000;
    // input(n) occurred on 2026-10-01; with a 30-day window "now" keeps them.
    const NOW = new Date("2026-10-20T00:00:00Z");
    const retention = new FixedWindowRetention(30);
    const old = (n: number) => input(n, { occurredAt: new Date(NOW.getTime() - 45 * DAY + n) });

    it("drops events whose occurredAt is already outside the window", async () => {
      const r = await ingestEvent(pool, tenant, old(1), { retention, now: () => NOW });
      expect(r).toEqual({ status: "expired", inserted: false, event: null });
      const kept = await ingestEvent(pool, tenant, input(2), { retention, now: () => NOW });
      expect(kept.status).toBe("inserted");
      const count = await pool.query(
        "SELECT (SELECT count(*) FROM events WHERE tenant_id = $1)::int AS e, " +
          "(SELECT count(*) FROM raw_payloads WHERE tenant_id = $1)::int AS r",
        [tenant],
      );
      expect(count.rows[0]).toEqual({ e: 1, r: 1 });
    });

    it("purges events before the cutoff with their raw payloads, in batches", async () => {
      for (let i = 1; i <= 7; i++) await ingestEvent(pool, tenant, old(i));
      for (let i = 10; i <= 12; i++) await ingestEvent(pool, tenant, input(i));
      const other = `${tenant}-o`;
      await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1)", [other]);
      await ingestEvent(pool, other, old(1));

      const cutoff = retention.cutoff(tenant, NOW);
      const limited = await purgeEventsBefore(pool, tenant, cutoff, {
        batchSize: 2,
        maxBatches: 2,
      });
      expect(limited).toEqual({ events: 4, rawPayloads: 4, more: true });
      const rest = await purgeEventsBefore(pool, tenant, cutoff, { batchSize: 2 });
      expect(rest).toEqual({ events: 3, rawPayloads: 3, more: false });

      const left = (await listEvents(pool, tenant)).events;
      expect(left.map((e) => e.data.n)).toEqual([10, 11, 12]);
      const raw = await pool.query(
        "SELECT count(*)::int AS n FROM raw_payloads WHERE tenant_id = $1",
        [tenant],
      );
      expect(raw.rows[0].n).toBe(3);
      // Tenant-scoped: the other tenant's expired event is still there.
      expect((await listEvents(pool, other)).events).toHaveLength(1);
      expect(await listTenantsWithEvents(pool)).toEqual(expect.arrayContaining([tenant, other]));
    });

    it("a purged event cannot come back, and seq numbers are not reused", async () => {
      const first = await ingestEvent(pool, tenant, old(1));
      await ingestEvent(pool, tenant, input(2));
      await purgeEventsBefore(pool, tenant, retention.cutoff(tenant, NOW));
      expect(await findEventBySourceId(pool, tenant, "github", first.event!.sourceEventId)).toBe(
        null,
      );
      // A poll or backfill delivers the same object again: dropped, not re-stored.
      const again = await ingestEvent(pool, tenant, old(1), { retention, now: () => NOW });
      expect(again.status).toBe("expired");
      const next = await ingestEvent(pool, tenant, input(3), { retention, now: () => NOW });
      expect(next.event!.seq).toBe(3);
    });

    it("sweeps raw payloads no event references", async () => {
      await pool.query(
        `INSERT INTO raw_payloads (id, tenant_id, source, content_type, body, sha256, size_bytes, received_at)
         VALUES (gen_random_uuid(), $1, 'github', 'text/plain', 'x', repeat('0', 64), 1, $2)`,
        [tenant, new Date(NOW.getTime() - 40 * DAY)],
      );
      const r = await purgeEventsBefore(pool, tenant, retention.cutoff(tenant, NOW));
      expect(r).toEqual({ events: 0, rawPayloads: 1, more: false });
    });

    it("events and raw payloads are no longer append-only at the database level", async () => {
      // Retention deletes rows; immutability of stored events is an application rule.
      await ingestEvent(pool, tenant, input(1));
      const triggers = await pool.query(
        `SELECT tgname FROM pg_trigger
          WHERE NOT tgisinternal AND tgrelid IN ('events'::regclass, 'raw_payloads'::regclass)`,
      );
      expect(triggers.rows).toEqual([]);
      const cols = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'events' AND column_name IN ('prev_hash', 'hash')`,
      );
      expect(cols.rows).toEqual([]);
      expect(
        (await pool.query("SELECT to_regclass('event_chain_heads') AS t")).rows[0].t,
      ).toBeNull();
    });
  });

  it("createPgEventSink implements EventSink", async () => {
    const sink = createPgEventSink(pool);
    expect((await sink.ingest(tenant, input(1))).inserted).toBe(true);
    expect((await sink.ingest(tenant, input(1))).inserted).toBe(false);
  });
});
