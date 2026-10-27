/**
 * Cross-tool correlation (AFE-15 prototype, productionised in AFE-20).
 * Import from "@afe/core/correlation". See docs/correlation.md.
 *
 *   const graph = buildCorrelationGraph(events);   // links, conflicts, environment targets
 *   const journey = buildJourney(graph, repository, commitSha);
 *
 * Lower level (prototype API, still supported):
 *   const { links, conflicts } = buildLinks(events);
 *   const environments = deriveEnvironmentStates(events, links);
 *   const journeys = buildJourneys(events, links, environments);
 */
export * from "./model.ts";
export * from "./links.ts";
export * from "./environments.ts";
export * from "./gaps.ts";
export * from "./journeys.ts";
