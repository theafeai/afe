/**
 * Performance smoke test for the chosen correlation design (compute-on-read
 * with a per-tenant cache, AFE-20). Budgets are ~3-4x the numbers measured in
 * docs/correlation.md, so this catches a return to quadratic behaviour, not
 * machine noise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyBaseLogger } from "fastify";
import { buildCorrelationGraph, buildJourney } from "@afe/core/correlation";
import { createTestPool } from "@afe/db/testing";
import { CorrelationService } from "../src/correlation/service.ts";
import { bulkInsertEvents } from "./fixtures/bulk-events.ts";
import { generateWorkload, toCorrelationEvents } from "./fixtures/correlation-workload.ts";

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop } as unknown as FastifyBaseLogger;
const time = <T>(fn: () => T): [T, number] => {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
};

describe("correlation performance (AFE-20)", () => {
  it("computes the graph for ~90k events (50 repos, 30 days) within budget", () => {
    const w = generateWorkload({ pushesPerRepoPerDay: 5.5 });
    const events = toCorrelationEvents(w.inputs);
    expect(events.length).toBeGreaterThan(85_000);
    const [graph, ms] = time(() => buildCorrelationGraph(events));
    // Measured ~2.3-2.6 s; the prototype needed > 5 minutes for the links alone.
    expect(ms).toBeLessThan(10_000);
    // Linear link count (chain + first for hot keys), not quadratic.
    expect(graph.links.length).toBeLessThan(events.length * 6);
    const [, jms] = time(() =>
      w.sampleCommits.map((c) => buildJourney(graph, c.repository, c.commitSha)),
    );
    expect(jms / w.sampleCommits.length).toBeLessThan(50);
  }, 60_000);

  describe("from PostgreSQL (~23k events)", () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = await createTestPool();
    }, 60_000);
    afterAll(async () => {
      await pool.end();
    });

    it("loads cold, serves warm and refreshes incrementally within budget", async () => {
      const w = generateWorkload({ pushesPerRepoPerDay: 1.5 });
      await bulkInsertEvents(pool, "default", w.inputs);
      await pool.query("ANALYZE events");
      const svc = new CorrelationService(
        pool,
        { cutoff: (_t, now) => new Date(now.getTime() - 30 * 86_400_000), maxWindowMs: null },
        log,
        { now: () => new Date(w.to), minRecomputeMs: 0 },
      );
      let t = performance.now();
      const cold = await svc.snapshot("default");
      const coldMs = performance.now() - t;
      expect(cold.window.events).toBe(w.inputs.length);
      expect(coldMs).toBeLessThan(4_000); // measured ~0.8 s

      t = performance.now();
      const warm = await svc.snapshot("default");
      expect(performance.now() - t).toBeLessThan(200); // measured < 10 ms
      expect(warm.graph).toBe(cold.graph);

      await bulkInsertEvents(pool, "default", [{ ...w.inputs.at(-1)!, sourceEventId: "perf:new" }]);
      t = performance.now();
      const next = await svc.snapshot("default");
      expect(performance.now() - t).toBeLessThan(3_000); // measured ~0.6 s
      expect(next.window.events).toBe(w.inputs.length + 1);
    }, 120_000);
  });
});
