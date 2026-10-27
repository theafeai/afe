/**
 * Environment and service mapping (AFE-19). Import from "@afe/core/mapping".
 * Reference: docs/environment-mapping.md.
 *
 *   const mapping = compileMapping(config);          // once per configuration
 *   const placement = resolvePlacement(event, mapping); // per event, at read time
 */
export * from "./types.ts";
export * from "./safe-regex.ts";
export * from "./glob.ts";
export * from "./fields.ts";
export * from "./defaults.ts";
export * from "./resolve.ts";
export * from "./validate.ts";
