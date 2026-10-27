export const DEFAULT_TENANT_ID = "default";

export * from "./security/index.ts";
// Canonical event model and ingestion contract (AFE-4, ADR 0003).
export * from "./actions.ts";
export * from "./canonical-json.ts";
export * from "./digest.ts";
export * from "./event.ts";
export * from "./ingestion.ts";
export * from "./observation-gap.ts";
export * from "./connection.ts";
export * from "./alerts.ts";
// Event retention (ADR 0008).
export * from "./retention.ts";
// Event query filter and tenant resolution (AFE-14).
export * from "./event-filter.ts";
export * from "./tenant.ts";
// Authentication extension point (AFE-27, ADR 0006).
export * from "./auth.ts";
