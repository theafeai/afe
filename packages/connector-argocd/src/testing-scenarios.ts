/**
 * Builds realistic ArgoCD Application objects step by step for tests (never
 * for production): create, sync (manual/automated, prune/force/replace),
 * finish, rollback, terminate, refresh, spec changes, status changes,
 * deletion. Shapes follow ArgoCD 2.x (`v1alpha1.Application`); the
 * application controller's behaviour is imitated: a successful sync appends
 * a history entry with `deployStartedAt` = the operation's `startedAt`.
 */
import { randomUUID } from "node:crypto";
import type {
  ArgoCdApplication,
  ArgoCdApplicationSource,
  ArgoCdKubeEvent,
  ArgoCdRevisionHistory,
} from "./types.ts";

export interface FakeApplicationOptions {
  name: string;
  namespace?: string;
  project?: string;
  repoURL?: string;
  path?: string;
  targetRevision?: string;
  destination?: { server?: string; name?: string; namespace?: string };
  automated?: { prune?: boolean; selfHeal?: boolean } | null;
  labels?: Record<string, string>;
  createdAt: string;
  uid?: string;
  /** Imitate ArgoCD versions without `history[].deployStartedAt` (< 2.6). */
  legacyHistory?: boolean;
  sources?: ArgoCdApplicationSource[];
}

export interface FakeSyncOptions {
  at: string;
  /** A username, or "automated" for the controller. */
  by: string;
  revision?: string;
  revisions?: string[];
  prune?: boolean;
  force?: boolean;
  replace?: boolean;
  dryRun?: boolean;
  source?: ArgoCdApplicationSource;
  info?: { name: string; value: string }[];
}

/** A Kubernetes Event as argocd-server records it for a user action. */
export function auditEvent(
  user: string,
  action: string,
  at: string,
  reason = "ResourceUpdated",
): ArgoCdKubeEvent {
  return {
    metadata: { name: `app.${randomUUID().slice(0, 8)}`, uid: randomUUID() },
    reason,
    message: `${user} ${action}`,
    type: "Normal",
    count: 1,
    firstTimestamp: at,
    lastTimestamp: at,
    source: { component: "argocd-server" },
  };
}

export class FakeApplication {
  readonly app: ArgoCdApplication;
  readonly #legacy: boolean;

  constructor(o: FakeApplicationOptions) {
    this.#legacy = !!o.legacyHistory;
    this.app = {
      metadata: {
        name: o.name,
        namespace: o.namespace ?? "argocd",
        uid: o.uid ?? randomUUID(),
        generation: 1,
        creationTimestamp: o.createdAt,
        ...(o.labels ? { labels: { ...o.labels } } : {}),
      },
      spec: {
        project: o.project ?? "default",
        ...(o.sources
          ? { sources: structuredClone(o.sources) }
          : {
              source: {
                repoURL: o.repoURL ?? "https://github.com/acme/deploy.git",
                path: o.path ?? `apps/${o.name}`,
                targetRevision: o.targetRevision ?? "main",
              },
            }),
        destination: o.destination ?? {
          server: "https://kubernetes.default.svc",
          namespace: o.name,
        },
        syncPolicy: o.automated ? { automated: { ...o.automated } } : {},
      },
      status: {
        sync: { status: "OutOfSync" },
        health: { status: "Missing" },
        history: [],
        reconciledAt: o.createdAt,
      },
    };
  }

  get uid(): string {
    return this.app.metadata!.uid!;
  }

  get name(): string {
    return this.app.metadata!.name!;
  }

  snapshot(): ArgoCdApplication {
    return structuredClone(this.app);
  }

