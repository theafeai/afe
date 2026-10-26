// Event capture (AFE-10): watch + reconciliation of ArgoCD applications.
// Design: docs/connectors/argocd.md "Event capture".
export * from "./state.ts";
export * from "./mapping.ts";
export * from "./capture.ts";
export {
  parseAuditEvent,
  findAuditEntry,
  eventTime,
  type AuditEntry,
  type AuditMatch,
  type AuditVerb,
  type FindAuditOptions,
} from "./attribution.ts";
export {
  minimiseApplication,
  minimiseOperation,
  minimiseSource,
  REFRESH_ANNOTATION,
} from "./minimise.ts";
