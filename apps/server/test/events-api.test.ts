import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  createEd25519ExportSigner,
  generateExportSigningKey,
  verifyExport,
  type CanonicalEventInputLike,
} from "@afe/core";
import { ingestEvent } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, createEventsApiModule } from "../src/index.ts";
import { runVerifyExport } from "../src/verify-export-cli.ts";

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
  const key = generateExportSigningKey();

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
      signer: createEd25519ExportSigner(key.privateKey),
    });
    ({ app } = await buildAfe({ pool, logLevel: "silent", connectors: [mod] }));
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
      "/api/export?format=xml",
      "/api/export?format=csv&raw=true",
      "/api/audit/verify?anchorSeq=1",
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

  it("shows one event with provenance, raw payload and chain verification", async () => {
    const list = (await get("/api/events?source=vercel")).json();
    const id = list.items[0].event.id;
    const res = await get(`/api/events/${id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provenance).toMatchObject({ method: "reconciliation", sourceEventId: "e:3" });
    expect(body.rawPayload).toMatchObject({
      verified: true,
      contentType: "text/html",
      url: `/api/events/${id}/raw`,
    });
    expect(body.chain).toMatchObject({
      seq: 3,
      hashVerified: true,
      prevLinkVerified: true,
      head: { seq: 4 },
    });

    const raw = await get(`/api/events/${id}/raw`);
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe("<script>alert(1)</script>");
    // Never rendered by a browser.
    expect(raw.headers["content-type"]).toBe("application/octet-stream");
    expect(raw.headers["x-content-type-options"]).toBe("nosniff");
    expect(raw.headers["content-disposition"]).toMatch(/^attachment/);
    expect(raw.headers["x-afe-raw-verified"]).toBe("true");

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

  it("verifies the chain and checks a previously recorded head", async () => {
    const res = (await get("/api/audit/verify")).json();
    expect(res.ok).toBe(true);
    expect(res.verification).toMatchObject({ ok: true, count: 4 });
    const head = res.head;
    const anchored = (
      await get(`/api/audit/verify?anchorSeq=${head.seq}&anchorHash=${head.hash}`)
    ).json();
    expect(anchored.anchor).toMatchObject({ found: true, matches: true });
    const wrong = (await get(`/api/audit/verify?anchorSeq=2&anchorHash=${head.hash}`)).json();
    expect(wrong.ok).toBe(false);
    expect(wrong.anchor.matches).toBe(false);
  });

  it.each(["json", "csv"] as const)(
    "exports %s that verifies offline, and detects tampering",
    async (format) => {
      const res = await get(`/api/export?format=${format}&view=deployments&environment=production`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(
        /attachment; filename="afe-export-default-/,
      );
      const r = verifyExport(res.body, {
        trustedPublicKeys: [key.publicKey],
        expectedTenantId: "default",
      });
      expect(r.errors).toEqual([]);
      expect(r.signature.status).toBe("valid_trusted");
      expect(r.eventCount).toBe(2);
      expect(r.manifest!.chainHead.seq).toBe(4);
      expect(r.manifest!.filter.actions).toContain("argocd.sync.*");

      const tampered = res.body.replace("alice", "mallory");
      expect(verifyExport(tampered, { trustedPublicKeys: [key.publicKey] }).ok).toBe(false);
      expect(verifyExport(res.body, { expectedTenantId: "other" }).ok).toBe(false);
    },
  );

  it("exports the complete chain with raw payloads", async () => {
    const res = await get("/api/export?raw=true");
    const r = verifyExport(res.body, { trustedPublicKeys: [key.publicKey] });
    expect(r.errors).toEqual([]);
    expect(r.proofs.completeChain).toBe(true);
    expect(r.manifest!.includesRawPayloads).toBe(true);
    const other = verifyExport((await get("/api/export", "other")).body);
    expect(other.manifest!.tenantId).toBe("other");
    expect(other.eventCount).toBe(1);
  });

  it("serves the export public key", async () => {
    expect((await get("/api/export/public-key")).json()).toEqual({
      algorithm: "ed25519",
      keyId: key.keyId,
      publicKey: key.publicKey,
    });
  });

  it("afe verify-export CLI verifies and reports failures", async () => {
    const body = (await get("/api/export?format=csv")).body;
    const files: Record<string, string> = {
      "good.csv": body,
      "bad.csv": body.replaceAll("octocat", "octodog"),
      "key.txt": key.publicKey,
    };
    let out = "";
    const io = {
      readFile: async (p: string) => new TextEncoder().encode(files[p]!),
      out: (t: string) => void (out += t),
    };
    expect(
      await runVerifyExport(["good.csv", "--public-key", "key.txt", "--require-signature"], io),
    ).toBe(0);
    expect(out).toMatch(/^VERIFIED/);
    expect(out).toMatch(/complete chain proven: {2}yes/);
    out = "";
    expect(await runVerifyExport(["bad.csv"], io)).toBe(1);
    expect(out).toMatch(/^FAILED/);
    expect(out).toMatch(/hash_mismatch/);
    expect(await runVerifyExport([], io)).toBe(2);
  });

  it("is registered by default", async () => {
    const { app: def } = await buildAfe({
      pool,
      logLevel: "silent",
      connectors: (await import("../src/index.ts")).defaultModules,
    });
    expect((await def.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(200);
    expect((await def.inject({ method: "GET", url: "/api/export/public-key" })).statusCode).toBe(
      404,
    );
    await def.close();
  });
});
