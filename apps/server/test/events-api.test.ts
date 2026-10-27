import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { CanonicalEventInputLike } from "@afe/core";
import { ingestEvent } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, createEventsApiModule } from "../src/index.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";

function ev(n: number, o: Partial<CanonicalEventInputLike> = {}): CanonicalEventInputLike {
  return {
    source: "github",
    sourceEventId: `e:${n}`,
    action: "deployment.created",
    actor: { type: "user", id: "1", login: "octocat" },
    target: {
      type: "environment",
      id: "acme/api:production",
      environment: "production",
      repository: "acme/api",
    },
    trigger: { type: "manual", sourceValue: "workflow_dispatch" },
    outcome: "succeeded",
    occurredAt: new Date(Date.UTC(2026, 9, 1, 10, n)),
    observedAt: new Date(Date.UTC(2026, 9, 1, 10, n, 30)),
    observation: { method: "webhook", deliveryId: `d-${n}` },
    correlation: { commitShas: [SHA1] },
    rawPayload: { contentType: "application/json", body: `{"n":${n}}` },
    ...o,
  };
}

describe("events API", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
    // Who deployed what to where, across tools.
    await ingestEvent(pool, "default", ev(1));
    await ingestEvent(pool, "default", ev(2, { action: "workflow_run.completed" }));
    await ingestEvent(
      pool,
      "default",
      ev(3, {
        source: "vercel",
        action: "deployment.promoted",
        actor: { type: "user", id: "u_9", login: "alice" },
        target: {
          type: "project",
          id: "prj_1",
          name: "web",
          project: "web",
          environment: "production",
        },
        trigger: { type: "promotion" },
        observation: { method: "reconciliation" },
        correlation: { commitShas: [SHA2] },
        rawPayload: { contentType: "text/html", body: "<script>alert(1)</script>" },
      }),
    );
    await ingestEvent(
      pool,
      "default",
      ev(4, {
        source: "argocd",
        action: "argocd.sync.succeeded",
        actor: { type: "user", login: "bob" },
        target: {
          type: "application",
          id: "argocd/payments",
          application: "payments",
          environment: "staging",
          cluster: "https://k8s",
        },
        trigger: { type: "auto_sync" },
        observation: { method: "poll" },
        correlation: { commitShas: [SHA1] },
      }),
    );
    await ingestEvent(pool, "other", ev(5, { actor: { type: "user", login: "eve" } }));

    // Test resolver: tenant from a header (stands in for an authenticated principal).
    const mod = createEventsApiModule({
      tenantResolver: { resolveTenant: (r) => (r.headers["x-test-tenant"] as string) ?? "default" },
    });
    ({ app } = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      connectors: [mod],
    }));
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const get = (url: string, tenant?: string) =>
    app.inject({ method: "GET", url, headers: tenant ? { "x-test-tenant": tenant } : {} });

  it("lists events with provenance, filters and pagination", async () => {
    const res = await get("/api/events?limit=2");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].event.seq).toBe(4);
    expect(body.items[0].provenance).toMatchObject({
      method: "poll",
      sourceEventId: "e:4",
      source: "argocd",
    });
    const next = await get(`/api/events?limit=2&cursor=${body.nextCursor}`);
    expect(next.json().items.map((i: { event: { seq: number } }) => i.event.seq)).toEqual([2, 1]);
    expect(next.json().nextCursor).toBeNull();

    const recon = await get("/api/events?method=reconciliation");
    expect(
      recon
        .json()
        .items.map(
          (i: { provenance: { discoveredByReconciliation: boolean } }) =>
            i.provenance.discoveredByReconciliation,
        ),
    ).toEqual([true]);
    const filtered = await get(
      `/api/events?action=deployment.*&commitSha=${SHA1.slice(0, 8)}&order=asc`,
    );
    expect(filtered.json().items.map((i: { event: { seq: number } }) => i.event.seq)).toEqual([1]);
  });

  it("validates parameters", async () => {
    for (const url of [
      "/api/events?limit=501",
      "/api/events?limit=0",
      "/api/events?order=up",
      "/api/events?sauce=github",
      "/api/events?cursor=zzz",
      "/api/events?from=yesterday",
    ]) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
  });

  it("answers who deployed what to where and when", async () => {
    const res = await get("/api/deployments?environment=production&order=asc");
    expect(res.statusCode).toBe(200);
    const rows = res.json().items;
    expect(rows.map((r: { source: string }) => r.source)).toEqual(["github", "vercel"]);
    expect(rows[1]).toMatchObject({
      action: "deployment.promoted",
      when: "2026-10-01T10:03:00.000Z",
      who: { login: "alice" },
      what: { commitShas: [SHA2] },
      where: { environment: "production", project: "web" },
      how: { type: "promotion" },
      provenance: { method: "reconciliation" },
    });
    const all = await get("/api/deployments");
    // workflow runs are not deployments; ArgoCD syncs are.
    expect(all.json().items.map((r: { seq: number }) => r.seq)).toEqual([4, 3, 1]);
  });

  it("shows one event with provenance and its raw payload", async () => {
    const list = (await get("/api/events?source=vercel")).json();
    const id = list.items[0].event.id;
    const res = await get(`/api/events/${id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provenance).toMatchObject({ method: "reconciliation", sourceEventId: "e:3" });
    expect(body.event.seq).toBe(3);
    expect(body.rawPayload).toMatchObject({
      contentType: "text/html",
      url: `/api/events/${id}/raw`,
    });
    expect(body).not.toHaveProperty("chain");
    expect(body.event).not.toHaveProperty("hash");

    const raw = await get(`/api/events/${id}/raw`);
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe("<script>alert(1)</script>");
    // Never rendered by a browser.
    expect(raw.headers["content-type"]).toBe("application/octet-stream");
    expect(raw.headers["x-content-type-options"]).toBe("nosniff");
    expect(raw.headers["content-disposition"]).toMatch(/^attachment/);
    expect(raw.headers["x-afe-raw-sha256"]).toMatch(/^[0-9a-f]{64}$/);

    expect((await get(`/api/events/${id}`, "other")).statusCode).toBe(404);
    expect((await get(`/api/events/${id}/raw`, "other")).statusCode).toBe(404);
    expect((await get("/api/events/not-a-uuid")).statusCode).toBe(404);
  });

  it("is tenant-isolated", async () => {
    const res = (await get("/api/events", "other")).json();
    expect(res.items).toHaveLength(1);
    expect(res.items[0].event.actor.login).toBe("eve");
    expect((await get("/api/events?actor=eve")).json().items).toEqual([]);
  });

  it("is registered by default", async () => {
    const { app: def } = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      connectors: (await import("../src/index.ts")).defaultModules,
    });
    expect((await def.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(200);
    // Export, audit verification and chain anchoring are not part of Afe (ADR 0008).
    for (const url of [
      "/api/export",
      "/api/export?format=csv",
      "/api/export/public-key",
      "/api/audit/verify",
      "/api/audit/anchors",
    ]) {
      expect((await def.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
    expect(
      (await def.inject({ method: "POST", url: "/api/audit/anchors/verify", payload: {} }))
        .statusCode,
    ).toBe(404);
    await def.close();
  });
});
