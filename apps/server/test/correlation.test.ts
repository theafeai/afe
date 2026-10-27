/**
 * Correlation API (AFE-20) over the AFE-15 synthetic dataset
 * (docs/research/prototypes/synthetic-dataset.ts): GitOps via image, Vercel
 * promote/rollback, manual ArgoCD sync with an image override, mutable tag
 * ambiguity, CLI deploy without Git; plus mapping, gaps, auth and tenancy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  observationGapClosed,
  observationGapOpened,
  type CanonicalEventInputLike,
} from "@afe/core";
import { ingestEvent } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { C, DG, syntheticInputs } from "../../../docs/research/prototypes/synthetic-dataset.ts";
import { buildAfe, type AfeApp } from "../src/index.ts";
import { createMappingModule } from "../src/mapping/index.ts";
import { createCorrelationModule, type JourneyContainmentHook } from "../src/correlation/index.ts";
import { tokenMapAuth } from "./helpers/auth.ts";

const A = { authorization: "Bearer admin-a" };
const V = { authorization: "Bearer viewer-a" };
const B = { authorization: "Bearer admin-b" };
const NOW = new Date("2026-10-27T00:00:00Z");
const SHOP = "github.com/acme/shop";

const auth = tokenMapAuth({
  "admin-a": { tenantId: "default", roles: ["admin"] },
  "viewer-a": { tenantId: "default", roles: ["viewer"] },
  "admin-b": { tenantId: "other", roles: ["admin"] },
});

describe("correlation API (AFE-20)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  const containmentCalls: { commit: string; live: string }[] = [];
  const hook: JourneyContainmentHook = {
    async isContained(_tenant, _repo, commit, live) {
      containmentCalls.push({ commit, live });
      return { contained: true, reason: "the live commit descends from this commit" };
    },
  };

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
  const idOf = async (where: string, params: unknown[] = []) =>
    (
      await pool.query<{ id: string }>(
        `SELECT id FROM events WHERE tenant_id = 'default' AND ${where} ORDER BY occurred_at`,
        params,
      )
    ).rows.map((r) => r.id);

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
    for (const { id: _id, ...input } of syntheticInputs) await ingestEvent(pool, "default", input);

    // Gaps: GitHub was blind while worker W2's image was published (evidence
    // in a gap); ArgoCD has an open gap now (what is live may be stale).
    const w2Build = syntheticInputs.find(
      (e) => e.action === "artifact.published" && e.correlation?.imageDigests?.includes(DG.DW2),
    )!;
    const t = Date.parse(String(w2Build.occurredAt));
    const gh = {
      gapId: "gap-gh",
      connectionId: "conn-gh",
      source: "github",
      startedAt: new Date(t - 60_000),
      reason: "connection_error" as const,
    };
    await ingestEvent(pool, "default", observationGapOpened(gh));
    await ingestEvent(
      pool,
      "default",
      observationGapClosed({ ...gh, endedAt: new Date(t + 60_000) }),
    );
    await ingestEvent(
      pool,
      "default",
      observationGapOpened({
        gapId: "gap-argo",
        connectionId: "conn-argo",
        source: "argocd",
        startedAt: new Date("2026-10-26T10:00:00Z"),
        reason: "source_unavailable",
      }),
    );

    afe = await buildAfe({
      pool,
      logLevel: "silent",
      authProvider: auth,
      connectors: [
        createMappingModule(),
        createCorrelationModule({ now: () => NOW, minRecomputeMs: 0, containment: () => hook }),
      ],
    });
    // Services: shop-api (Argo apps) and web (Vercel project, GitHub repo).
    // The worker stays unmapped on purpose.
    for (const s of [
      { id: "shop-api", name: "Shop API" },
      { id: "web", name: "Web" },
    ])
      expect((await call("POST", "/api/mapping/services", A, s)).statusCode).toBe(201);
    for (const r of [
      { field: "argocd.application", match: "glob", pattern: "shop-api-*", targetId: "shop-api" },
      { field: "vercel.project", match: "exact", pattern: "web", targetId: "web" },
      { field: "github.repository", match: "exact", pattern: "acme/web", targetId: "web" },
    ])
      expect(
        (await call("POST", "/api/mapping/rules", A, { kind: "service", ...r })).statusCode,
      ).toBe(201);
  });
  afterAll(async () => {
    await afe.app.close();
    await pool.end();
  });

  describe("GET /api/environments/state", () => {
    it("returns services × environments with an explicit unmapped bucket", async () => {
      const res = await get("/api/environments/state");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.services.map((s: { id: string }) => s.id)).toEqual([
        "shop-api",
        "web",
        "_unmapped",
      ]);
      expect(body.environments.map((e: { id: string }) => e.id).slice(0, 3)).toEqual([
        "production",
        "staging",
        "preview",
      ]);
      expect(body.window).toMatchObject({ stale: false, truncated: false });
      const cells = Object.fromEntries(
        body.cells.map((c: { service: string; environment: string }) => [
          `${c.service}/${c.environment}`,
          c,
        ]),
      );
      expect(Object.keys(cells).sort()).toEqual([
        "_unmapped/production",
        "_unmapped/staging",
        "shop-api/production",
        "shop-api/staging",
        "web/preview",
        "web/production",
      ]);

      // (a) GitOps via image: staging runs B, attributed by tag (probable).
      const staging = cells["shop-api/staging"];
      expect(staging.live.commits.map((c: { commitSha: string }) => c.commitSha)).toEqual([C.B]);
      expect(staging).toMatchObject({ confidence: "probable", status: "attributed" });
      // Service by a tenant rule, environment by a built-in default rule.
      expect(staging.targets[0].mapping.confidence).toBe("default");

      // (c) Manual ArgoCD sync with an overridden image: unknown, config revision known.
      const prod = cells["shop-api/production"];
      expect(prod.live).toMatchObject({
        kind: "manual",
        commits: [],
        configRevision: { commitSha: C.C2 },
      });
      expect(prod.status).toBe("unknown");
      expect(prod.targets[0].history.byKind).toMatchObject({ manual: 1 });

      // (d) Mutable tag: production restart is ambiguous between W and W2.
      const worker = cells["_unmapped/production"];
      expect(worker.unmapped).toBe(true);
      expect(worker.status).toBe("ambiguous");
      expect(worker.live.commits.map((c: { commitSha: string }) => c.commitSha).sort()).toEqual(
        [C.W, C.W2].sort(),
      );

      // (b, c) Vercel: the CLI deploy is a weak guess; the GitHub mirror target
      // (Production – web) is in the same cell and runs something else.
      const web = cells["web/production"];
      expect(web.live).toMatchObject({ source: "vercel", kind: "manual" });
      expect(web.status).toBe("guess");
      expect(web.targets.map((t: { key: string }) => t.key).sort()).toEqual([
        "github:acme/web:production – web",
        "vercel:web:production",
      ]);
      expect(web.consistent).toBe(false);
      expect(
        web.targets.find((t: { source: string }) => t.source === "vercel").history.placements,
      ).toBe(7);
    });

    it("flags cells whose evidence falls inside a gap, and open gaps after the placement", async () => {
      const body = (await get("/api/environments/state")).json();
      const cell = (k: string) =>
        body.cells.find(
          (c: { service: string; environment: string }) => `${c.service}/${c.environment}` === k,
        );
      const workerStaging = cell("_unmapped/staging");
      expect(workerStaging.gap).toMatchObject({
        flagged: true,
        evidenceInGap: true,
        possiblyStale: true,
      });
      expect(
        workerStaging.live.gaps.map((g: { gapId: string; relation: string }) => [
          g.gapId,
          g.relation,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["gap-gh", "evidence_in_gap"],
          ["gap-argo", "after_placement"],
        ]),
      );
      // Vercel was never blind, and GitHub's gap is closed (backfilled): not stale.
      const web = cell("web/production");
      const gaps = (source: string) =>
        web.targets.find((t: { source: string }) => t.source === source).current.gaps;
      expect(gaps("vercel")).toEqual([]);
      expect(gaps("github")).toEqual([]);
      expect(web.gap.possiblyStale).toBe(false);
    });

    it("filters by service, environment and source; bounds targets per cell", async () => {
      const one = (await get("/api/environments/state?service=web&environment=production")).json();
      expect(one.cells).toHaveLength(1);
      const vercelOnly = (await get("/api/environments/state?service=web&source=vercel")).json();
      expect(
        vercelOnly.cells.every((c: { targets: { source: string }[] }) =>
          c.targets.every((t) => t.source === "vercel"),
        ),
      ).toBe(true);
      const capped = (
        await get("/api/environments/state?service=web&environment=production&targets=1")
      ).json();
      expect(capped.cells[0]).toMatchObject({ targetsOmitted: 1 });
      expect((await get("/api/environments/state?service=nope")).statusCode).toBe(400);
      expect((await get("/api/environments/state?targets=0")).statusCode).toBe(400);
      expect((await get("/api/environments/state?enviroment=production")).statusCode).toBe(400);
      expect((await get("/api/environments/state?service=a&service=b")).statusCode).toBe(400);
    });
  });

  describe("GET /api/environments/:service/:environment/history", () => {
    it("lists placements newest first with kinds, content change and causes, paginated", async () => {
      const first = (await get("/api/environments/web/production/history?limit=3")).json();
      expect(first.total).toBe(8);
      expect(first.items).toHaveLength(3);
      expect(first.items[0]).toMatchObject({ current: true, placement: { kind: "manual" } });
      const all = [...first.items];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = (
          await get(`/api/environments/web/production/history?limit=3&cursor=${cursor}`)
        ).json();
        all.push(...page.items);
        cursor = page.nextCursor;
      }
      expect(all).toHaveLength(8);
      expect(new Set(all.map((i) => i.placement.eventId)).size).toBe(8);
      const kinds = all.map((i) => i.placement.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(["rollback", "promotion", "redeploy", "manual", "deploy"]),
      );
      const rollback = all.find((i) => i.placement.kind === "rollback");
      expect(rollback.placement.commits[0]).toMatchObject({
        commitSha: C.M1,
        confidence: "certain",
      });
      expect(
        rollback.causes.some((c: { evidence: { kind: string }[] }) =>
          c.evidence.some((e) => e.kind === "same_deployment"),
        ),
      ).toBe(true);
      expect(all.at(-1).change).toBe("first");
    });

    it("shows the manual override step of the GitOps production history", async () => {
      const h = (await get("/api/environments/shop-api/production/history")).json();
      expect(h.items.map((i: { placement: { kind: string } }) => i.placement.kind)).toEqual([
        "manual",
        "deploy",
      ]);
      expect(h.items[0].change).toBe("new_content");
      expect(h.items[1].placement.commits[0]).toMatchObject({
        commitSha: C.A,
        confidence: "strong",
      });
      expect(h.items[1].causes.length).toBeGreaterThan(0);
    });

    it("answers the unmapped bucket, 404 for unknown ids and 400 for a foreign cursor", async () => {
      const u = await get("/api/environments/_unmapped/production/history");
      expect(u.statusCode).toBe(200);
      expect(u.json().targets.map((t: { key: string }) => t.key)).toEqual([
        "argocd:argocd/worker-production",
      ]);
      expect((await get("/api/environments/nope/production/history")).statusCode).toBe(404);
      expect((await get("/api/environments/web/NOPE/history")).statusCode).toBe(404);
      const c = (await get("/api/environments/web/production/history?limit=1")).json().nextCursor;
      expect((await get(`/api/environments/web/preview/history?cursor=${c}`)).statusCode).toBe(400);
    });
  });

  describe("GET /api/journeys", () => {
    it("follows a GitOps commit through CI, artifact and config to both environments", async () => {
      const res = await get(`/api/journeys?repository=acme/shop&commit=${C.A}`);
      expect(res.statusCode).toBe(200);
      const j = res.json().journey;
      expect(j).toMatchObject({ repository: SHOP, commitSha: C.A, truncated: false });
      expect(j.stages.map((s: { stage: string }) => s.stage)).toEqual(
        expect.arrayContaining(["change", "ci", "artifact", "config", "deploy"]),
      );
      expect(
        j.environments.map(
          (e: {
            target: { key: string };
            confidence: string;
            service: string;
            environment: string;
          }) => [e.target.key, e.confidence, e.service, e.environment],
        ),
      ).toEqual([
        ["argocd:argocd/shop-api-staging", "probable", "shop-api", "staging"],
        ["argocd:argocd/shop-api-production", "strong", "shop-api", "production"],
      ]);
      // The manual sync of the same config revision running another image is excluded.
      const [manualSync] = await idOf(
        "source = 'argocd' AND action = 'argocd.sync.succeeded' AND trigger ->> 'type' = 'manual' AND target ->> 'application' = 'shop-api-production'",
      );
      expect(j.excluded.map((x: { eventId: string }) => x.eventId)).toContain(manualSync);
      for (const e of j.edges)
        expect(["certain", "strong", "probable", "weak"]).toContain(e.confidence);
      expect(
        j.steps.every((s: { event: { url: string } }) => s.event.url.startsWith("/api/events/")),
      ).toBe(true);
    });

    it("says where a PR head commit continues, accepts short SHAs and a repository URL", async () => {
      const j = (
        await get(
          `/api/journeys?repository=https://github.com/acme/web&commit=${C.P1.slice(0, 10)}`,
        )
      ).json().journey;
      expect(j.commitSha).toBe(C.P1);
      expect(j.continuesAs.map((c: { commitSha: string }) => c.commitSha)).toContain(C.M1);
      expect(j.environments.some((e: { environment: string }) => e.environment === "preview")).toBe(
        true,
      );
    });

    it("enriches journeys with commit containment on request", async () => {
      containmentCalls.length = 0;
      const plain = (await get(`/api/journeys?repository=acme/shop&commit=${C.A}`)).json().journey;
      expect(plain.containment).toBeNull();
      expect(containmentCalls).toHaveLength(0);
      const j = (
        await get(`/api/journeys?repository=acme/shop&commit=${C.A}&include=containment`)
      ).json().journey;
      expect(containmentCalls).toEqual([{ commit: C.A, live: C.B }]);
      const via = j.environments.find((e: { via: string }) => e.via === "containment");
      expect(via).toMatchObject({
        current: true,
        target: { key: "argocd:argocd/shop-api-staging" },
      });
      expect(j.containment[0]).toMatchObject({ liveCommitSha: C.B, contained: true });
    });

    it("validates input and answers 404 for unknown commits", async () => {
      expect((await get("/api/journeys?repository=acme/shop")).statusCode).toBe(400);
      expect((await get("/api/journeys?commit=abcdef0")).statusCode).toBe(400);
      expect((await get("/api/journeys?repository=acme/shop&commit=xyz")).statusCode).toBe(400);
      expect(
        (await get(`/api/journeys?repository=acme/shop&commit=${C.A}&include=nope`)).statusCode,
      ).toBe(400);
      expect((await get(`/api/journeys?repository=acme/other&commit=${C.A}`)).statusCode).toBe(404);
      expect(
        (await get(`/api/journeys?repository=acme/shop&commit=${"0".repeat(40)}`)).statusCode,
      ).toBe(404);
    });
  });

  describe("GET /api/events/:id/links", () => {
    it("lists related events with typed evidence, strongest first", async () => {
      const [rollback] = await idOf("action = 'deployment.rolled_back'");
      const body = (await get(`/api/events/${rollback}/links`)).json();
      expect(body.inWindow).toBe(true);
      expect(body.links[0].confidence).toBe("certain");
      expect(
        body.links.some((l: { evidence: { kind: string }[] }) =>
          l.evidence.some((e) => e.kind === "same_deployment"),
        ),
      ).toBe(true);
      expect(body.placement).toMatchObject({
        kind: "rollback",
        target: { key: "vercel:web:production" },
      });
      const limited = (await get(`/api/events/${rollback}/links?limit=1`)).json();
      expect(limited.links).toHaveLength(1);
      expect(limited.total).toBe(body.total);
    });

    it("reports conflicts: the rebuilt mutable tag", async () => {
      const builds = await idOf("action = 'artifact.published' AND correlation @> $1::jsonb", [
        JSON.stringify({ imageDigests: [DG.DW2] }),
      ]);
      const body = (await get(`/api/events/${builds[0]}/links`)).json();
      expect(body.conflicts.map((c: { kind: string; key: string }) => [c.kind, c.key])).toEqual([
        ["tag_digest_mismatch", "image:ghcr.io/acme/worker:1.4"],
      ]);
    });
  });

  describe("auth and tenancy", () => {
    it("requires authentication", async () => {
      for (const url of [
        "/api/environments/state",
        "/api/environments/web/production/history",
        `/api/journeys?repository=acme/shop&commit=${C.A}`,
      ])
        expect((await call("GET", url, {})).statusCode).toBe(401);
    });

    it("never shows another tenant's data", async () => {
      const state = (await get("/api/environments/state", B)).json();
      expect(state.cells).toEqual([]);
      expect(state.services.map((s: { id: string }) => s.id)).toEqual([]);
      expect((await get("/api/environments/web/production/history", B)).statusCode).toBe(404);
      expect((await get(`/api/journeys?repository=acme/shop&commit=${C.A}`, B)).statusCode).toBe(
        404,
      );
      const [rollback] = await idOf("action = 'deployment.rolled_back'");
      expect((await get(`/api/events/${rollback}/links`, B)).statusCode).toBe(404);
      expect((await get("/api/events/not-a-uuid/links")).statusCode).toBe(404);
    });
  });

  describe("refresh", () => {
    it("picks up new events incrementally and drops events outside retention", async () => {
      const before = (await get("/api/environments/state")).json().window;
      const sync: CanonicalEventInputLike = {
        ...syntheticInputs.findLast(
          (e) =>
            e.action === "argocd.sync.succeeded" && e.target.application === "shop-api-staging",
        )!,
        sourceEventId: "afe20:new-sync",
        occurredAt: "2026-10-26T12:00:00Z",
        observedAt: "2026-10-26T12:00:01Z",
        trigger: { type: "manual" },
        actor: { type: "user", login: "carol" },
      };
      delete (sync as { id?: string }).id;
      await ingestEvent(pool, "default", sync);
      // Outside the 30-day window: never loaded.
      await ingestEvent(pool, "default", {
        ...sync,
        sourceEventId: "afe20:old",
        occurredAt: "2026-08-01T00:00:00Z",
        observedAt: "2026-08-01T00:00:01Z",
      });
      const after = (
        await get("/api/environments/state?service=shop-api&environment=staging")
      ).json();
      expect(after.window.asOfSeq).toBe(before.asOfSeq + 2);
      expect(after.window.events).toBe(before.events + 1);
      expect(after.cells[0].live).toMatchObject({ actor: "carol", kind: "manual" });
      expect(after.cells[0].since).toBe("2026-10-26T12:00:00.000Z");
      // Same content as before: "content since" stays at the earlier placement.
      expect(after.cells[0].contentSince < after.cells[0].since).toBe(true);
    });
  });
});
