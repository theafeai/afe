import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { type CanonicalEventInputLike, type EventSink } from "@afe/core";
import { ingestEvent, createPgEventSink, queryEvents } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, defaultModules, InlineJobQueue, loadConfig, type AfeApp } from "../src/index.ts";
import {
  createMappingModule,
  MAPPING_AUDIT_OUTBOX_JOB,
  SETUP_INFER_JOB,
} from "../src/mapping/index.ts";
import { tokenMapAuth } from "./helpers/auth.ts";

const A = { authorization: "Bearer admin-a" };
const V = { authorization: "Bearer viewer-a" };
const B = { authorization: "Bearer admin-b" };

const auth = tokenMapAuth({
  "admin-a": { tenantId: "default", roles: ["admin"], name: "Alice" },
  "viewer-a": { tenantId: "default", roles: ["viewer"] },
  "admin-b": { tenantId: "other", roles: ["admin"] },
});

let n = 0;
function ev(o: Partial<CanonicalEventInputLike>): CanonicalEventInputLike {
  n++;
  return {
    source: "github",
    sourceEventId: `map:${n}`,
    action: "deployment.status_updated",
    actor: { type: "user", id: "1", login: "octocat" },
    target: { type: "environment", id: "acme/web:Production – web" },
    trigger: { type: "manual" },
    outcome: "succeeded",
    occurredAt: new Date(Date.UTC(2026, 9, 1, 10, n)),
    observedAt: new Date(Date.UTC(2026, 9, 1, 10, n, 30)),
    observation: { method: "webhook" },
    correlation: {},
    ...o,
  };
}

