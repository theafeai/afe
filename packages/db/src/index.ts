export { migrate, MIGRATIONS_DIR } from "./migrate.ts";
export { createPool } from "./pool.ts";
export {
  type CredentialMetadata,
  type StoredCredential,
  type StoreCredentialInput,
  storeCredential,
  getCredential,
  getCredentialMetadata,
  rotateCredential,
  revokeCredential,
  listCredentials,
  reencryptAll,
  reencryptAllTenants,
  tenantsWithCredentialsNotUnderKey,
} from "./credentials.ts";
export {
  recordDelivery,
  createDbReplayGuard,
  pruneWebhookDeliveries,
} from "./webhook-deliveries.ts";
export {
  createPgEventSink,
  findEventBySourceId,
  getEvent,
  ingestEvent,
  listEvents,
  verifyTenantChain,
  type EventPage,
  type ListEventsOptions,
  type Queryable,
  type VerifyTenantChainOptions,
} from "./event-store.ts";
export {
  attachConnectionCredential,
  findConnectionByExternalId,
  getConnection,
  getConnectionCredentialIds,
  listActiveConnections,
  listConnections,
  resolveConnectionBySourceIdentity,
  setConnectionStatus,
  updateConnectionConfig,
  upsertConnection,
  type ListConnectionsOptions,
  type UpsertConnectionInput,
} from "./connections.ts";
export {
  eventFilterSql,
  getChainHead,
  getEventBySeq,
  getRawPayload,
  InvalidCursorError,
  openEventExport,
  queryEvents,
  type EventExportSnapshot,
  type EventOrder,
  type QueryEventsOptions,
  type QueryEventsPage,
  type StoredRawPayload,
} from "./event-query.ts";
