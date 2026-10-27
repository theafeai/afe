/**
 * Response shapes of the Afe HTTP API used by the UI. Event and connection
 * model types come from `@afe/core/types` (type-only); the rest mirror the
 * route code (apps/server/src/api/events.ts, health/routes.ts, connectors/*.ts)
 * and docs/api.md, docs/connection-health.md, docs/connectors/*.md.
 */
import type {
  ActorType,
  CanonicalEvent,
  ConnectionStatus,
  ObservationGapReason,
  ObservationMethod,
  Outcome,
  Trigger,
} from "@afe/core/types";

export type {
  CanonicalEvent,
  ConnectionStatus,
  ObservationGap,
  ObservationMethod,
  Outcome,
} from "@afe/core/types";

export interface Provenance {
  source: string;
  sourceEventId: string;
  method: ObservationMethod;
  discoveredByReconciliation: boolean;
  deliveryId: string | null;
  jobId: string | null;
  connectionId: string | null;
  observedAt: string;
  recordedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  snapshotSeq: number;
}

export interface EventItem {
  event: CanonicalEvent;
  provenance: Provenance;
}

export interface ChainHead {
  seq: number;
  hash: string;
}

export interface EventDetail extends EventItem {
  rawPayload: {
    id: string;
    sha256: string;
    contentType: string | null;
    sizeBytes: number | null;
    receivedAt: string | null;
    verified: boolean;
    url: string;
  } | null;
  chain: {
    seq: number;
    prevHash: string;
    hash: string;
    hashVerified: boolean;
    prevLinkVerified: boolean;
    head: ChainHead | null;
  };
}

interface ActorSummary {
  type: ActorType;
  id?: string;
  login?: string;
  name?: string;
}

export interface DeploymentRow {
  eventId: string;
  seq: number;
  when: string;
  source: string;
  action: string;
  outcome: Outcome;
  who: {
    type: ActorType;
    id: string | null;
    login: string | null;
    name: string | null;
    onBehalfOf: ActorSummary | null;
    triggeredBy: ActorSummary | null;
  };
  what: {
    commitShas: string[];
    refs: string[];
    imageRefs: string[];
    imageDigests: string[];
    deploymentIds: string[];
  };
  where: {
    environment: string | null;
    targetType: string;
    targetId: string;
    targetName: string | null;
    repository: string | null;
    project: string | null;
    application: string | null;
    cluster: string | null;
    namespace: string | null;
    url: string | null;
  };
  how: Trigger;
  provenance: Provenance;
}

/** `ChainBreak` from @afe/core hash-chain.ts (not importable in the browser: node:crypto). */
export interface ChainBreak {
  kind: string;
  index: number;
  seq: number | null;
  eventId: string | null;
  expected: string | number | null;
  actual: string | number | null;
  message: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  verification: {
    ok: boolean;
    count: number;
    lastSeq: number;
    lastHash: string;
    break?: ChainBreak;
  };
  head: ChainHead | null;
  anchor: { seq: number; hash: string; found: boolean; matches: boolean } | null;
}

// --- Connections and health (docs/connection-health.md) ---------------------

export type HealthState =
  "healthy" | "degraded" | "unreachable" | "rate_limited" | "unauthorized" | "revoked" | "unknown";

export interface OpenGap {
  id: string;
  startedAt: string;
  reason: ObservationGapReason | string | null;
}

export interface AlertView {
  id: string;
  kind: string;
  message: string;
  gapId: string | null;
  blindSince: string | null;
  openedAt: string | null;
  resolvedAt: string | null;
}

export interface ConnectionWithHealth {
  id: string;
  source: string;
  externalId: string;
  name: string;
  status: ConnectionStatus;
  statusReason: string | null;
  createdAt: string | null;
  health: {
    state: HealthState;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastFailureAt: string | null;
    lastErrorReason: string | null;
    lastError: string | null;
    consecutiveFailures: number;
    nextAttemptAt: string | null;
    openGap: OpenGap | null;
    lastBackfill: {
      gapId: string;
      status: string | null;
      at: string | null;
      error: string | null;
    } | null;
  };
  alert: AlertView | null;
}

export interface GapRecord {
  gapId: string;
  startedAt: string;
  endedAt: string | null;
  reason: string;
  detail: string | null;
  open: boolean;
  openedEventId: string | null;
  closedEventId: string | null;
}

export interface ConnectionHealthDetail {
  connection: ConnectionWithHealth;
  gaps: GapRecord[];
  alerts: AlertView[];
}

// --- GitHub (docs/connectors/github.md) --------------------------------------

export interface GitHubAppStatus {
  configured: boolean;
  slug: string | null;
  origin: "env" | "options" | "database" | null;
  installUrl: string | null;
  manifestFlow: { available: boolean; publicUrlConfigured: boolean; url: string };
}

// --- ArgoCD (docs/connectors/argocd.md) ---------------------------------------

export interface ReadOnlyCheck {
  status: "verified" | "write_capable" | "unavailable";
  writeCapabilities: string[];
  sensitiveReadCapabilities: string[];
  objectsChecked: string[];
}

export interface ArgoCdConnection {
  id: string;
  source: "argocd";
  name: string;
  externalId: string;
  status: ConnectionStatus;
  statusReason: string | null;
  config: {
    serverUrl?: string;
    argocdVersion?: string | null;
    account?: string;
    readOnlyCheck?: ReadOnlyCheck["status"];
    verifiedAt?: string;
  };
  caCertificates: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface ArgoCdTestResult {
  server: { version: string | null };
  account: { username: string; issuer: string | null };
  applicationCount: number;
  readOnlyCheck: ReadOnlyCheck;
  warnings: string[];
}

export interface ArgoCdConnectResult extends ArgoCdTestResult {
  connection: ArgoCdConnection;
}

// --- Vercel (docs/connectors/vercel.md) ---------------------------------------

export type ProjectSelection =
  { mode: "none" } | { mode: "all" } | { mode: "selected"; projectIds: string[] };

export interface VercelIntegrationStatus {
  configured: boolean;
  slug: string | null;
  installUrl: string | null;
  missing: string[];
}

export interface VercelConnectionView {
  id: string;
  source: "vercel";
  externalId: string;
  name: string;
  status: ConnectionStatus;
  statusReason: string | null;
  config: { mode?: "integration" | "token"; teamId?: string | null; projectSelection?: unknown };
}

export interface VercelProjects {
  selection: ProjectSelection;
  projects: {
    id: string;
    name: string;
    framework: string | null;
    updatedAt: number | null;
    selected: boolean;
  }[];
}

/** `GET/POST /api/session` (ADR 0006). */
export interface SessionInfo {
  principal: {
    id: string;
    tenantId: string;
    roles: ("admin" | "viewer")[];
    kind: string;
    name: string | null;
  };
  csrfToken: string | null;
  expiresAt: string | null;
}
