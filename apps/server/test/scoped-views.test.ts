import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type pg from "pg";
import type { CanonicalEvent } from "@afe/core";
import { EnvKeyProvider } from "@afe/core/security";
import {
  createLocalUser,
  ingestEvent,
  insertDriftFinding,
  setUserToolPolicy,
  type DriftFindingWrite,
} from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, loadConfig, type AfeApp } from "../src/index.ts";
import { createMappingModule } from "../src/mapping/index.ts";
import { createCorrelationModule } from "../src/correlation/index.ts";
import { createDriftModule, type DriftModule } from "../src/drift/index.ts";
import { eventsApiModule } from "../src/api/events.ts";
import { C, syntheticInputs } from "../../../docs/research/prototypes/synthetic-dataset.ts";

const ADMIN = "a".repeat(40),
  NOW = new Date("2026-10-27T00:00:00Z");
let pool: pg.Pool, afe: AfeApp, drift: DriftModule;
let alice: Awaited<ReturnType<typeof createLocalUser>>,
  bob: Awaited<ReturnType<typeof createLocalUser>>;
let events: CanonicalEvent[];
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const get = (url: string, token = alice.token) => afe.app.inject({ url, headers: headers(token) });
const post = (url: string, payload: unknown, token = ADMIN) =>
  afe.app.inject({
    method: "POST",
    url,
    headers: { ...headers(token), "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
async function grant(
  tool: string,
  resources: string[],
  tokenUser = alice,
  mode: "custom" | "none" | "source" | "source + custom" = "custom",
) {
  await setUserToolPolicy(pool, "default", tokenUser.user.id, tool, {
    mode,
    custom: resources.map((resource) => ({ resource, action: "read" })),
  });
}
beforeEach(async () => {
  pool = await createTestPool();
  events = [];
  for (const { id: _id, ...input } of syntheticInputs) {
    const r = await ingestEvent(pool, "default", input);
    events.push(r.event!);
  }
  drift = createDriftModule({ now: () => NOW });
  afe = await buildAfe({
    pool,
    logLevel: "silent",
    config: loadConfig({ DATABASE_URL: "unused", AFE_ADMIN_TOKEN: ADMIN }),
    keys: new EnvKeyProvider({ keys: { k1: randomBytes(32) } }),
    connectors: [
      createMappingModule(),
      createCorrelationModule({ now: () => NOW, minRecomputeMs: 0 }),
      drift,
      eventsApiModule,
    ],
  });
  alice = await createLocalUser(pool, "default", "alice");
  bob = await createLocalUser(pool, "default", "bob");
  for (const service of [
    { id: "web", name: "Visible Web" },
    { id: "shop-api", name: "Secret Shop" },
  ])
    expect((await post("/api/mapping/services", service)).statusCode).toBe(201);
  for (const rule of [
    { field: "vercel.project", match: "exact", pattern: "web", targetId: "web" },
    { field: "argocd.application", match: "glob", pattern: "shop-api-*", targetId: "shop-api" },
  ])
    expect((await post("/api/mapping/rules", { kind: "service", ...rule })).statusCode).toBe(201);
  expect(
    (
      await post("/api/mapping/environments", {
        id: "private-dimension",
        name: "Secret Environment",
        kind: "other",
      })
    ).statusCode,
  ).toBe(201);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await afe.app.close();
  await pool.end();
});

it("no grants yields no dimensions, graph, mapping rules or derived counts even after admin cache warmup", async () => {
  expect((await get("/api/environments/state", ADMIN)).json().cells.length).toBeGreaterThan(0);
  const matrix = await get("/api/environments/state");
  expect(matrix.statusCode).toBe(200);
  expect(matrix.json()).toMatchObject({
    cells: [],
    services: [],
    environments: [],
    window: { events: 0, asOfSeq: 0 },
  });
  const mapping = await get("/api/mapping");
  expect(mapping.json()).toMatchObject({
    readOnly: true,
    revision: 0,
    services: [],
    environments: [],
    rules: [],
    builtinRules: [],
  });
  expect((await get("/api/mapping/unmapped")).json()).toMatchObject({ sampleSize: 0, values: [] });
  expect((await get("/api/drift/findings")).json()).toMatchObject({
    findings: [],
    counts: { open: 0, resolved: 0 },
  });
  expect((await get("/api/drift/summary")).json()).toMatchObject({
    open: 0,
    cells: [],
    targets: [],
  });
  expect((await get(`/api/journeys?repository=acme/web&commit=${C.M1}`)).statusCode).toBe(404);
  expect((await get("/api/environments/shop-api/production/history")).statusCode).toBe(404);
});
it("filters before graph derivation: matrix, history, links and journeys include only authorized source events", async () => {
  await grant("vercel", ["project:web"]);
  const matrix = await get("/api/environments/state");
  expect(matrix.statusCode, matrix.body).toBe(200);
  expect(matrix.json().cells.length).toBeGreaterThan(0);
  expect(matrix.json().services.map((s: { id: string }) => s.id)).toEqual(["web"]);
  expect(matrix.body).not.toContain("Secret Shop");
  expect(matrix.body).not.toContain("Secret Environment");
  expect(matrix.body).not.toContain("shop-api-production");
  for (const cell of matrix.json().cells)
    expect(cell.targets.every((t: { source: string }) => t.source === "vercel")).toBe(true);
  const history = await get("/api/environments/web/production/history?limit=1");
  expect(history.statusCode, history.body).toBe(200);
  expect(history.json().items).toHaveLength(1);
  expect(history.json().targets.every((t: { source: string }) => t.source === "vercel")).toBe(true);
  const own = events.find(
    (e) => e.source === "vercel" && e.correlation.commitShas?.includes(C.M1),
  )!;
  const links = await get(`/api/events/${own.id}/links`);
  expect(links.statusCode, links.body).toBe(200);
  expect(
    links.json().links.every((l: { event: { source: string } }) => l.event.source === "vercel"),
  ).toBe(true);
  const hidden = events.find((e) => e.source === "github")!;
  expect((await get(`/api/events/${hidden.id}/links`)).statusCode).toBe(404);
  const journey = await get(`/api/journeys?repository=acme/web&commit=${C.M1}&include=containment`);
  expect(journey.statusCode, journey.body).toBe(200);
  expect(
    journey
      .json()
      .journey.steps.every((s: { event: { source: string } }) => s.event.source === "vercel"),
  ).toBe(true);
  expect(journey.json().journey.containment).toEqual([]);
  const map = await get("/api/mapping");
  expect(map.json().services.map((s: { id: string }) => s.id)).toEqual(["web"]);
  expect(map.json().rules).toEqual([]);
  expect(map.body).not.toContain("shop-api-*");
});
it("does not reuse another user's graph or stale permissions, including history cursors", async () => {
  await grant("vercel", ["project:web"]);
  await grant("argocd", ["application:shop-api-production"], bob);
  await get("/api/environments/state", ADMIN);
  await get("/api/environments/state");
  const own = await get("/api/environments/web/production/history?limit=1");
  const cursor = own.json().nextCursor;
  expect(cursor).toBeTruthy();
  const other = await get("/api/environments/state", bob.token);
  expect(other.body).not.toContain("Visible Web");
  expect(other.json().cells.length).toBeGreaterThan(0);
  await grant("vercel", ["project:web"], alice, "none");
  expect((await get("/api/environments/state")).json().cells).toEqual([]);
  expect((await get(`/api/environments/web/production/history?cursor=${cursor}`)).statusCode).toBe(
    404,
  );
  expect((await get("/api/environments/state", bob.token)).json().cells.length).toBeGreaterThan(0);
});
it("revalidates source accounts on each derived view read while preserving combined custom grants", async () => {
  let projects = [{ id: "web", name: "web" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            new URL(url).pathname === "/v2/user"
              ? { user: { id: "alice", username: "alice" } }
              : { projects, pagination: { next: null } },
          ),
        ),
    ),
  );
  await grant("vercel", ["project:web"], alice, "source");
  expect(
    (await post("/api/profile/tools/vercel/token", { token: "personal-vercel" }, alice.token))
      .statusCode,
  ).toBe(200);
  expect((await get("/api/environments/state")).json().cells.length).toBeGreaterThan(0);
  projects = [];
  expect((await get("/api/environments/state")).json().cells).toEqual([]);
  expect((await get("/api/mapping")).json().services).toEqual([]);
  await grant("vercel", ["project:web"], alice, "source + custom");
  expect((await get("/api/environments/state")).json().cells.length).toBeGreaterThan(0);
});
it("requires all drift evidence before list/count pagination and hides missing or omitted evidence", async () => {
  vi.spyOn(drift.service(afe.context), "ensureFresh").mockResolvedValue(null);
  await grant("vercel", ["project:web"]);
  const web = events.find((e) => e.source === "vercel")!,
    github = events.find((e) => e.source === "github")!;
  const make = async (label: string, ids: string[], omitted = 0) => {
    const f: DriftFindingWrite = {
      id: randomUUID(),
      type: "untracked_deploy",
      severity: "high",
      status: "open",
      targetKey: label,
      targetSource: "vercel",
      targetLabel: label,
      toolEnvironment: "production",
      serviceId: "web",
      serviceName: "Visible Web",
      environmentId: "production",
      environmentName: "Production",
      title: label,
      explanation: label,
      openingEventId: web.id,
      latestEventId: web.id,
      resolvedByEventId: null,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      resolvedAt: null,
      evidence: ids.map((id) => ({
        eventId: id,
        role: "related",
        at: NOW.toISOString(),
        summary: label,
      })),
      evidenceOmitted: omitted,
      details: {},
      fingerprint: label,
      detectedAt: NOW,
      updatedAt: NOW,
      openedRecordedAt: NOW,
      resolvedRecordedAt: null,
      alert: false,
      openedNotifiedAt: null,
      resolvedNotifiedAt: null,
    };
    await insertDriftFinding(pool, "default", f);
    return f;
  };
  const visible = await make("visible-finding", [web.id]);
  const mixed = await make("hidden-cross-tool-evidence", [web.id, github.id]);
  const omitted = await make("hidden-omitted-evidence", [web.id], 1);
  const missing = await make("hidden-purged-evidence", [randomUUID()]);
  const page = await get("/api/drift/findings?limit=1");
  expect(page.statusCode, page.body).toBe(200);
  expect(page.json()).toMatchObject({ counts: { open: 1, resolved: 0 }, nextCursor: null });
  expect(page.json().findings.map((f: { id: string }) => f.id)).toEqual([visible.id]);
  const summary = await get("/api/drift/summary");
  expect(summary.json().open).toBe(1);
  expect(summary.body).not.toContain("hidden");
  expect((await get(`/api/drift/findings/${visible.id}`)).statusCode).toBe(200);
  for (const f of [mixed, omitted, missing])
    expect((await get(`/api/drift/findings/${f.id}`)).statusCode).toBe(404);
  await grant("github", [`repository:${github.target.repository}`]);
  expect((await get("/api/drift/findings")).json().counts.open).toBe(2);
  await grant("github", [], alice, "none");
  expect((await get(`/api/drift/findings/${mixed.id}`)).statusCode).toBe(404);
  await pool.query("DELETE FROM events WHERE tenant_id=$1 AND id=$2", ["default", web.id]);
  expect((await get("/api/drift/summary")).json().open).toBe(0);
});

it("hidden commits cannot make an authorized journey prefix ambiguous or displace a mapping sample", async () => {
  await grant("vercel", ["project:web"]);
  await ingestEvent(pool, "default", {
    source: "github",
    sourceEventId: "hidden-prefix",
    action: "push.created",
    actor: { type: "user", login: "hidden-actor" },
    target: { type: "repository", id: "acme/web", repository: "acme/web" },
    trigger: { type: "push" },
    outcome: "succeeded",
    occurredAt: NOW,
    observedAt: NOW,
    observation: { method: "webhook" },
    correlation: {
      repositories: ["github.com/acme/web"],
      commitShas: [C.M1.slice(0, 7) + "f".repeat(33)],
    },
    data: {},
  });
  const result = await get(`/api/journeys?repository=acme/web&commit=${C.M1.slice(0, 7)}`);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.body).not.toContain("hidden-actor");
  expect(result.json().journey.commitSha).toBe(C.M1);
  expect((await get("/api/mapping/unmapped?limit=1")).json().sampleSize).toBe(1);
});
it("identical resource grants in another tenant never expose default-tenant derived records", async () => {
  await pool.query("INSERT INTO tenants(id,name) VALUES ('other','Other')");
  const outsider = await createLocalUser(pool, "other", "outsider");
  await setUserToolPolicy(pool, "other", outsider.user.id, "vercel", {
    mode: "custom",
    custom: [{ resource: "project:web", action: "read" }],
  });
  expect((await get("/api/environments/state", outsider.token)).json()).toMatchObject({
    services: [],
    environments: [],
    cells: [],
  });
  expect((await get("/api/mapping", outsider.token)).json().services).toEqual([]);
  const own = events.find((e) => e.source === "vercel")!;
  expect((await get(`/api/events/${own.id}/links`, outsider.token)).statusCode).toBe(404);
  expect((await get("/api/drift/summary", outsider.token)).json().open).toBe(0);
});
