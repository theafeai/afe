/**
 * The subset of the ArgoCD REST API (grpc-gateway, `/api/...`) that Afe reads.
 * Shapes follow the ArgoCD swagger (`assets/swagger.json`, v2.x); every field
 * is optional because Afe also asks for partial objects with `fields=`.
 *
 * Reference: https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/
 */

/** `GET /api/version`. */
export interface ArgoCdVersion {
  Version?: string;
  BuildDate?: string;
  GitCommit?: string;
  GitTreeState?: string;
  GoVersion?: string;
  Compiler?: string;
  Platform?: string;
  KustomizeVersion?: string;
  HelmVersion?: string;
  KubectlVersion?: string;
  JsonnetVersion?: string;
  ExtraBuildInfo?: string;
}

/** `GET /api/v1/session/userinfo`. */
export interface ArgoCdUserInfo {
  loggedIn?: boolean;
  username?: string;
  iss?: string;
  groups?: string[];
}

/** `GET /api/v1/account/can-i/{resource}/{action}/{subresource}`. */
export interface ArgoCdCanIResponse {
  value?: "yes" | "no" | string;
}

export interface ArgoCdObjectMeta {
  name?: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number | string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finalizers?: string[];
}

export interface ArgoCdApplicationSource {
  repoURL?: string;
  path?: string;
  targetRevision?: string;
  chart?: string;
  ref?: string;
  name?: string;
  /**
   * Tool-specific settings (`helm`, `kustomize`, `directory`, `plugin`). Afe
   * never stores their values (they can hold secrets); it only notices that
   * they changed (data minimisation, docs/security/rules.md R8).
   */
  [key: string]: unknown;
}

export interface ArgoCdApplicationDestination {
  server?: string;
  namespace?: string;
  name?: string;
}

export interface ArgoCdSyncPolicy {
  automated?: { prune?: boolean; selfHeal?: boolean; allowEmpty?: boolean } | null;
  syncOptions?: string[];
  retry?: unknown;
}

/** `initiatedBy` of an operation or history entry. */
export interface ArgoCdOperationInitiator {
  username?: string;
  automated?: boolean;
}

/** `operation.sync` (v1alpha1.SyncOperation), the fields Afe reads. */
export interface ArgoCdSyncOperation {
  revision?: string;
  revisions?: string[];
  prune?: boolean;
  dryRun?: boolean;
  syncOptions?: string[];
  /** `apply.force` / `hook.force` = sync with `--force`. */
  syncStrategy?: { apply?: { force?: boolean }; hook?: { force?: boolean } };
  /** Selective sync: only these resources. */
  resources?: { group?: string; kind?: string; name?: string; namespace?: string }[];
  source?: ArgoCdApplicationSource;
  sources?: ArgoCdApplicationSource[];
}

/** `operation` (v1alpha1.Operation). */
export interface ArgoCdOperation {
  sync?: ArgoCdSyncOperation;
  initiatedBy?: ArgoCdOperationInitiator;
  info?: { name?: string; value?: string }[];
  retry?: unknown;
}

export interface ArgoCdRevisionHistory {
  id?: number | string;
  revision?: string;
  revisions?: string[];
  deployedAt?: string;
  deployStartedAt?: string;
  source?: ArgoCdApplicationSource;
  sources?: ArgoCdApplicationSource[];
  initiatedBy?: ArgoCdOperationInitiator;
}

export interface ArgoCdOperationState {
  operation?: ArgoCdOperation;
  phase?: "Running" | "Terminating" | "Failed" | "Error" | "Succeeded" | string;
  message?: string;
  syncResult?: {
    revision?: string;
    revisions?: string[];
    source?: ArgoCdApplicationSource;
    sources?: ArgoCdApplicationSource[];
    resources?: unknown[];
  };
  startedAt?: string;
  finishedAt?: string;
  retryCount?: number | string;
}

export interface ArgoCdApplication {
  metadata?: ArgoCdObjectMeta;
  spec?: {
    project?: string;
    source?: ArgoCdApplicationSource;
    sources?: ArgoCdApplicationSource[];
    destination?: ArgoCdApplicationDestination;
    syncPolicy?: ArgoCdSyncPolicy;
    [key: string]: unknown;
  };
  status?: {
    sync?: { status?: string; revision?: string; revisions?: string[] };
    health?: { status?: string; message?: string; lastTransitionTime?: string };
    history?: ArgoCdRevisionHistory[];
    operationState?: ArgoCdOperationState;
    reconciledAt?: string;
    summary?: { images?: string[]; externalURLs?: string[] };
    sourceType?: string;
  };
  operation?: ArgoCdOperation;
}

/** `GET /api/v1/applications`. */
export interface ArgoCdApplicationList {
  metadata?: { resourceVersion?: string; continue?: string };
  items?: ArgoCdApplication[] | null;
}

export type ArgoCdWatchEventType = "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";

/** One entry of `GET /api/v1/stream/applications`. */
export interface ArgoCdApplicationWatchEvent {
  type: ArgoCdWatchEventType | string;
  application: ArgoCdApplication;
}

/**
 * A Kubernetes Event about an Application, from
 * `GET /api/v1/applications/{name}/events` (core/v1 Event). argocd-server
 * records who did what ("alice initiated sync to main (abc123)"); the
 * application controller records automated actions and status changes.
 */
export interface ArgoCdKubeEvent {
  metadata?: { name?: string; uid?: string; creationTimestamp?: string };
  involvedObject?: { kind?: string; name?: string; namespace?: string; uid?: string };
  reason?: string;
  message?: string;
  type?: string;
  count?: number;
  firstTimestamp?: string | null;
  lastTimestamp?: string | null;
  eventTime?: string | null;
  source?: { component?: string };
  reportingComponent?: string;
}

/** `GET /api/v1/applications/{name}/events`. */
export interface ArgoCdKubeEventList {
  items?: ArgoCdKubeEvent[] | null;
}
