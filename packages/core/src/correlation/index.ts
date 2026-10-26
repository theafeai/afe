/**
 * Cross-tool correlation prototype (AFE-15). Research code: see
 * docs/research/0001-cross-tool-flow.md. Import from "@afe/core/correlation".
 *
 *   const { links, conflicts } = buildLinks(events);
 *   const environments = deriveEnvironmentStates(events, links);
 *   const journeys = buildJourneys(events, links, environments);
 */
export * from "./model.ts";
export * from "./links.ts";
export * from "./environments.ts";
export * from "./journeys.ts";
