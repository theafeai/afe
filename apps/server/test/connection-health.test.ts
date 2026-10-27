import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createMemoryEventSink,
  type AlertNotification,
  type CanonicalEvent,
  type Connection,
  type MemoryEventSink,
  type ProbeResult,
} from "@afe/core";
import { getConnectionHealth, listAlerts, upsertConnection } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import {
  buildAfe,
  createHealthModule,
  InlineJobQueue,
  type AfeApp,
  type ConnectorModule,
  type HealthModule,
  type HealthService,
} from "../src/index.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const MIN = 60_000;

/** A fake connector: probe results are set per connection; backfills are recorded. */
class FakeConnector {
  readonly results = new Map<string, ProbeResult>();
  readonly backfills: { connectionId: string; from: Date; to: Date }[] = [];
  readonly probes = new Map<string, number>();
  probeCount(id: string) {
    return this.probes.get(id) ?? 0;
  }
  constructor(readonly source: string) {}
  module(): ConnectorModule {
    return {
      source: this.source,
      health: () => ({
        source: this.source,
        probe: async (c: Connection) => {
          this.probes.set(c.id, this.probeCount(c.id) + 1);
          return this.results.get(c.id) ?? { ok: true };
        },
        backfill: async (c: Connection, from: Date, to: Date) => {
          this.backfills.push({ connectionId: c.id, from, to });
        },
      }),
    };
  }
}

