import { generateWorkload, toCorrelationEvents } from "../fixtures/correlation-workload.ts";
import { buildLinks, deriveEnvironmentStates } from "@afe/core/correlation";
const ev = toCorrelationEvents(generateWorkload({ pushesPerRepoPerDay: 5.5 }).inputs);
let t = performance.now();
const { links } = buildLinks(ev);
console.log("links", Math.round(performance.now() - t));
t = performance.now();
deriveEnvironmentStates(ev, links);
console.log("envs", Math.round(performance.now() - t));
