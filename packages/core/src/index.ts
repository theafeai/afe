export const DEFAULT_TENANT_ID = "default";

// Canonical event model, hashing and ingestion contract (AFE-4, ADR 0003).
export * from "./actions.ts";
export * from "./canonical-json.ts";
export * from "./event.ts";
export * from "./hash-chain.ts";
export * from "./ingestion.ts";
export * from "./observation-gap.ts";
