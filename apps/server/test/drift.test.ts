/**
 * Drift API and job (AFE-26) over the AFE-15 synthetic dataset (manual ArgoCD
 * image override, Vercel rollback and CLI deploy without Git, mutable tag):
 * findings with mapping, deterministic ids, transition events, alerts once
 * per transition, auto-resolve, settings, retention, auth and tenancy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { AlertNotification, CanonicalEventInputLike, RetentionPolicy } from "@afe/core";
import { ingestEvent, purgeEventsBefore } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { syntheticInputs } from "../../../docs/research/prototypes/synthetic-dataset.ts";
import { buildAfe, type AfeApp } from "../src/index.ts";
import { createMappingModule } from "../src/mapping/index.ts";
import { createCorrelationModule, correlationService } from "../src/correlation/index.ts";
import { createDriftModule, DRIFT_JOBS, type DriftModule } from "../src/drift/index.ts";
import { tokenMapAuth } from "./helpers/auth.ts";

const A = { authorization: "Bearer admin-a" };
const V = { authorization: "Bearer viewer-a" };
const B = { authorization: "Bearer admin-b" };
const NOW = new Date("2026-10-27T00:00:00Z");

const auth = tokenMapAuth({
  "admin-a": { tenantId: "default", roles: ["admin"] },
  "viewer-a": { tenantId: "default", roles: ["viewer"] },
  "admin-b": { tenantId: "other", roles: ["admin"] },
});

interface Finding {
  id: string;
  type: string;
  status: string;
  severity: string;
  target: { key: string };
  service: { id: string } | null;
  environment: { id: string } | null;
  resolvedByEventId: string | null;
}

describe("drift (AFE-26)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let drift: DriftModule;
  let cutoff: Date | null = null;
  const retention: RetentionPolicy = { cutoff: () => cutoff, maxWindowMs: null };
  const sent: AlertNotification[] = [];
  let failNext = 0;

  const call = (method: string, url: string, headers: Record<string, string>, body?: unknown) =>
    afe.app.inject({
      method: method as "GET",
      url,
      headers: {
        ...headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  const get = (url: string, h = V) => call("GET", url, h);
  const findings = async (q = ""): Promise<Finding[]> => {
    const res = await get(`/api/drift/findings${q}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().findings;
  };
  const one = async (type: string, target?: string) => {
    const fs = (await findings()).filter(
      (f) => f.type === type && (!target || f.target.key === target),
    );
    expect(fs).toHaveLength(1);
    return fs[0]!;
  };
  const runJob = async () => {
    const job = afe.jobDefinitions.find((j) => j.name === DRIFT_JOBS.EVALUATE)!;
    await job.handler({});
  };
  const driftEvents = async (action: string) =>
    (
      await pool.query<{ data: { finding: { id: string } } }>(
        "SELECT data FROM events WHERE tenant_id = 'default' AND action = $1",
        [action],
      )
    ).rows.map((r) => r.data.finding.id);
  const alerts = (status: string, findingId?: string) =>
    sent.filter((a) => a.status === status && (!findingId || a.alertId === findingId));
  const refresh = () => correlationService(afe.context)!.invalidate();

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
    for (const { id: _id, ...input } of syntheticInputs) await ingestEvent(pool, "default", input);
    drift = createDriftModule({
      now: () => NOW,
      defaultAlertTypes: ["manual_override", "untracked_deploy"],
      maxStaleMs: 0,
      alertSink: {
        async send(a) {
          if (failNext > 0) {
            failNext--;
            throw new Error("webhook down");
          }
          sent.push(a);
        },
      },
    });
    afe = await buildAfe({
      pool,
      logLevel: "silent",
      authProvider: auth,
      retentionPolicy: retention,
      connectors: [
        createMappingModule(),
        createCorrelationModule({ now: () => NOW, minRecomputeMs: 0 }),
        drift,
      ],
    });
    for (const s of [
      { id: "shop-api", name: "Shop API" },
      { id: "web", name: "Web" },
    ])
      expect((await call("POST", "/api/mapping/services", A, s)).statusCode).toBe(201);
    for (const r of [
      { field: "argocd.application", match: "glob", pattern: "shop-api-*", targetId: "shop-api" },
      { field: "vercel.project", match: "exact", pattern: "web", targetId: "web" },
    ])
      expect(
        (await call("POST", "/api/mapping/rules", A, { kind: "service", ...r })).statusCode,
      ).toBe(201);
  });
  afterAll(async () => {
    await afe.app.close();
    await pool.end();
  });

  it("lists findings of every scenario with service and environment from the mapping", async () => {
    const res = await get("/api/drift/findings");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts).toEqual({ open: 3, resolved: 1 });
    const fs: Finding[] = body.findings;
    expect(fs.map((f) => [f.type, f.status]).sort()).toEqual([
      ["ambiguous_attribution", "open"],
      ["manual_override", "open"],
      ["out_of_band_change", "resolved"],
      ["untracked_deploy", "open"],
    ]);
    const mo = fs.find((f) => f.type === "manual_override")!;
    expect(mo).toMatchObject({
      severity: "high",
      target: { key: "argocd:argocd/shop-api-production" },
      service: { id: "shop-api" },
      environment: { id: "production" },
    });
    // The worker is not mapped: explicit unmapped service.
    expect(fs.find((f) => f.type === "ambiguous_attribution")!.service).toBeNull();
  });

  it("filters by status, type, severity, service and environment", async () => {
    expect(await findings("?status=open")).toHaveLength(3);
    expect(
      (await findings("?type=manual_override,untracked_deploy")).map((f) => f.type).sort(),
    ).toEqual(["manual_override", "untracked_deploy"]);
    expect((await findings("?service=web")).map((f) => f.type).sort()).toEqual([
      "out_of_band_change",
      "untracked_deploy",
    ]);
    expect((await findings("?service=_unmapped")).map((f) => f.type)).toEqual([
      "ambiguous_attribution",
    ]);
    expect((await findings("?environment=production&severity=high")).map((f) => f.type)).toEqual([
      "manual_override",
    ]);
    expect((await findings("?limit=2")).length).toBe(2);
    const page1 = (await get("/api/drift/findings?limit=3")).json();
    const page2 = (await get(`/api/drift/findings?limit=3&cursor=${page1.nextCursor}`)).json();
    expect([...page1.findings, ...page2.findings].map((f: Finding) => f.id)).toHaveLength(4);
    expect(page2.nextCursor).toBeNull();
    for (const bad of ["?status=closed", "?type=Bad-Type", "?limit=0", "?cursor=x", "?foo=1"])
      expect((await get(`/api/drift/findings${bad}`)).statusCode, bad).toBe(400);
  });

  it("shows a finding with its evidence (event links) and journey links", async () => {
    const f = await one("untracked_deploy");
    const res = await get(`/api/drift/findings/${f.id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json().finding;
    expect(d.explanation).toContain("no commit or Git metadata");
    expect(d.evidence.length).toBeGreaterThanOrEqual(2);
    for (const e of d.evidence) {
      expect(e).toMatchObject({ available: true, url: `/api/events/${e.eventId}` });
      expect(e.summary).toBeTruthy();
    }
    expect(d.journeys[0].url).toMatch(/^\/api\/journeys\?repository=.+&commit=[0-9a-f]{40}$/);
    expect(d.alert).toMatchObject({ enabled: true });
    expect((await get("/api/drift/findings/not-a-uuid")).statusCode).toBe(404);
  });

  it("summarises open findings per matrix cell and target", async () => {
    const res = await get("/api/drift/summary");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.open).toBe(3);
    expect(body.cells).toContainEqual(
      expect.objectContaining({
        service: "shop-api",
        environment: "production",
        open: 1,
        maxSeverity: "high",
        byType: { manual_override: 1 },
      }),
    );
    expect(body.targets).toContainEqual(
      expect.objectContaining({ targetKey: "vercel:web:production", open: 1 }),
    );
  });

  it("repeated evaluation keeps the same ids and does not duplicate", async () => {
    const before = (await findings()).map((f) => f.id).sort();
    await runJob();
    await runJob();
    refresh();
    const after = (await findings()).map((f) => f.id).sort();
    expect(after).toEqual(before);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM drift_findings");
    expect(rows[0].n).toBe(4);
  });

  it("records drift.finding.opened / resolved events once", async () => {
    expect((await driftEvents("drift.finding.opened")).length).toBe(4);
    // The rollback finding was already resolved when first seen: both transitions recorded.
    const oob = await one("out_of_band_change");
    expect(await driftEvents("drift.finding.resolved")).toEqual([oob.id]);
  });

  it("alerts once per transition, only for the configured types", async () => {
    await runJob();
    const mo = await one("manual_override");
    const ut = await one("untracked_deploy");
    expect(
      alerts("opened")
        .map((a) => a.alertId)
        .sort(),
    ).toEqual([mo.id, ut.id].sort());
    const a = alerts("opened", mo.id)[0]!;
    expect(a).toMatchObject({
      kind: "drift_manual_override",
      source: "argocd",
      drift: { findingId: mo.id, severity: "high", service: "Shop API", url: `/drift/${mo.id}` },
    });
    expect(a.message).toContain("Manual image override");
  });

  it("auto-resolves when a Git-traced deploy replaces an untracked one; alert and event once", async () => {
    const ut = await one("untracked_deploy");
    const input: CanonicalEventInputLike = {
      source: "vercel",
      sourceEventId: "deployment:dpl_git9:succeeded",
      action: "deployment.status_updated",
      actor: { type: "user", login: "kim" },
      target: {
        type: "deployment",
        id: "dpl_git9",
        project: "web",
        environment: "production",
        repository: "acme/web",
      },
      trigger: { type: "push" },
      outcome: "succeeded",
      occurredAt: "2026-10-26T12:00:00.000Z",
      observedAt: "2026-10-26T12:00:01.000Z",
      observation: { method: "webhook" },
      correlation: {
        commitShas: ["9".repeat(40)],
        repositories: ["github.com/acme/web"],
        environments: ["production"],
        deploymentIds: ["vercel:dpl_git9"],
      },
      data: {},
    };
    const { event } = await ingestEvent(pool, "default", input);
    const resolved = await one("untracked_deploy");
    expect(resolved).toMatchObject({ id: ut.id, status: "resolved", resolvedByEventId: event!.id });
    await runJob();
    await runJob();
    expect(alerts("resolved", ut.id)).toHaveLength(1);
    expect(alerts("opened", ut.id)).toHaveLength(1);
    expect((await driftEvents("drift.finding.resolved")).filter((x) => x === ut.id)).toHaveLength(
      1,
    );
  });

  it("retries a failed alert on the next run, then sends it once", async () => {
    await call("PUT", "/api/drift/settings", A, {
      alertTypes: ["manual_override", "untracked_deploy", "ambiguous_attribution"],
    });
    // Alerting applies to transitions seen after the change: a new CLI deploy.
    const input: CanonicalEventInputLike = {
      source: "vercel",
      sourceEventId: "deployment:dpl_cli9:succeeded",
      action: "deployment.status_updated",
      actor: { type: "user", login: "frank" },
      target: { type: "deployment", id: "dpl_cli9", project: "web", environment: "production" },
      trigger: { type: "cli" },
      outcome: "succeeded",
      occurredAt: "2026-10-26T13:00:00.000Z",
      observedAt: "2026-10-26T13:00:01.000Z",
      observation: { method: "webhook" },
      correlation: { environments: ["production"], deploymentIds: ["vercel:dpl_cli9"] },
      data: {},
    };
    await ingestEvent(pool, "default", input);
    failNext = 1;
    await runJob();
    const f = (await findings("?status=open&type=untracked_deploy"))[0]!;
    expect(alerts("opened", f.id)).toHaveLength(0);
    const { rows } = await pool.query(
      "SELECT notify_attempts, last_notify_error FROM drift_findings WHERE id = $1",
      [f.id],
    );
    expect(rows[0]).toMatchObject({ notify_attempts: 1, last_notify_error: "Error: webhook down" });
    await runJob();
    await runJob();
    expect(alerts("opened", f.id)).toHaveLength(1);
  });

  describe("settings", () => {
    it("viewer reads, admin changes; severity applies to findings", async () => {
      const r = await get("/api/drift/settings");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        alertTypesSource: "settings",
        severities: { manual_override: "high" },
      });
      expect((await call("PUT", "/api/drift/settings", V, { severities: {} })).statusCode).toBe(
        403,
      );
      const put = await call("PUT", "/api/drift/settings", A, {
        severities: { manual_override: "critical" },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().severities.manual_override).toBe("critical");
      expect((await one("manual_override")).severity).toBe("critical");
      for (const body of [
        { alertTypes: ["nope"] },
        { severities: { manual_override: "urgent" } },
        { severities: { nope: "low" } },
        { other: 1 },
        [],
      ])
        expect(
          (await call("PUT", "/api/drift/settings", A, body)).statusCode,
          JSON.stringify(body),
        ).toBe(400);
      // null returns to the server default (AFE_DRIFT_ALERTS).
      const reset = await call("PUT", "/api/drift/settings", A, { alertTypes: null });
      expect(reset.json()).toMatchObject({
        alertTypesSource: "environment",
        alertTypes: ["manual_override", "untracked_deploy"],
      });
    });
  });

  describe("auth and tenancy", () => {
    it("declares access levels: reads viewer, settings change admin", () => {
      const access = (method: string, url: string) =>
        afe.routes.find((r) => r.method === method && r.url === url)?.access;
      expect(access("GET", "/api/drift/findings")).toBe("viewer");
      expect(access("GET", "/api/drift/findings/:id")).toBe("viewer");
      expect(access("GET", "/api/drift/summary")).toBe("viewer");
      expect(access("GET", "/api/drift/settings")).toBe("viewer");
      expect(access("PUT", "/api/drift/settings")).toBe("admin");
    });

    it("401 without credentials", async () => {
      for (const url of ["/api/drift/findings", "/api/drift/summary", "/api/drift/settings"])
        expect((await call("GET", url, {})).statusCode, url).toBe(401);
    });

    it("another tenant sees nothing and gets 404 for this tenant's finding", async () => {
      const mo = await one("manual_override");
      expect((await get(`/api/drift/findings/${mo.id}`, B)).statusCode).toBe(404);
      const list = (await get("/api/drift/findings", B)).json();
      expect(list.findings).toEqual([]);
      expect((await get("/api/drift/summary", B)).json().open).toBe(0);
      expect((await get("/api/drift/settings", B)).json().severities.manual_override).toBe("high");
    });
  });

  describe("retention", () => {
    it("a finding whose events were purged still renders, with the evidence marked unavailable", async () => {
      const mo = await one("manual_override");
      // Purge the override change (02:10) but keep the sync (02:11).
      cutoff = new Date("2026-10-22T02:10:30Z");
      await purgeEventsBefore(pool, "default", cutoff);
      refresh();
      const res = await get(`/api/drift/findings/${mo.id}`);
      expect(res.statusCode).toBe(200);
      const d = res.json().finding;
      expect(d.status).toBe("open");
      const override = d.evidence.find((e: { role: string }) => e.role === "override");
      expect(override).toMatchObject({ available: false, url: null });
      expect(override.summary).toContain("kustomize");
      expect(d.eventsPurged).toBeGreaterThanOrEqual(1);
    });

    it("findings that ended or were last seen before the cutoff are deleted", async () => {
      cutoff = new Date("2026-10-26T12:30:00Z");
      await purgeEventsBefore(pool, "default", cutoff);
      refresh();
      await runJob();
      const left = await findings();
      // Only findings seen after the cutoff remain (the CLI deploy at 13:00).
      expect(left.map((f) => f.type)).toEqual(["untracked_deploy"]);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM drift_findings WHERE COALESCE(resolved_at, last_seen_at) < $1",
        [cutoff.toISOString()],
      );
      expect(rows[0].n).toBe(0);
    });
  });
});
