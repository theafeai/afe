/**
 * Drift and untracked deploy detection (AFE-26). Import from "@afe/core/drift".
 * See docs/drift.md.
 *
 *   const graph = buildCorrelationGraph(events);
 *   const findings = detectDrift({
 *     environments: graph.environments,
 *     conflicts: graph.conflicts,
 *     events: graph.events,
 *   });
 */
export * from "./model.ts";
export * from "./detect.ts";
