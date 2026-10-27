// ArgoCD connector (AFE-9): read-only REST client, connection test, SSE watch reader.
// Design: docs/decisions/0004-argocd-connection-model.md, docs/connectors/argocd.md.
export const CONNECTOR_SOURCE = "argocd" as const;

/** Role name of the API token in `connection_credentials`. */
export const API_TOKEN_ROLE = "api_token" as const;
/** `credentials.kind` of an ArgoCD API token. */
export const API_TOKEN_KIND = "argocd_api_token" as const;

export * from "./types.ts";
export { ArgoCdError, type ArgoCdErrorKind } from "./errors.ts";
export {
  normaliseServerUrl,
  apiUrl,
  parseCaBundle,
  describeCaBundle,
  InvalidConnectionInputError,
  MAX_CA_BUNDLE_BYTES,
} from "./server-url.ts";
export {
  readSseStream,
  readJsonLines,
  SseParseError,
  type SseMessage,
  type SseReadOptions,
} from "./sse.ts";
export {
  createArgoCdTransport,
  type ArgoCdTransport,
  type HttpGet,
  type HttpGetInit,
  type HttpResponse,
  type TransportOptions,
} from "./transport.ts";
export {
  ArgoCdClient,
  readLimited,
  type ArgoCdClientOptions,
  type TokenProvider,
  type ListApplicationsOptions,
  type GetApplicationOptions,
  type WatchApplicationsOptions,
  type ListApplicationEventsOptions,
} from "./client.ts";
export {
  testArgoCdConnection,
  WRITE_CAPABILITY_CHECKS,
  SENSITIVE_READ_CHECKS,
  type ConnectionTestResult,
  type ReadOnlyCheck,
  type TestConnectionOptions,
} from "./connection-test.ts";
export {
  createArgoCdClient,
  type ArgoCdConnectionConfig,
  type ArgoCdClientHandle,
  type CreateClientOptions,
} from "./connect.ts";
export * from "./capture/index.ts";
// In-cluster agent wire protocol (AFE-28).
export * from "./agent-protocol.ts";
