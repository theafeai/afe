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
}

export interface ArgoCdApplicationSource {
  repoURL?: string;
  path?: string;
  targetRevision?: string;
  chart?: string;
  ref?: string;
  name?: string;
}

export interface ArgoCdApplicationDestination {
  server?: string;
  namespace?: string;
  name?: string;
}

export interface ArgoCdSyncPolicy {
  automated?: { prune?: boolean; selfHeal?: boolean; allowEmpty?: boolean } | null;
  syncOptions?: string[];
}

export interface ArgoCdRevisionHistory {
  id?: number | string;
  revision?: string;
  revisions?: string[];
  deployedAt?: string;
  deployStartedAt?: string;
  source?: ArgoCdApplicationSource;
  sources?: ArgoCdApplicationSource[];
  initiatedBy?: { username?: string; automated?: boolean };
}

export interface ArgoCdOperationState {
  operation?: {
    sync?: { revision?: string; revisions?: string[]; prune?: boolean; dryRun?: boolean };
    initiatedBy?: { username?: string; automated?: boolean };
    info?: { name?: string; value?: string }[];
    retry?: unknown;
  };
  phase?: "Running" | "Terminating" | "Failed" | "Error" | "Succeeded" | string;
  message?: string;
  syncResult?: { revision?: string; revisions?: string[]; source?: ArgoCdApplicationSource };
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
  };
  status?: {
    sync?: { status?: string; revision?: string; revisions?: string[] };
    health?: { status?: string; message?: string };
    history?: ArgoCdRevisionHistory[];
    operationState?: ArgoCdOperationState;
    reconciledAt?: string;
    summary?: { images?: string[]; externalURLs?: string[] };
    sourceType?: string;
  };
  operation?: ArgoCdOperationState["operation"];
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
