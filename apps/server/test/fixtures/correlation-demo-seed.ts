/**
 * Demo data for the environment matrix and journeys UI (AFE-24/25): the
 * AFE-15 SYNTHETIC dataset (docs/research/prototypes/synthetic-dataset.ts:
 * GitOps via image, Vercel promote/rollback/redeploy, manual ArgoCD sync with
 * an overridden image, a CLI deploy without Git, a mutable tag) plus the
 * observation gaps and mapping of the AFE-20 API test (correlation.test.ts):
 * an evidence-in-gap placement, an open ArgoCD gap (possibly stale), two
 * mapped services and an unmapped worker.
 *
 * Nothing here was recorded from a real system. For screenshots and manual
 * checks only, against a fresh database:
 *
 *   DATABASE_URL=postgres://…/afe_demo node --import tsx \
 *     apps/server/test/fixtures/correlation-demo-seed.ts
 *
 * then start the server on the same database (events are dated October 2026
 * and must be inside the retention window).
 */
import { pathToFileURL } from "node:url";
import pg from "pg";
import { observationGapClosed, observationGapOpened } from "@afe/core";
import { ingestEvent, migrate } from "@afe/db";
import { DG, syntheticInputs } from "../../../../docs/research/prototypes/synthetic-dataset.ts";
import { buildAfe } from "../../src/index.ts";
import { createMappingModule } from "../../src/mapping/index.ts";
import { resolveMigrationsDir } from "../../src/migrations-dir.ts";
import { trustedTestAuth } from "../helpers/auth.ts";

export async function seedCorrelationDemo(pool: pg.Pool, tenantId = "default"): Promise<void> {
  for (const { id: _id, ...input } of syntheticInputs) await ingestEvent(pool, tenantId, input);

  // GitHub was blind while worker W2's image was published (evidence in a gap).
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
  await ingestEvent(pool, tenantId, observationGapOpened(gh));
  await ingestEvent(pool, tenantId, observationGapClosed({ ...gh, endedAt: new Date(t + 60_000) }));
  // ArgoCD cannot be observed since yesterday: what is live there may be stale.
  await ingestEvent(
    pool,
    tenantId,
    observationGapOpened({
      gapId: "gap-argo",
      connectionId: "conn-argo",
      source: "argocd",
      startedAt: new Date("2026-10-26T10:00:00Z"),
      reason: "source_unavailable",
    }),
  );

  // Mapping through the API (keeps revisions consistent): shop-api (ArgoCD
  // apps) and web (Vercel project, GitHub repository); the worker stays unmapped.
  const afe = await buildAfe({
    pool,
    logLevel: "silent",
    authProvider: trustedTestAuth(tenantId),
    connectors: [createMappingModule()],
  });
  const post = async (url: string, body: unknown) => {
    const res = await afe.app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
    if (res.statusCode >= 300) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
  };
  try {
    for (const s of [
      { id: "shop-api", name: "Shop API" },
      { id: "web", name: "Web" },
    ])
      await post("/api/mapping/services", s);
    for (const r of [
      { field: "argocd.application", match: "glob", pattern: "shop-api-*", targetId: "shop-api" },
      { field: "vercel.project", match: "exact", pattern: "web", targetId: "web" },
      { field: "github.repository", match: "exact", pattern: "acme/web", targetId: "web" },
    ])
      await post("/api/mapping/rules", { kind: "service", ...r });
  } finally {
    await afe.app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrate(pool, resolveMigrationsDir());
    await seedCorrelationDemo(pool);
    console.warn("seeded the correlation demo data");
  } finally {
    await pool.end();
  }
}
