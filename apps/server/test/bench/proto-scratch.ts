import { generateWorkload, toCorrelationEvents } from "../fixtures/correlation-workload.ts";
import { buildCorrelationGraph, buildJourney } from "@afe/core/correlation";
for (const rate of [0.3, 1.5, 5.5]) {
  const w = generateWorkload({ pushesPerRepoPerDay: rate });
  const ev = toCorrelationEvents(w.inputs);
  const h0 = process.memoryUsage().heapUsed;
  let t = performance.now();
  const g = buildCorrelationGraph(ev);
  const tg = performance.now() - t;
  const h1 = process.memoryUsage().heapUsed;
  t = performance.now();
  let steps = 0;
  for (const c of w.sampleCommits) steps += buildJourney(g, c.repository, c.commitSha)?.steps.length ?? 0;
  const tj = (performance.now() - t) / w.sampleCommits.length;
  console.log({
    rate,
    events: ev.length,
    links: g.links.length,
    conflicts: g.conflicts.length,
    targets: g.environments.length,
    graphMs: Math.round(tg),
    journeyMs: tj.toFixed(2),
    steps,
    graphHeapMB: Math.round((h1 - h0) / 1e6),
  });
}
