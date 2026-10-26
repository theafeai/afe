import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  EventValidationError,
  hashEvent,
  observationGapClosed,
  observationGapOpened,
  verifyChain,
  type CanonicalEventInputLike,
} from "@afe/core";
import {
  createPgEventSink,
  findEventBySourceId,
  getEvent,
  ingestEvent,
  listEvents,
  verifyTenantChain,
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

  it("appends a hash-chained event and reads it back identically", async () => {
    const a = await ingestEvent(pool, tenant, input(1));
    const b = await ingestEvent(pool, tenant, input(2));
    expect(a.inserted).toBe(true);
    expect(a.event.seq).toBe(1);
    expect(b.event.seq).toBe(2);
    expect(b.event.prevHash).toBe(a.event.hash);

    const read = await getEvent(pool, tenant, a.event.id);
    expect(read).toEqual(a.event);
    expect(hashEvent(read!)).toBe(a.event.hash);
    expect(await getEvent(pool, "default", a.event.id)).toBeNull();

    const raw = await pool.query(
      "SELECT body, content_type, size_bytes FROM raw_payloads WHERE id = $1",
      [a.event.rawPayload!.id],
    );
    expect(raw.rows[0].body.toString("utf8")).toBe('{"deployment":{"id":1},"é":"ü"}');
    expect(raw.rows[0].size_bytes).toBe(Buffer.byteLength('{"deployment":{"id":1},"é":"ü"}'));

    expect(await verifyTenantChain(pool, tenant)).toMatchObject({ ok: true, count: 2 });
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
    expect(viaPoll.inserted).toBe(false);
    expect(viaPoll.event).toEqual(viaWebhook.event);
    expect(viaPoll.event.observation.method).toBe("webhook");
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

  it("keeps a valid gap-free chain under concurrent ingestion, including duplicates", async () => {
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
      const r = await verifyTenantChain(pool, t, { batchSize: 7 });
      expect(r).toMatchObject({ ok: true, count: 40, lastSeq: 40 });
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
    expect(closed.event.data.gap).toMatchObject({ endedAt: "2026-10-01T10:30:00.000Z" });
    expect(closed.event.source).toBe("afe");
    expect(await verifyTenantChain(pool, tenant)).toMatchObject({ ok: true, count: 2 });
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

    // The listed events form a verifiable chain on their own (as an export would).
    const all = await listEvents(pool, tenant, { limit: 1000 });
    expect(verifyChain(all.events, { tenantId: tenant })).toMatchObject({ ok: true, count: 10 });
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

  describe("append-only enforcement", () => {
    it.each([
      ["UPDATE events", "UPDATE events SET outcome = 'failed' WHERE tenant_id = $1"],
      ["DELETE events", "DELETE FROM events WHERE tenant_id = $1"],
      ["UPDATE raw_payloads", "UPDATE raw_payloads SET body = 'x' WHERE tenant_id = $1"],
      ["DELETE raw_payloads", "DELETE FROM raw_payloads WHERE tenant_id = $1"],
    ])("rejects %s", async (_name, sql) => {
      await ingestEvent(pool, tenant, input(1));
      await expect(pool.query(sql, [tenant])).rejects.toThrow(/append-only/);
    });

    it.each(["events", "raw_payloads"])("rejects TRUNCATE %s", async (table) => {
      await expect(pool.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only/);
    });

    it("rejects inserts that do not link to the previous event", async () => {
      const a = await ingestEvent(pool, tenant, input(1));
      await expect(
        pool.query(
          `INSERT INTO events (id, tenant_id, seq, schema_version, source, source_event_id, action,
             actor, target, trigger, outcome, occurred_at, observed_at, recorded_at, observation,
             correlation, data, prev_hash, hash)
           SELECT gen_random_uuid(), tenant_id, 2, schema_version, source, 'forged', action, actor,
             target, trigger, outcome, occurred_at, observed_at, recorded_at, observation,
             correlation, data, repeat('a', 64), repeat('b', 64)
           FROM events WHERE id = $1`,
          [a.event.id],
        ),
      ).rejects.toThrow(/does not link/);
    });
  });

  describe("verifyTenantChain detects tampering done behind the triggers' back", () => {
    // Simulates an attacker with superuser rights who disables the triggers.
    async function tamper(sql: string | string[], params: unknown[]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE events DISABLE TRIGGER USER");
        await client.query("ALTER TABLE raw_payloads DISABLE TRIGGER USER");
        for (const q of Array.isArray(sql) ? sql : [sql]) await client.query(q, params);
        await client.query("ALTER TABLE events ENABLE TRIGGER USER");
        await client.query("ALTER TABLE raw_payloads ENABLE TRIGGER USER");
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    beforeEach(async () => {
      for (let i = 1; i <= 5; i++) await ingestEvent(pool, tenant, input(i));
    });

    it("modification", async () => {
      await tamper(
        `UPDATE events SET actor = jsonb_set(actor, '{login}', '"mallory"')
          WHERE tenant_id = $1 AND seq = 3`,
        [tenant],
      );
      const r = await verifyTenantChain(pool, tenant);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.break).toMatchObject({ kind: "hash_mismatch", seq: 3, index: 2 });
    });

    it("deletion in the middle", async () => {
      await tamper("DELETE FROM events WHERE tenant_id = $1 AND seq = 2", [tenant]);
      const r = await verifyTenantChain(pool, tenant);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.break).toMatchObject({ kind: "seq_gap", seq: 3, expected: 2 });
    });

    it("deletion at the end", async () => {
      await tamper("DELETE FROM events WHERE tenant_id = $1 AND seq = 5", [tenant]);
      const r = await verifyTenantChain(pool, tenant);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.break).toMatchObject({ kind: "head_mismatch", seq: 5 });
    });

    it("reordering", async () => {
      // Swap the positions of events 2 and 4.
      await tamper(
        [
          "UPDATE events SET seq = 1002 WHERE tenant_id = $1 AND seq = 2",
          "UPDATE events SET seq = 2 WHERE tenant_id = $1 AND seq = 4",
          "UPDATE events SET seq = 4 WHERE tenant_id = $1 AND seq = 1002",
        ],
        [tenant],
      );
      const r = await verifyTenantChain(pool, tenant);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.break).toMatchObject({ index: 1, seq: 2 });
    });

    it("raw payload modification", async () => {
      await tamper(
        `UPDATE raw_payloads SET body = convert_to('{"forged":true}', 'UTF8')
          WHERE id = (SELECT raw_payload_id FROM events WHERE tenant_id = $1 AND seq = 4)`,
        [tenant],
      );
      const r = await verifyTenantChain(pool, tenant);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.break).toMatchObject({ kind: "raw_payload_mismatch", seq: 4 });
      expect(await verifyTenantChain(pool, tenant, { checkRawPayloads: false })).toMatchObject({
        ok: true,
      });
    });
  });

  it("createPgEventSink implements EventSink", async () => {
    const sink = createPgEventSink(pool);
    expect((await sink.ingest(tenant, input(1))).inserted).toBe(true);
    expect((await sink.ingest(tenant, input(1))).inserted).toBe(false);
  });
});
