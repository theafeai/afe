/**
 * What the capture remembers per connection and per application, so that it
 * emits only changes (transitions) and so that reconciliation can tell what
 * the watch stream missed. Stored by the server in `argocd_capture_cursors` /
 * `argocd_application_states` (migration 0010); tests use the memory store.
 *
 * Only identifiers, statuses, timestamps and hashes are stored; never spec
 * values (data minimisation).
 */

export interface ConnectionCaptureState {
  /**
   * When capture started for this connection. Anything that happened in the
   * source before it is recorded with observation method `backfill`.
   */
  baselineAt: string;
  /** Last resourceVersion seen on the watch stream, used to resume it. */
  resourceVersion?: string;
  lastStreamEventAt?: string;
  lastReconciledAt?: string;
}

/** Display summary of the spec fields that matter for an event (no values of tool settings). */
export interface SpecSummary {
  project?: string;
  repoURL?: string;
  path?: string;
  chart?: string;
  targetRevision?: string;
  /** Multi-source apps: `repoURL@targetRevision` per source. */
  sources?: string[];
  destinationServer?: string;
  destinationName?: string;
  destinationNamespace?: string;
  automated?: boolean;
  prune?: boolean;
  selfHeal?: boolean;
  syncOptions?: string[];
  /** Image overrides set on the Application, as `field=value` (kustomize images, Helm image parameters). */
  imageOverrides?: string[];
}

export interface AppCaptureState {
  uid: string;
  name: string;
  /** Namespace of the Application object (usually `argocd`). */
  appNamespace?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastResourceVersion?: string;
  /** SHA-256 of the canonical JSON of the whole spec. */
  specHash: string;
  /** Short hashes of individual spec paths, to report which fields changed. */
  specFieldHashes: Record<string, string>;
  spec: SpecSummary;
  /** Number of spec changes recorded so far; part of the update event key. */
  specChanges: number;
  syncStatus?: string;
  syncRevision?: string;
  healthStatus?: string;
  /** Last operation seen (identified by its startedAt). */
  operation?: { startedAt: string; phase: string; finished: boolean };
  /** History ids already recorded (or matched to a recorded operation). */
  historyIds: string[];
  /** Value of the refresh annotation while it is present. */
  refreshPending?: string;
  deletionRequestedAt?: string;
  /** User who requested the deletion (from the Kubernetes event), if known. */
  deletionRequestedBy?: string;
  deletedAt?: string;
  images?: string[];
}

/** Result of `CaptureStateStore.withApp`'s callback. */
export interface AppUpdate<T> {
  next: AppCaptureState;
  result: T;
  /** false: nothing worth persisting changed (only lastSeenAt). */
  persist?: boolean;
}

/**
 * Per-connection state store. `withApp` must serialise callbacks for the same
 * application (stream and reconciliation can run at the same time, possibly in
 * different processes) and persist `next` only if the callback succeeds.
 */
export interface CaptureStateStore {
  getConnectionState(): Promise<ConnectionCaptureState | null>;
  /** Creates the state with `baselineAt` if missing; returns the stored state. */
  initConnectionState(baselineAt: Date): Promise<ConnectionCaptureState>;
  updateConnectionState(patch: Partial<ConnectionCaptureState>): Promise<void>;
  withApp<T>(uid: string, fn: (prev: AppCaptureState | null) => Promise<AppUpdate<T>>): Promise<T>;
  /** All applications not yet recorded as deleted. */
  listLiveApps(): Promise<AppCaptureState[]>;
}

/** In-memory store, for tests and for the in-cluster agent's local buffer. */
export function createMemoryCaptureStateStore(): CaptureStateStore & {
  apps: Map<string, AppCaptureState>;
  connection: ConnectionCaptureState | null;
} {
  const apps = new Map<string, AppCaptureState>();
  const locks = new Map<string, Promise<unknown>>();
  const store = {
    apps,
    connection: null as ConnectionCaptureState | null,
    async getConnectionState() {
      return store.connection ? { ...store.connection } : null;
    },
    async initConnectionState(baselineAt: Date) {
      store.connection ??= { baselineAt: baselineAt.toISOString() };
      return { ...store.connection };
    },
    async updateConnectionState(patch: Partial<ConnectionCaptureState>) {
      if (!store.connection) throw new Error("connection state not initialised");
      store.connection = { ...store.connection, ...patch };
    },
    async withApp<T>(
      uid: string,
      fn: (prev: AppCaptureState | null) => Promise<AppUpdate<T>>,
    ): Promise<T> {
      const before = locks.get(uid) ?? Promise.resolve();
      const run = before.then(async () => {
        const prev = apps.get(uid);
        const { next, result } = await fn(prev ? structuredClone(prev) : null);
        apps.set(uid, structuredClone(next));
        return result;
      });
      locks.set(
        uid,
        run.catch(() => {}),
      );
      return run;
    },
    async listLiveApps() {
      return [...apps.values()].filter((a) => !a.deletedAt).map((a) => structuredClone(a));
    },
  };
  return store;
}
