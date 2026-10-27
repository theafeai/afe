import { generateWorkload, toCorrelationEvents } from "../fixtures/correlation-workload.ts";
import { buildLinks, deriveEnvironmentStates, buildJourneys } from "@afe/core/correlation";
import { parseEventInput } from "@afe/core";
for (const rate of [0.3, 1.5, 5.5]) {
  const w = generateWorkload({ pushesPerRepoPerDay: rate });
  if (rate === 0.3) for (const i of w.inputs) parseEventInput(i);
  const ev = toCorrelationEvents(w.inputs);
  let t = performance.now();
  const { links, conflicts } = buildLinks(ev);
  const tl = performance.now() - t;
  t = performance.now();
  const envs = deriveEnvironmentStates(ev, links);
  const te = performance.now() - t;
  t = performance.now();
  const js = rate < 1 ? buildJourneys(ev, links, envs) : [];
  const tj = performance.now() - t;
  console.log({ rate, events: ev.length, links: links.length, conflicts: conflicts.length, envs: envs.length, tl: Math.round(tl), te: Math.round(te), tj: Math.round(tj), journeys: js.length });
}