describe("connection health", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let jobs: InlineJobQueue;
  let sink: MemoryEventSink;
  let module: HealthModule;
  let service: HealthService;
  const alerts: AlertNotification[] = [];
  const connectors = {
    github: new FakeConnector("github"),
    argocd: new FakeConnector("argocd"),
    vercel: new FakeConnector("vercel"),
  };
  // Monotonic test clock shared by every test in this file.
  let clock = Date.now() + MIN;
  const now = () => new Date(clock);
  const advance = (ms: number) => {
    clock += ms;
    return now();
  };

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
    jobs = new InlineJobQueue();
    sink = createMemoryEventSink();
    module = createHealthModule({
      env: {},
      now,
      random: () => 0,
      alertSink: { send: async (a) => void alerts.push(a) },
    });
    afe = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      jobs,
      sink,
      connectors: [
        connectors.github.module(),
        connectors.argocd.module(),
        connectors.vercel.module(),
        module,
      ],
    });
    jobs.register(afe.jobDefinitions);
    service = module.service(afe.context);
  });
  afterAll(async () => {
    await afe.app.close();
    await pool.end();
  });

  let seq = 0;
  async function connect(source: string, tenantId = "default") {
    seq += 1;
    return upsertConnection(pool, tenantId, {
      source,
      externalId: `ext-${seq}`,
      name: `${source}-${seq}`,
      status: "active",
    });
  }
  async function probe() {
    await jobs.send("health.probe", {});
    await jobs.drain();
  }
  async function alertCheck() {
    await jobs.send("health.alert-check", {});
    await jobs.drain();
  }
  const gapEvents = (connectionId: string, tenantId = "default"): CanonicalEvent[] =>
    sink
      .events(tenantId)
      .filter((e) => e.connectionId === connectionId && e.action.startsWith("observation_gap."));
  const health = async (id: string, tenantId = "default") =>
    (await getConnectionHealth(pool, tenantId, id))!.health!;

  it("exposes ctx.health to connectors", () => {
    expect(afe.context.health).toBe(service);
  });

  describe.each(["github", "argocd", "vercel"] as const)("simulated %s outage", (source) => {
    it("opens one gap, alerts after the threshold, closes it and backfills on recovery", async () => {
      const fake = connectors[source];
      const c = await connect(source);

      // Healthy first observation.
      const t0 = now();
      await probe();
      let h = await health(c.id);
      expect(h.state).toBe("healthy");
      expect(h.lastSuccessAt).toEqual(t0);
      expect(h.nextAttemptAt).toEqual(new Date(t0.getTime() + 5 * MIN));

      // Outage starts; next probe is due after 5 minutes.
      fake.results.set(c.id, { ok: false, reason: "unreachable", detail: "ECONNREFUSED" });
      const t1 = advance(6 * MIN);
      await probe();
      h = await health(c.id);
      expect(h.state).toBe("unreachable");
      expect(h.consecutiveFailures).toBe(1);
      let gaps = gapEvents(c.id);
      expect(gaps.map((e) => e.action)).toEqual(["observation_gap.opened"]);
      const gap = (gaps[0]!.data as { gap: Record<string, unknown> }).gap;
      // The gap starts at the last successful observation, not at the failure.
      expect(gap).toMatchObject({
        connectionId: c.id,
        source,
        startedAt: t0.toISOString(),
        reason: "connection_error",
        detail: "ECONNREFUSED",
      });
      expect(gaps[0]!.occurredAt).toBe(t0.toISOString());
      // Backoff: 30s after the first failure.
      expect(h.nextAttemptAt).toEqual(new Date(t1.getTime() + 30_000));

      // Repeated failures extend the gap without new gap events.
      for (let i = 0; i < 3; i++) {
        advance(10 * MIN);
        await probe();
      }
      await service.reportFailure("default", c.id, "unreachable", "again");
      expect((await health(c.id)).consecutiveFailures).toBe(5);
      expect(gapEvents(c.id)).toHaveLength(1);

      // Blind for > 15 minutes: alert opened (once), recorded as an audit event.
      await alertCheck();
      await alertCheck();
      const opened = alerts.filter((a) => a.connectionId === c.id);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ status: "opened", source, blindSince: t0.toISOString() });
      expect(
        sink
          .events("default")
          .filter((e) => e.connectionId === c.id && e.action === "connection.alert.opened"),
      ).toHaveLength(1);

      // Recovery: gap closed, backfill invoked with the gap window, alert resolved.
      fake.results.delete(c.id);
      const tRecover = advance(15 * MIN);
      await probe();
      h = await health(c.id);
      expect(h.state).toBe("healthy");
      expect(h.openGapId).toBeNull();
      gaps = gapEvents(c.id);
      expect(gaps.map((e) => e.action)).toEqual([
        "observation_gap.opened",
        "observation_gap.closed",
      ]);
      expect((gaps[1]!.data as { gap: Record<string, unknown> }).gap).toMatchObject({
        startedAt: t0.toISOString(),
        endedAt: tRecover.toISOString(),
      });
      expect(fake.backfills.filter((b) => b.connectionId === c.id)).toEqual([
        { connectionId: c.id, from: t0, to: tRecover },
      ]);
      expect(h.lastBackfillStatus).toBe("succeeded");
      expect(alerts.filter((a) => a.connectionId === c.id).map((a) => a.status)).toEqual([
        "opened",
        "resolved",
      ]);
      expect((await listAlerts(pool, "default", { connectionId: c.id }))[0]!.resolvedAt).toEqual(
        tRecover,
      );
      expect(
        sink
          .events("default")
          .filter((e) => e.connectionId === c.id && e.action === "connection.alert.resolved"),
      ).toHaveLength(1);

      // A second recovery report does nothing new.
      await service.reportSuccess("default", c.id, advance(1000));
      expect(gapEvents(c.id)).toHaveLength(2);
    });
  });

  it("uses exponential backoff with a cap", async () => {
    const at = now();
    const delays = [1, 2, 3, 4, 5, 6, 10].map(
      (n) => service.nextAttemptAfterFailure("unreachable", n, at).getTime() - at.getTime(),
    );
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it("honours Retry-After for rate limits", async () => {
    const c = await connect("vercel");
    const at = now();
    const retryAfter = new Date(at.getTime() + 20 * MIN);
    connectors.vercel.results.set(c.id, {
      ok: false,
      reason: "rate_limited",
      detail: "HTTP 429",
      retryAfter,
    });
    await probe();
    const h = await health(c.id);
    expect(h.state).toBe("rate_limited");
    expect(h.nextAttemptAt).toEqual(retryAfter);
    expect(await service.canAttempt("default", c.id, new Date(at.getTime() + MIN))).toBe(false);

    // Not probed again before Retry-After.
    const before = connectors.vercel.probeCount(c.id);
    advance(10 * MIN);
    await probe();
    expect(connectors.vercel.probeCount(c.id)).toBe(before);
    advance(11 * MIN);
    connectors.vercel.results.delete(c.id);
    await probe();
    expect((await health(c.id)).state).toBe("healthy");
  });

  it("keeps the gap open on revocation, retries slowly and ignores webhook successes", async () => {
    const c = await connect("github");
    await probe();
    connectors.github.results.set(c.id, {
      ok: false,
      reason: "revoked",
      detail: "app uninstalled",
    });
    const tFail = advance(6 * MIN);
    await probe();
    let h = await health(c.id);
    expect(h.state).toBe("revoked");
    expect(h.openGapReason).toBe("auth_failed");
    expect(h.nextAttemptAt).toEqual(new Date(tFail.getTime() + 60 * MIN));

    // A webhook still arriving does not close the gap.
    await service.reportSuccess("default", c.id, advance(1000), { via: "webhook" });
    h = await health(c.id);
    expect(h.openGapId).not.toBeNull();
    expect(h.state).toBe("revoked");

    // No hammering: not probed again within the hour.
    const before = connectors.github.probeCount(c.id);
    advance(30 * MIN);
    await probe();
    expect(connectors.github.probeCount(c.id)).toBe(before);
    expect(gapEvents(c.id)).toHaveLength(1);

    // Credentials fixed: next slow probe closes the gap.
    connectors.github.results.delete(c.id);
    advance(31 * MIN);
    await probe();
    expect((await health(c.id)).state).toBe("healthy");
    expect(gapEvents(c.id)).toHaveLength(2);
  });

  it("is safe under concurrent reports: one gap per outage", async () => {
    const c = await connect("argocd");
    await service.reportSuccess("default", c.id, now());
    const at = advance(1000);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.reportFailure("default", c.id, "error", `HTTP 50${i % 4}`, undefined, at),
      ),
    );
    expect(gapEvents(c.id)).toHaveLength(1);
    expect((await health(c.id)).consecutiveFailures).toBe(8);
    const rec = advance(1000);
    await Promise.all(Array.from({ length: 8 }, () => service.reportSuccess("default", c.id, rec)));
    expect(gapEvents(c.id).map((e) => e.action)).toEqual([
      "observation_gap.opened",
      "observation_gap.closed",
    ]);
    await jobs.drain();
  });

  it("ignores out-of-order reports", async () => {
    const c = await connect("vercel");
    const tOk = now();
    await service.reportSuccess("default", c.id, tOk);
    // A failure observed before the last success does not open a gap.
    await service.reportFailure("default", c.id, "unreachable", "x", undefined, new Date(+tOk - 1));
    expect((await health(c.id)).openGapId).toBeNull();
    // A success observed before the last failure does not close one.
    const tFail = advance(1000);
    await service.reportFailure("default", c.id, "unreachable", "x", undefined, tFail);
    await service.reportSuccess("default", c.id, new Date(+tFail - 1));
    expect((await health(c.id)).openGapId).not.toBeNull();
    await service.reportSuccess("default", c.id, advance(1000));
    expect((await health(c.id)).openGapId).toBeNull();
    await jobs.drain();
  });

  it("records an afe_unavailable gap when Afe was not observing", async () => {
    const c = await connect("argocd");
    const t0 = now();
    await service.reportSuccess("default", c.id, t0, { via: "probe" });
    const tBack = advance(45 * MIN); // no probes ran for 45 minutes
    await probe();
    const gaps = gapEvents(c.id);
    expect(gaps.map((e) => e.action)).toEqual(["observation_gap.opened", "observation_gap.closed"]);
    expect((gaps[1]!.data as { gap: Record<string, unknown> }).gap).toMatchObject({
      reason: "afe_unavailable",
      startedAt: t0.toISOString(),
      endedAt: tBack.toISOString(),
    });
    expect(connectors.argocd.backfills.filter((b) => b.connectionId === c.id)).toEqual([
      { connectionId: c.id, from: t0, to: tBack },
    ]);
    expect((await health(c.id)).state).toBe("healthy");
  });

  it("never stores credentials in gap details", async () => {
    const c = await connect("github");
    await service.reportSuccess("default", c.id, now());
    await service.reportFailure(
      "default",
      c.id,
      "unauthorized",
      "401 for https://user:pw@api.example.com/x?access_token=abc Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123",
      undefined,
      advance(1000),
    );
    const detail = JSON.stringify(gapEvents(c.id)[0]!.data);
    expect(detail).not.toMatch(/ghp_|abc\b|pw@|Bearer gh/);
    expect((await health(c.id)).lastError).toContain("[REDACTED]");
  });

  it("keeps tenants apart", async () => {
    const c = await connect("vercel", "other");
    await service.reportFailure("default", c.id, "unreachable", "x");
    expect((await getConnectionHealth(pool, "other", c.id))!.health).toBeNull();
    expect(await getConnectionHealth(pool, "default", c.id)).toBeNull();
    const res = await afe.app.inject({ method: "GET", url: `/api/connections/${c.id}/health` });
    expect(res.statusCode).toBe(404);
    const list = await afe.app.inject({ method: "GET", url: "/api/connections" });
    expect(list.json().connections.map((x: { id: string }) => x.id)).not.toContain(c.id);
  });

  it("serves connection health and gap history over the API", async () => {
    const c = await connect("github");
    const t0 = now();
    await service.reportSuccess("default", c.id, t0);
    await service.reportFailure("default", c.id, "unreachable", "timeout", undefined, advance(MIN));

    const list = await afe.app.inject({ method: "GET", url: "/api/connections" });
    expect(list.statusCode).toBe(200);
    const item = list.json().connections.find((x: { id: string }) => x.id === c.id);
    expect(item).toMatchObject({
      source: "github",
      status: "active",
      health: {
        state: "unreachable",
        lastSuccessAt: t0.toISOString(),
        openGap: { startedAt: t0.toISOString(), reason: "connection_error" },
      },
      alert: null,
    });
    expect(item.config).toBeUndefined();

    const tEnd = advance(MIN);
    await service.reportSuccess("default", c.id, tEnd);
    await jobs.drain();
    // Gap history is read from the audit log; this test uses the memory sink,
    // so copy the events into the database through the real sink.
    const { createPgEventSink } = await import("@afe/db");
    const pgSink = createPgEventSink(pool);
    for (const e of gapEvents(c.id)) {
      const {
        schemaVersion: _v,
        id: _id,
        seq: _s,
        tenantId: _t,
        recordedAt: _r,
        prevHash: _p,
        hash: _h,
        ...rest
      } = e;
      await pgSink.ingest("default", { ...rest, rawPayload: null });
    }
    const res = await afe.app.inject({ method: "GET", url: `/api/connections/${c.id}/health` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connection.health.state).toBe("healthy");
    expect(body.gaps).toEqual([
      expect.objectContaining({
        startedAt: t0.toISOString(),
        endedAt: tEnd.toISOString(),
        reason: "connection_error",
        open: false,
      }),
    ]);
    const bad = await afe.app.inject({ method: "GET", url: "/api/connections/nope/health" });
    expect(bad.statusCode).toBe(404);
  });
});