  #bump(at?: string): this {
    const m = this.app.metadata!;
    m.generation = Number(m.generation ?? 1) + 1;
    if (at) this.app.status!.reconciledAt = at;
    return this;
  }

  updateSpec(fn: (spec: NonNullable<ArgoCdApplication["spec"]>) => void): this {
    fn(this.app.spec!);
    return this.#bump();
  }

  startSync(o: FakeSyncOptions): this {
    const initiatedBy = o.by === "automated" ? { automated: true } : { username: o.by };
    const syncOptions = [
      ...(o.force ? ["Force=true"] : []),
      ...(o.replace ? ["Replace=true"] : []),
    ];
    this.app.status!.operationState = {
      operation: {
        sync: {
          ...(o.revisions ? { revisions: o.revisions } : { revision: o.revision }),
          ...(o.prune ? { prune: true } : {}),
          ...(o.dryRun ? { dryRun: true } : {}),
          ...(syncOptions.length ? { syncOptions } : {}),
          ...(o.force ? { syncStrategy: { apply: { force: true } } } : {}),
          ...(o.source ? { source: o.source } : {}),
        },
        initiatedBy,
        ...(o.info ? { info: o.info } : {}),
        retry: {},
      },
      phase: "Running",
      message: "one or more tasks are running",
      startedAt: o.at,
    };
    this.app.status!.health = { status: "Progressing" };
    return this.#bump(o.at);
  }

  finishSync(o: { at: string; phase?: string; message?: string; images?: string[] }): this {
    const os = this.app.status!.operationState!;
    const phase = o.phase ?? "Succeeded";
    const sync = os.operation!.sync!;
    const revs = sync.revisions ?? (sync.revision ? [sync.revision] : []);
    os.phase = phase;
    os.finishedAt = o.at;
    os.message =
      o.message ??
      (phase === "Succeeded"
        ? "successfully synced (all tasks run)"
        : "one or more objects failed to apply");
    os.syncResult = {
      ...(sync.revisions ? { revisions: revs } : { revision: revs[0] }),
      resources: [],
    };
    if (phase === "Succeeded" && !sync.dryRun) {
      const history = this.app.status!.history!;
      const id = (history.at(-1)?.id !== undefined ? Number(history.at(-1)!.id) : -1) + 1;
      const entry: ArgoCdRevisionHistory = {
        id,
        ...(sync.revisions ? { revisions: revs } : { revision: revs[0] }),
        deployedAt: o.at,
        ...(this.app.spec?.sources
          ? { sources: structuredClone(this.app.spec.sources) }
          : { source: structuredClone(sync.source ?? this.app.spec!.source!) }),
      };
      if (!this.#legacy) {
        entry.deployStartedAt = os.startedAt;
        entry.initiatedBy = structuredClone(os.operation!.initiatedBy);
      }
      history.push(entry);
      this.app.status!.sync = {
        status: "Synced",
        ...(sync.revisions ? { revisions: revs } : { revision: revs[0] }),
      };
      this.app.status!.health = { status: "Healthy" };
      if (o.images) this.app.status!.summary = { images: [...o.images] };
    }
    return this.#bump(o.at);
  }

  /** `argocd app terminate-op`: the operation ends as Failed, "Operation terminated". */
  terminate(at: string): this {
    return this.finishSync({ at, phase: "Failed", message: "Operation terminated" });
  }

  /** `argocd app rollback <id>`: a sync of the history entry's revision and source. */
  rollback(o: { at: string; by: string; toId: number; info?: boolean }): this {
    const h = this.app.status!.history!.find((x) => Number(x.id) === o.toId);
    if (!h) throw new Error(`no history id ${o.toId}`);
    return this.startSync({
      at: o.at,
      by: o.by,
      revision: h.revision,
      ...(h.source ? { source: structuredClone(h.source) } : {}),
      ...(o.info ? { info: [{ name: "Reason", value: "Rollback" }] } : {}),
    });
  }

  setHealth(status: string, at: string): this {
    this.app.status!.health = { status };
    return this.#bump(at);
  }

  setSyncStatus(status: string, at: string, revision?: string): this {
    this.app.status!.sync = { ...this.app.status!.sync, status, ...(revision ? { revision } : {}) };
    return this.#bump(at);
  }

  setImages(images: string[]): this {
    this.app.status!.summary = { images: [...images] };
    return this.#bump();
  }

  requestRefresh(type: "normal" | "hard" = "normal"): this {
    const m = this.app.metadata!;
    m.annotations = { ...m.annotations, "argocd.argoproj.io/refresh": type };
    return this;
  }

  clearRefresh(at: string): this {
    const m = this.app.metadata!;
    if (m.annotations) delete m.annotations["argocd.argoproj.io/refresh"];
    return this.#bump(at);
  }

  requestDeletion(at: string, cascade = true): this {
    const m = this.app.metadata!;
    m.deletionTimestamp = at;
    if (cascade) m.finalizers = ["resources-finalizer.argocd.argoproj.io"];
    return this;
  }
}
