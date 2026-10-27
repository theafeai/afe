/**
 * AFE-20 measurement: compute-on-read (the chosen design) vs a derived
 * `event_links` table maintained on ingest. Results: docs/correlation.md.
 *
 *   TEST_DATABASE_URL=postgres://…/afe_bench \
 *     node --expose-gc --import tsx apps/server/test/bench/correlation-bench.ts [rates…]
 *
 * WARNING: resets the schema of TEST_DATABASE_URL (like the tests do).
 */
import type { FastifyBaseLogger } from "fastify";
import {
  buildCorrelationGraph,
  buildJourney,
  buildLinks,
  digestsOf,
  hintsOf,
  imageTagKey,
  type CorrelationEvent,
} from "@afe/core/correlation";
import { canonicalJson, type RetentionPolicy } from "@afe/core";
import { createTestPool } from "@afe/db/testing";
import { CorrelationService } from "../../src/correlation/service.ts";
import { bulkInsertEvents } from "../fixtures/bulk-events.ts";
import { generateWorkload } from "../fixtures/correlation-workload.ts";

const rates = process.argv.slice(2).map(Number);
const RATES = rates.length > 0 ? rates : [0.3, 1.5, 5.5];
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const heapMB = () => {
  gc();
  return process.memoryUsage().heapUsed / 1e6;
};
const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main() {
  const out: Record<string, unknown>[] = [];
  for (const rate of RATES) {
    const pool = await createTestPool();
    const w = generateWorkload({ pushesPerRepoPerDay: rate });
    const end = new Date(w.to);
    let t = performance.now();
    await bulkInsertEvents(pool, "default", w.inputs);
    const insertMs = ms(t);
    await pool.query("ANALYZE events");
    const retention: RetentionPolicy = {
      cutoff: (_t, now) => new Date(now.getTime() - 30 * 86_400_000),
      maxWindowMs: 30 * 86_400_000,
    };
    const noop = () => {};
    const log = {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    } as unknown as FastifyBaseLogger;
    const svc = new CorrelationService(pool, retention, log, { now: () => end, minRecomputeMs: 0 });

    const h0 = heapMB();
    t = performance.now();
    const cold = await svc.snapshot("default");
    const coldMs = ms(t);
    const heap = Math.round(heapMB() - h0);
    t = performance.now();
    await svc.snapshot("default");
    const warmMs = ms(t);

    // Load vs compute split.
    const events = [...cold.events.values()];
    t = performance.now();
    const graph = buildCorrelationGraph(events);
    const computeMs = ms(t);

    // One new event, then refresh (incremental load + full recompute).
    const one = { ...w.inputs.at(-1)!, sourceEventId: "bench:new" };
    await bulkInsertEvents(pool, "default", [one]);
    t = performance.now();
    await svc.snapshot("default");
    const afterOneMs = ms(t);

    const journeyTimes = w.sampleCommits.map((c) => {
      const s = performance.now();
      buildJourney(graph, c.repository, c.commitSha);
      return performance.now() - s;
    });

    // --- Alternative: derived event_links table --------------------------
    await pool.query(`CREATE TABLE bench_event_links (
      tenant_id text NOT NULL, from_id uuid NOT NULL, to_id uuid NOT NULL,
      confidence text NOT NULL, evidence jsonb NOT NULL,
      PRIMARY KEY (tenant_id, from_id, to_id))`);
    await pool.query("CREATE INDEX ON bench_event_links (tenant_id, to_id)");
    t = performance.now();
    const links = graph.links;
    for (let i = 0; i < links.length; i += 5000) {
      await pool.query(
        `INSERT INTO bench_event_links SELECT 'default', r.f, r.t, r.c, r.e
           FROM jsonb_to_recordset($1::jsonb) AS r(f uuid, t uuid, c text, e jsonb)`,
        [
          JSON.stringify(
            links
              .slice(i, i + 5000)
              .map((l) => ({ f: l.from, t: l.to, c: l.confidence, e: l.evidence })),
          ),
        ],
      );
    }
    const rebuildInsertMs = ms(t);
    const { rows: size } = await pool.query<{ bytes: string }>(
      "SELECT pg_total_relation_size('bench_event_links') AS bytes",
    );

    // Incremental: per new event, find events sharing a key (GIN @>), link, upsert.
    const sample = events.slice(-200);
    const perEvent: number[] = [];
    for (const e of sample) {
      const s = performance.now();
      const keys: Record<string, string>[] = [];
      for (const k of ["commitShas", "deploymentIds", "runIds", "imageDigests"] as const)
        for (const v of e.correlation[k] ?? []) keys.push({ [k]: v });
      for (const u of hintsOf(e).deploymentUrls) keys.push({ deploymentUrls: u });
      for (const sha of hintsOf(e).upstreamCommitShas) keys.push({ commitShas: sha });
      for (const r of e.correlation.imageRefs ?? []) {
        if (imageTagKey(r)) keys.push({ imageRefs: r });
      }
      void digestsOf;
      const candidates = new Map<string, CorrelationEvent>([[e.id, e]]);
      for (const k of keys) {
        const { rows } = await pool.query<{
          id: string;
          source: string;
          action: string;
          actor: CorrelationEvent["actor"];
          target: CorrelationEvent["target"];
          trigger: CorrelationEvent["trigger"];
          outcome: CorrelationEvent["outcome"];
          occurred_at: Date;
          correlation: CorrelationEvent["correlation"];
          data: CorrelationEvent["data"];
        }>(
          `SELECT id, source, action, actor, target, trigger, outcome, occurred_at, correlation, data
             FROM events WHERE tenant_id = 'default'
              AND correlation @> $1::jsonb ORDER BY occurred_at DESC LIMIT 200`,
          [canonicalJson(Object.fromEntries(Object.entries(k).map(([a, b]) => [a, [b]])))],
        );
        for (const r of rows)
          candidates.set(r.id, { ...r, occurredAt: r.occurred_at.toISOString() });
      }
      const mine = buildLinks([...candidates.values()]).links.filter(
        (l) => l.from === e.id || l.to === e.id,
      );
      if (mine.length > 0) {
        await pool.query(
          `INSERT INTO bench_event_links SELECT 'default', r.f, r.t, r.c, r.e
             FROM jsonb_to_recordset($1::jsonb) AS r(f uuid, t uuid, c text, e jsonb)
           ON CONFLICT (tenant_id, from_id, to_id) DO UPDATE SET evidence = EXCLUDED.evidence`,
          [
            JSON.stringify(
              mine.map((l) => ({ f: l.from, t: l.to, c: l.confidence, e: l.evidence })),
            ),
          ],
        );
      }
      perEvent.push(performance.now() - s);
    }

    // Reading what the matrix needs back from the derived table.
    t = performance.now();
    await pool.query(
      `SELECT l.* FROM bench_event_links l JOIN events e
          ON e.tenant_id = l.tenant_id AND e.id = l.to_id
        WHERE l.tenant_id = 'default'
          AND e.action IN ('argocd.sync.succeeded','deployment.status_updated','deployment.promoted','deployment.rolled_back')`,
    );
    const readPlacementLinksMs = ms(t);

    const row = {
      ratePerRepoDay: rate,
      events: w.inputs.length,
      correlationEvents: cold.window.events,
      links: links.length,
      targets: graph.environments.length,
      bulkInsertMs: insertMs,
      coldSnapshotMs: coldMs,
      computeOnlyMs: computeMs,
      warmSnapshotMs: warmMs,
      afterOneNewEventMs: afterOneMs,
      journeyMedianMs: Math.round(median(journeyTimes) * 100) / 100,
      snapshotHeapMB: heap,
      derived: {
        fullRebuildInsertMs: rebuildInsertMs,
        tableMB: Math.round(Number(size[0]!.bytes) / 1e5) / 10,
        incrementalPerEventMedianMs: Math.round(median(perEvent) * 10) / 10,
        incrementalPerEventP95Ms:
          Math.round(
            [...perEvent].sort((a, b) => a - b)[Math.floor(perEvent.length * 0.95)]! * 10,
          ) / 10,
        readPlacementLinksMs,
      },
    };
    process.stdout.write(`${JSON.stringify(row)}\n`);
    out.push(row);
    svc.invalidate();
    await pool.end();
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

await main();