describe("mapping API (AFE-19)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;

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

  const auditEvents = async (tenant = "default") =>
    (
      await queryEvents(pool, tenant, {
        filter: { actions: ["config.mapping.changed"] },
        order: "asc",
        limit: 100,
      })
    ).events;

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
    await ingestEvent(
      pool,
      "default",
      ev({
        target: {
          type: "environment",
          id: "acme/web:Production – web",
          environment: "Production – web",
          repository: "acme/web",
        },
      }),
    );
    await ingestEvent(
      pool,
      "default",
      ev({
        source: "vercel",
        action: "deployment.promoted",
        target: {
          type: "deployment",
          id: "dpl_1",
          name: "web",
          project: "prj_web",
          environment: "production",
        },
      }),
    );
    await ingestEvent(
      pool,
      "default",
      ev({
        source: "argocd",
        action: "argocd.sync.succeeded",
        target: {
          type: "application",
          id: "argocd/payments",
          name: "payments",
          application: "payments",
          project: "team-pay",
          namespace: "payments",
          cluster: "https://eu-1.example.com",
        },
        rawPayload: {
          contentType: "application/json",
          body: JSON.stringify({
            application: { metadata: { name: "payments", labels: { tier: "prod", team: "pay" } } },
          }),
        },
      }),
    );
    afe = await buildAfe({
      pool,
      logLevel: "silent",
      config: loadConfig({ DATABASE_URL: "unused" }),
      connectors: defaultModules,
      authProvider: auth,
    });
  });
  afterAll(async () => {
    await afe.app.close();
    await pool.end();
  });

  it("starts with no environments (none seeded, D-0009), built-in rules off, no audit events", async () => {
    const res = await call("GET", "/api/mapping", V);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revision).toBe(0);
    expect(body.customised).toBe(false);
    expect(body.environments).toEqual([]);
    expect(body.services).toEqual([]);
    expect(body.builtinRules.length).toBeGreaterThan(5);
    expect(body.builtinRules.every((r: { enabled: boolean }) => !r.enabled)).toBe(true);
    expect(await auditEvents()).toEqual([]);
  });

  it("infers environments from the names the tools report", async () => {
    const job = afe.jobDefinitions.find((j) => j.name === SETUP_INFER_JOB)!;
    expect(job.schedule).toBeDefined();
    await job.handler({ tenantId: "default" });
    const body = (await call("GET", "/api/mapping", V)).json();
    expect(body.environments).toEqual([
      {
        id: "production-web",
        name: "Production – web",
        order: 10,
        kind: "production",
        productionLike: true,
      },
      { id: "production", name: "production", order: 20, kind: "production", productionLike: true },
    ]);
    // Inference wrote no mapping change.
    expect(body.revision).toBe(0);
    expect(await auditEvents()).toEqual([]);
  });

  it("deployments carry a read-time placement; unmapped is explicit", async () => {
    const res = await call("GET", "/api/deployments", V);
    const items = res.json().items as {
      source: string;
      placement: { environment: { id: string } | null; unmapped: string[]; confidence: string };
    }[];
    const vercel = items.find((i) => i.source === "vercel")!;
    expect(vercel.placement).toMatchObject({
      environment: { id: "production", productionLike: true },
      service: null,
      unmapped: ["service"],
      confidence: "partial",
    });
    const argo = items.find((i) => i.source === "argocd")!;
    expect(argo.placement).toMatchObject({ environment: null, confidence: "unmapped" });
  });

  it("viewers read and preview but cannot change the mapping", async () => {
    expect((await call("POST", "/api/mapping/services", V, { name: "Web" })).statusCode).toBe(403);
    expect((await call("POST", "/api/mapping/preview", V, {})).statusCode).toBe(200);
    expect((await call("GET", "/api/mapping/unmapped", V)).statusCode).toBe(200);
    expect((await call("GET", "/api/mapping", {})).statusCode).toBe(401);
    expect((await call("GET", "/api/setup", V)).statusCode).toBe(200);
    expect(
      (
        await call("PATCH", "/api/setup", V, {
          changes: [{ environment: "production", field: "productionLike", value: false }],
        })
      ).statusCode,
    ).toBe(403);
    expect((await call("POST", "/api/setup/infer", V, {})).statusCode).toBe(403);
  });

  let webRuleId = "";
  it("creates services, environments and rules, each audited with who and before/after", async () => {
    const s = await call("POST", "/api/mapping/services", A, { name: "Web shop" });
    expect(s.statusCode).toBe(201);
    expect(s.json().service).toEqual({ id: "web-shop", name: "Web shop", description: null });
    expect((await call("POST", "/api/mapping/services", A, { name: "Web shop" })).statusCode).toBe(
      409,
    );
    const pay = await call("POST", "/api/mapping/services", A, {
      id: "payments",
      name: "Payments",
    });
    expect(pay.statusCode).toBe(201);
    const env = await call("POST", "/api/mapping/environments", A, {
      name: "Prod EU",
      kind: "production",
    });
    expect(env.json().environment).toEqual({
      id: "prod-eu",
      name: "Prod EU",
      kind: "production",
      order: 10,
    });

    const bad = await call("POST", "/api/mapping/rules", A, {
      kind: "environment",
      field: "github.environment",
      match: "regex",
      pattern: "(a+)\\1",
      targetId: "production",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/backreferences/);
    const missing = await call("POST", "/api/mapping/rules", A, {
      kind: "service",
      field: "github.repository",
      match: "exact",
      pattern: "acme/web",
      targetId: "nope",
    });
    expect(missing.statusCode).toBe(400);

    const r1 = await call("POST", "/api/mapping/rules", A, {
      kind: "service",
      field: "github.repository",
      match: "exact",
      pattern: "acme/web",
      targetId: "web-shop",
    });
    expect(r1.statusCode).toBe(201);
    webRuleId = r1.json().rule.id;
    const r2 = await call("POST", "/api/mapping/rules", A, {
      kind: "service",
      field: "vercel.project",
      match: "glob",
      pattern: "web*",
      targetId: "web-shop",
    });
    expect(r2.json().rule.priority).toBe(20);
    const r3 = await call("POST", "/api/mapping/rules", A, {
      kind: "service",
      field: "argocd.label:team",
      match: "exact",
      pattern: "pay",
      targetId: "payments",
    });
    expect(r3.statusCode).toBe(201);
    const r4 = await call("POST", "/api/mapping/rules", A, {
      kind: "environment",
      field: "argocd.cluster",
      match: "regex",
      pattern: "//eu-\\d+\\.",
      targetId: "prod-eu",
    });
    expect(r4.statusCode).toBe(201);

    const audit = await auditEvents();
    expect(audit).toHaveLength(7);
    expect(audit[0]).toMatchObject({
      source: "afe",
      sourceEventId: "config_mapping:1",
      actor: { type: "token", id: "token:admin-a", name: "Alice" },
      data: {
        revision: 1,
        entity: "service",
        operation: "created",
        before: null,
        after: { id: "web-shop", name: "Web shop" },
      },
    });
    expect(audit.at(-1)!.data).toMatchObject({
      entity: "rule",
      operation: "created",
      after: { field: "argocd.cluster", targetId: "prod-eu" },
    });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM mapping_audit_outbox");
    expect(rows[0].n).toBe(0);
  });

  it("resolves deployments with the new rules, including ArgoCD labels from the raw payload", async () => {
    const items = (await call("GET", "/api/deployments", V)).json().items as {
      source: string;
      placement: {
        service: { id: string } | null;
        environment: { id: string } | null;
        confidence: string;
      };
    }[];
    const by = (s: string) => items.find((i) => i.source === s)!.placement;
    // The environment by an inferred rule (counts as a default, not configured).
    expect(by("github")).toMatchObject({
      service: { id: "web-shop" },
      environment: { id: "production-web" },
      confidence: "default",
    });
    expect(by("vercel").service?.id).toBe("web-shop");
    expect(by("argocd")).toMatchObject({
      service: { id: "payments" },
      environment: { id: "prod-eu" },
      confidence: "configured",
    });
  });

  it("updates, reorders, toggles built-ins and refuses to delete targets in use", async () => {
    const upd = await call("PUT", `/api/mapping/rules/${webRuleId}`, A, {
      kind: "service",
      field: "github.repository",
      match: "glob",
      pattern: "acme/*",
      targetId: "web-shop",
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().rule).toMatchObject({ match: "glob", priority: 10 });

    const cfg = (await call("GET", "/api/mapping", V)).json();
    const ids = cfg.rules
      .filter((r: { kind: string }) => r.kind === "service")
      .map((r: { id: string }) => r.id);
    expect(
      (await call("POST", "/api/mapping/rules/reorder", A, { kind: "service", ids: ids.slice(1) }))
        .statusCode,
    ).toBe(400);
    const re = await call("POST", "/api/mapping/rules/reorder", A, {
      kind: "service",
      ids: [...ids].reverse(),
    });
    expect(re.statusCode).toBe(200);
    expect(re.json().rules.map((r: { id: string }) => r.id)).toEqual([...ids].reverse());

    const tog = await call(
      "PUT",
      "/api/mapping/builtin-rules/builtin:vercel-target-production",
      A,
      {
        enabled: false,
      },
    );
    expect(tog.statusCode).toBe(200);
    expect(
      (await call("PUT", "/api/mapping/builtin-rules/builtin:nope", A, { enabled: false }))
        .statusCode,
    ).toBe(404);

    const del = await call("DELETE", "/api/mapping/services/web-shop", A);
    expect(del.statusCode).toBe(409);
    expect(del.json().ruleIds).toHaveLength(2);
    const delEnv = await call("DELETE", "/api/mapping/environments/prod-eu", A);
    expect(delEnv.statusCode).toBe(409);
    // An inferred environment: deleting it on the Mapping page means "not an environment".
    expect((await call("DELETE", "/api/mapping/environments/production", A)).statusCode).toBe(200);
    expect((await call("DELETE", "/api/mapping/environments/nope", A)).statusCode).toBe(404);
    const setup = (await call("GET", "/api/setup", V)).json();
    expect(setup.environments.find((e: { id: string }) => e.id === "production")).toMatchObject({
      origin: "inferred",
      included: { value: false, origin: "admin", via: "override", setBy: { name: "Alice" } },
    });
    const envIds = (await call("GET", "/api/mapping", V))
      .json()
      .environments.map((e: { id: string }) => e.id);
    expect(envIds).toEqual(["prod-eu", "production-web"]);

    const audit = await auditEvents();
    expect(audit.map((e) => `${e.data.entity}:${e.data.operation}`).slice(-4)).toEqual([
      "rule:updated",
      "rule_order:reordered",
      "builtin_rule:updated",
      "environment:deleted",
    ]);
    expect(
      audit.find((e) => e.data.entity === "rule" && e.data.operation === "updated")!.data,
    ).toMatchObject({ before: { match: "exact" }, after: { match: "glob", pattern: "acme/*" } });
  });

  it("previews proposed rules without storing them", async () => {
    const before = (await call("GET", "/api/mapping", V)).json();
    const res = await call("POST", "/api/mapping/preview", V, {
      rules: [
        // Existing rules keep their ids; new ones have none.
        ...before.rules.map((r: Record<string, unknown>) => ({
          id: r.id,
          kind: r.kind,
          field: r.field,
          match: r.match,
          pattern: r.pattern,
          caseSensitive: r.caseSensitive,
          targetId: r.targetId,
          enabled: r.enabled,
          priority: r.priority,
        })),
        {
          kind: "environment",
          field: "vercel.target",
          match: "exact",
          pattern: "production",
          targetId: "prod-eu",
          priority: 1,
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sampleSize).toBe(3);
    expect(body.summary.changed).toBeGreaterThan(0);
    const vercel = body.items.find((i: { source: string }) => i.source === "vercel");
    expect(vercel).toMatchObject({
      changed: true,
      observations: { "vercel.target": ["production"] },
      proposed: { environment: { id: "prod-eu" }, service: { id: "web-shop" } },
    });
    expect(
      (
        await call("POST", "/api/mapping/preview", V, {
          rules: [{ kind: "service", field: "nope", match: "exact", pattern: "x", targetId: "a" }],
        })
      ).statusCode,
    ).toBe(400);
    const after = (await call("GET", "/api/mapping", V)).json();
    expect(after.revision).toBe(before.revision);
  });

  it("lists raw values that no rule maps", async () => {
    // Remove the label service rule: the ArgoCD sync loses its service.
    const cfg = (await call("GET", "/api/mapping", A)).json();
    const label = cfg.rules.find((r: { field: string }) => r.field === "argocd.label:team");
    expect((await call("DELETE", `/api/mapping/rules/${label.id}`, A)).statusCode).toBe(200);
    const res = await call("GET", "/api/mapping/unmapped?limit=50", V);
    expect(res.statusCode).toBe(200);
    const values = res.json().values as { field: string; value: string; missing: string[] }[];
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "argocd.application",
          value: "payments",
          missing: ["service"],
        }),
        expect.objectContaining({ field: "argocd.label:team", value: "pay" }),
      ]),
    );
    expect(values.some((v) => v.field === "github.repository")).toBe(false);
    expect((await call("GET", "/api/mapping/unmapped?limit=0", V)).statusCode).toBe(400);
  });

  it("keeps tenants apart: another tenant sees none of ours and gets 404 for our ids", async () => {
    const b = (await call("GET", "/api/mapping", B)).json();
    expect(b.services).toEqual([]);
    expect(b.environments).toEqual([]);
    expect((await call("GET", "/api/setup", B)).json().environments).toEqual([]);
    expect(b.rules).toEqual([]);
    expect(b.revision).toBe(0);
    expect((await call("PUT", "/api/mapping/services/payments", B, { name: "x" })).statusCode).toBe(
      404,
    );
    expect((await call("DELETE", "/api/mapping/environments/prod-eu", B)).statusCode).toBe(404);
    expect((await call("DELETE", `/api/mapping/rules/${webRuleId}`, B)).statusCode).toBe(404);
    // B's preview and unmapped values see none of A's events.
    expect((await call("POST", "/api/mapping/preview", B, {})).json().sampleSize).toBe(0);
    expect((await call("GET", "/api/mapping/unmapped", B)).json().values).toEqual([]);
    // A's own rule is intact, and B's changes are recorded as B's events only.
    expect((await call("POST", "/api/mapping/services", B, { name: "Payments" })).statusCode).toBe(
      201,
    );
    expect((await auditEvents("other")).map((e) => e.sourceEventId)).toEqual(["config_mapping:1"]);
    const a = (await call("GET", "/api/mapping", A)).json();
    expect(a.services.find((s: { id: string }) => s.id === "payments").name).toBe("Payments");
    expect(a.rules.some((r: { id: string }) => r.id === webRuleId)).toBe(true);
  });
});

