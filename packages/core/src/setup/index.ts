/**
 * Inferred setup and admin overrides (D-0012, D-0024). Import from
 * "@afe/core/setup". Reference: docs/environment-mapping.md "Inferred setup".
 *
 *   const facts = inferSetup(events, { mapping, adminEnvironmentIds }); // the job
 *   const setup = mergeSetup({ adminEnvironments, inferred, overrides }); // reads
 */
export * from "./types.ts";
export * from "./signals.ts";
export * from "./infer.ts";
export * from "./merge.ts";
export * from "./validate.ts";