describe("mapping audit outbox", () => {
  it("keeps a change's audit event when appending fails, and the job appends it later", async () => {
    const pool = await createTestPool();
    const real = createPgEventSink(pool);
    let fail = true;
    const sink: EventSink = {
      ingest: (t, e) => (fail ? Promise.reject(new Error("db busy")) : real.ingest(t, e)),
    };
    const mod = createMappingModule();
    const afe = await buildAfe({
      pool,
      sink,
      logLevel: "silent",
      config: loadConfig({ DATABASE_URL: "unused" }),
      connectors: [mod],
      authProvider: auth,
    });
    try {
      const res = await afe.app.inject({
        method: "POST",
        url: "/api/mapping/services",
        headers: { ...A, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Web" }),
      });
      expect(res.statusCode).toBe(201);
      const pending = await pool.query("SELECT attempts, last_error FROM mapping_audit_outbox");
      expect(pending.rows).toEqual([{ attempts: 1, last_error: "db busy" }]);
      fail = false;
      const job = afe.jobDefinitions.find((j) => j.name === MAPPING_AUDIT_OUTBOX_JOB)!;
      expect(job.schedule).toBeDefined();
      await job.handler({});
      expect((await pool.query("SELECT * FROM mapping_audit_outbox")).rows).toEqual([]);
      const events = await queryEvents(pool, "default", {
        filter: { actions: ["config.mapping.changed"] },
      });
      expect(events.events.map((e) => e.data.entity)).toEqual(["service"]);
    } finally {
      await afe.app.close();
      await pool.end();
    }
  });
});

describe("setup API: inferred setup and admin overrides (D-0012)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  const jobs = new InlineJobQueue();
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
  const patch = (changes: unknown[], headers = A) =>
    call("PATCH", "/api/setup", headers, { changes });
  const infer = () =>
    afe.jobDefinitions.find((j) => j.name === SETUP_INFER_JOB)!.handler({ tenantId: "default" });
  const envOf = (body: { environments: { id: string }[] }, id: string) =>
    body.environments.find((e) => e.id === id) as unknown as Record<
      string,
      Record<string, unknown>
    >;
  const overrideRows = async (tenant = "default") =>
    (
      await pool.query(
        `SELECT subject, field, value, set_by, set_by_name, set_at, kept_inferred
           FROM setup_overrides WHERE tenant_id = $1 ORDER BY subject, field`,
        [tenant],
      )
    ).rows;

  let m = 0;
  const deploy = (
    env: string,
    sha: string,
    minute: number,
    extra: Partial<CanonicalEventInputLike> = {},
  ) => {
    m++;
    return ev({
      sourceEventId: `setup:${m}`,
      occurredAt: new Date(Date.UTC(2026, 9, 2, 8, minute)),
      observedAt: new Date(Date.UTC(2026, 9, 2, 8, minute, 30)),
      target: {
        type: "deployment",
        id: `acme/web/deployments/${m}`,
        repository: "acme/web",
        environment: env,
      },
      correlation: { environments: [env], commitShas: [sha], deploymentIds: [`github:${m}`] },
      data: {
        deployment: { sha, ref: "main", productionEnvironment: env === "production" },
        run: { event: "push" },
      },
      ...extra,
    });
  };

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
    for (let i = 0; i < 6; i++) {
      const sha = `${i}`.repeat(40);
      await ingestEvent(pool, "default", deploy("staging", sha, i * 8));
      await ingestEvent(pool, "default", deploy("production", sha, i * 8 + 4));
    }
    for (let i = 1; i <= 3; i++) {
      await ingestEvent(
        pool,
        "default",
        deploy(`pr-${i}`, `${i}`.repeat(40).replace(/./, "f"), 50 + i),
      );
    }
    afe = await buildAfe({
      pool,
      jobs,
      logLevel: "silent",
      config: loadConfig({ DATABASE_URL: "unused" }),
      connectors: defaultModules,
      authProvider: auth,
    });
    jobs.register(afe.jobDefinitions);
  });
  afterAll(async () => {
    await afe.app.close();
    await pool.end();
  });

  it("queues inference on first read, then shows every field with its provenance", async () => {
    const first = (await call("GET", "/api/setup", V)).json();
    expect(first.computedAt).toBeNull();
    expect(jobs.sent.map((j) => j.name)).toContain(SETUP_INFER_JOB);
    await jobs.drain();
    const body = (await call("GET", "/api/setup", V)).json();
    expect(body.environments.map((e: { id: string }) => e.id)).toEqual([
      "staging",
      "production",
      "previews",
    ]);
    expect(envOf(body, "production").productionLike).toMatchObject({
      value: true,
      origin: "inferred",
      confidence: "certain",
    });
    expect(envOf(body, "staging").order).toMatchObject({ value: 10, confidence: "strong" });
    expect(envOf(body, "staging").gating).toMatchObject({ value: "automatic", origin: "inferred" });
    expect(envOf(body, "previews").gating).toMatchObject({ value: "per_change" });
    expect(envOf(body, "production").kind).toBe("production");
    expect(body.noticed).toEqual([]);
    expect(body.fields).toContain("productionLike");
  });

  it("admins override fields; each change is audited with who; reads show who and when", async () => {
    const res = await patch([
      { environment: "production", field: "gating", value: "on_demand" },
      { environment: "staging", field: "name", value: "Stage" },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(envOf(body, "production").gating).toMatchObject({
      value: "on_demand",
      origin: "admin",
      via: "override",
      setBy: { id: "token:admin-a", name: "Alice" },
      inferred: { value: "automatic" },
    });
    expect(envOf(body, "staging").name).toMatchObject({ value: "Stage", origin: "admin" });
    // Afe noticed: inference disagrees with the admin's value (reported, not applied).
    expect(body.noticed.map((x: { id: string }) => x.id)).toEqual([
      "disagreement:production:gating",
    ]);
    const audit = await queryEvents(pool, "default", {
      filter: { actions: ["config.mapping.changed"] },
      order: "asc",
    });
    expect(audit.events.at(-1)!.data).toMatchObject({
      entity: "setup",
      after: { changes: [{ environment: "production", field: "gating", value: "on_demand" }, {}] },
    });
    // Placement follows the effective name.
    const items = (await call("GET", "/api/deployments", V)).json().items as {
      placement: { environment: { id: string; name: string } | null };
    }[];
    expect(items.some((i) => i.placement.environment?.name === "Stage")).toBe(true);
  });

  it("inference never overwrites an override: the job has no write path to setup_overrides", async () => {
    const before = await overrideRows();
    expect(before).toHaveLength(2);
    // New data that disagrees even more, then a run.
    await ingestEvent(pool, "default", deploy("production", "a".repeat(40), 200));
    await infer();
    expect(await overrideRows()).toEqual(before);
    const body = (await call("GET", "/api/setup", V)).json();
    expect(envOf(body, "production").gating).toMatchObject({ value: "on_demand", origin: "admin" });

    // Structurally: the inference writer cannot write overrides, and nobody
    // can write them without declaring the admin writer.
    const client = await pool.connect();
    try {
      for (const writer of ["inference", null]) {
        await client.query("BEGIN");
        if (writer) await client.query("SELECT set_config('afe.setup_writer', $1, true)", [writer]);
        await expect(
          client.query(
            "UPDATE setup_overrides SET value = '\"automatic\"' WHERE tenant_id = 'default'",
          ),
        ).rejects.toThrow(/only the admin writer/);
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
    // And the job's module imports no override writer.
    const source = readFileSync(new URL("../src/setup/inference.ts", import.meta.url), "utf8");
    for (const name of ["setSetupOverride", "clearSetupOverrides", "forgetSetupOverrideAuthor"]) {
      expect(source).not.toContain(name);
    }
    expect(source).not.toContain("setup_overrides");
  });

  it("keep silences a disagreement; clear goes back to Afe's guess", async () => {
    const kept = (await patch([{ environment: "production", field: "gating", keep: true }])).json();
    expect(kept.noticed).toEqual([]);
    expect(envOf(kept, "production").gating).toMatchObject({ value: "on_demand", origin: "admin" });
    const cleared = (
      await patch([{ environment: "production", field: "gating", clear: true }])
    ).json();
    expect(envOf(cleared, "production").gating).toMatchObject({
      value: "automatic",
      origin: "inferred",
    });
  });

  it("'not an environment' takes it out of the mapping; validation and admin-only rules hold", async () => {
    expect(
      (await patch([{ environment: "previews", field: "included", value: false }])).statusCode,
    ).toBe(200);
    const mapping = (await call("GET", "/api/mapping", V)).json();
    expect(mapping.environments.map((e: { id: string }) => e.id)).not.toContain("previews");

    expect((await patch([{ environment: "nope", field: "name", value: "x" }])).statusCode).toBe(
      404,
    );
    expect(
      (await patch([{ environment: "production", field: "gating", value: "often" }])).statusCode,
    ).toBe(400);
    expect(
      (await patch([{ environment: "production", field: "kind", value: "x" }])).statusCode,
    ).toBe(400);
    expect(
      (await patch([{ environment: "production", field: "productionLike", value: false }], V))
        .statusCode,
    ).toBe(403);
    // An admin-created environment is deleted on the Mapping page, not excluded here.
    expect((await call("POST", "/api/mapping/environments", A, { name: "EU" })).statusCode).toBe(
      201,
    );
    expect((await patch([{ environment: "eu", field: "included", value: false }])).statusCode).toBe(
      400,
    );
    expect((await call("POST", "/api/setup/infer", A, {})).statusCode).toBe(202);
  });

  it("keeps tenants apart: another tenant sees nothing of ours and cannot change it", async () => {
    const ours = await overrideRows();
    const b = (await call("GET", "/api/setup", B)).json();
    expect(b.environments).toEqual([]);
    expect(b.noticed).toEqual([]);
    expect(
      (await patch([{ environment: "production", field: "productionLike", value: false }], B))
        .statusCode,
    ).toBe(404);
    expect(await overrideRows("other")).toEqual([]);
    expect(await overrideRows()).toEqual(ours);
    // B's inference sees none of A's events.
    await afe.jobDefinitions
      .find((j) => j.name === SETUP_INFER_JOB)!
      .handler({ tenantId: "other" });
    expect((await call("GET", "/api/setup", B)).json().environments).toEqual([]);
  });
});
