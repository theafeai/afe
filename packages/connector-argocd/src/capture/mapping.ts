/**
 * Maps observations of ArgoCD Applications to canonical audit events (AFE-10).
 *
 * Pure apart from the optional, lazily-called `appEvents` lookup: given what
 * was last seen of an application (`AppCaptureState`) and its current object,
 * it returns the events for everything that changed and the next state. The
 * watch stream and reconciliation both call it, so the same change produces
 * the same `sourceEventId` however it is observed (docs/event-model.md,
 * refined in docs/connectors/argocd.md "Event capture").
 */
import { createHash } from "node:crypto";
import {
  ACTIONS,
  canonicalJson,
  IMAGE_REF_PATTERN,
  jsonRawPayload,
  repositoryKey,
  sourceEventId,
  type ActorRef,
  type CanonicalEventInputLike,
  type JsonObject,
  type JsonValue,
  type ObservationMethod,
  type Outcome,
  type TriggerType,
} from "@afe/core";
import type {
  ArgoCdApplication,
  ArgoCdApplicationSource,
  ArgoCdKubeEvent,
  ArgoCdOperationInitiator,
  ArgoCdOperationState,
  ArgoCdRevisionHistory,
} from "../types.ts";
import { findAuditEntry, type AuditMatch, type AuditVerb } from "./attribution.ts";
import { REFRESH_ANNOTATION, minimiseApplication } from "./minimise.ts";
import type { AppCaptureState, SpecSummary } from "./state.ts";

const SOURCE = "argocd";

/** Actions emitted by the ArgoCD capture. The last two are new (not yet in core `ACTIONS`). */
export const ARGOCD_ACTIONS = {
  SYNC_STARTED: ACTIONS.ARGOCD_SYNC_STARTED,
  SYNC_SUCCEEDED: ACTIONS.ARGOCD_SYNC_SUCCEEDED,
  SYNC_FAILED: ACTIONS.ARGOCD_SYNC_FAILED,
  SYNC_TERMINATED: ACTIONS.ARGOCD_SYNC_TERMINATED,
  ROLLED_BACK: ACTIONS.DEPLOYMENT_ROLLED_BACK,
  APPLICATION_CREATED: ACTIONS.ARGOCD_APPLICATION_CREATED,
  APPLICATION_UPDATED: ACTIONS.ARGOCD_APPLICATION_UPDATED,
  APPLICATION_DELETED: ACTIONS.ARGOCD_APPLICATION_DELETED,
  HEALTH_CHANGED: ACTIONS.ARGOCD_HEALTH_CHANGED,
  APPLICATION_REFRESHED: ACTIONS.ARGOCD_APPLICATION_REFRESHED,
  SYNC_STATUS_CHANGED: ACTIONS.ARGOCD_SYNC_STATUS_CHANGED,
} as const;

/** The automated actor: ArgoCD's application controller. */
export const CONTROLLER_ACTOR: ActorRef = {
  type: "system",
  id: "argocd-application-controller",
  name: "Argo CD application controller",
};

/** How certain a derived fact is; stored in `data.confidence` with `data.evidence`. */
export type Confidence = "certain" | "high" | "medium" | "low";

export interface ObserveContext {
  connectionId: string;
  /** How this observation was made. Events that happened before `baselineAt` are recorded as `backfill`. */
  method: Extract<ObservationMethod, "stream" | "reconciliation">;
  observedAt: Date;
  /** When capture started for the connection. */
  baselineAt: Date;
  /** Watch event type (ADDED/MODIFIED/DELETED) for stream observations. */
  watchType?: string;
  jobId?: string;
  /**
   * Transport that delivered the observation when it is not Afe's own pull
   * (AFE-28: "agent", the in-cluster agent). Only changes `observation.detail`;
   * keys and mapping are identical, so agent and pull observations dedupe.
   */
  transport?: "agent";
  /**
   * Loads the Kubernetes Events of the application (actor attribution). Called
   * at most once per observation and only when needed; failures are tolerated.
   */
  appEvents?: () => Promise<ArgoCdKubeEvent[]>;
  /** Environment name for correlation (configured mapping). Default: see `defaultEnvironmentOf`. */
  environmentOf?: (app: ArgoCdApplication) => string | undefined;
}

export interface ObserveResult {
  events: CanonicalEventInputLike[];
  next: AppCaptureState;
  /** false when only lastSeenAt/resourceVersion changed (no need to persist immediately). */
  significant: boolean;
}

/** Labels that name the environment of an application, in order of preference. */
export const ENVIRONMENT_LABELS = ["afe.dev/environment", "environment", "env"] as const;

export function defaultEnvironmentOf(app: ArgoCdApplication): string | undefined {
  const labels = app.metadata?.labels ?? {};
  for (const l of ENVIRONMENT_LABELS) if (labels[l]) return labels[l];
  return undefined;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const FINISHED_PHASES = new Set(["Succeeded", "Failed", "Error"]);
const SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/i;
const DIGEST_RE = /@(sha256:[0-9a-f]{64})$/i;
const ATTRIBUTION_WINDOW_MS = 120_000;

function iso(t: string | undefined | null): string | undefined {
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function sha(s: string, len = 64): string {
  return createHash("sha256").update(s).digest("hex").slice(0, len);
}

function hashJson(v: unknown, len = 64): string {
  try {
    return sha(canonicalJson(v ?? null), len);
  } catch {
    return sha(JSON.stringify(v ?? null), len);
  }
}

const truncate = (s: string | undefined, n = 1000) =>
  s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}…` : s;

function clean(obj: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v as JsonValue;
  }
  return out;
}

function sourcesOf(app: ArgoCdApplication): ArgoCdApplicationSource[] {
  const list = app.spec?.sources?.length
    ? app.spec.sources
    : app.spec?.source
      ? [app.spec.source]
      : [];
  return list.filter((s) => s && typeof s === "object");
}

function repoKeys(sources: readonly (ArgoCdApplicationSource | { repoURL?: string })[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (!s.repoURL) continue;
    try {
      out.push(repositoryKey(s.repoURL));
    } catch {
      // not a URL we can normalise; it stays in the raw payload
    }
  }
  return out;
}

const shas = (revs: (string | undefined)[]) =>
  revs.filter((r): r is string => !!r && SHA_RE.test(r));

function imageKeys(images: readonly string[] | undefined): { refs: string[]; digests: string[] } {
  const refs: string[] = [];
  const digests: string[] = [];
  for (const img of images ?? []) {
    // Kept whole, digest-pinned form included ("repo:tag@sha256:…"); refs the
    // correlation schema would reject are skipped rather than failing the event.
    if (!img || img.length > 1024 || !IMAGE_REF_PATTERN.test(img)) continue;
    refs.push(img);
    const d = DIGEST_RE.exec(img)?.[1];
    if (d) digests.push(d.toLowerCase());
  }
  return { refs, digests };
}

function appNs(app: ArgoCdApplication): string | undefined {
  return app.metadata?.namespace || undefined;
}

function deploymentId(ns: string | undefined, name: string, historyId: string): string {
  return `argocd:${ns ?? "argocd"}/${name}:${historyId}`;
}

// ---------------------------------------------------------------------------
// Spec summary, field hashes and image overrides
// ---------------------------------------------------------------------------

function flatten(value: unknown, path: string, depth: number, out: Record<string, string>): void {
  if (value && typeof value === "object" && !Array.isArray(value) && depth < 3) {
    for (const [k, v] of Object.entries(value))
      flatten(v, path ? `${path}.${k}` : k, depth + 1, out);
    return;
  }
  out[path || "(root)"] = hashJson(value, 16);
}

function looksLikeImage(s: string): boolean {
  return /^[a-z0-9.-]+(:[0-9]+)?\/[^\s=]+([:@][^\s]+)$/i.test(s) || /^[^\s/=]+:[^\s/=]+$/.test(s);
}

interface ImageOverrides {
  /** `field=value` pairs (no other values are kept). */
  fields: string[];
  refs: string[];
}

/** Image overrides set on the Application (kustomize images, Helm image parameters/values). */
export function imageOverridesOf(app: ArgoCdApplication): ImageOverrides {
  const fields: string[] = [];
  const refs: string[] = [];
  const add = (field: string, value: string, ref?: string) => {
    fields.push(`${field}=${value}`);
    if (ref && ref.length <= 1024) refs.push(ref);
  };
  const list = app.spec?.sources?.length
    ? app.spec.sources
    : app.spec?.source
      ? [app.spec.source]
      : [];
  list.forEach((src, i) => {
    const p = app.spec?.sources?.length ? `sources[${i}]` : "source";
    const kustomize = src?.kustomize as { images?: unknown } | undefined;
    if (Array.isArray(kustomize?.images)) {
      for (const img of kustomize.images) {
        if (typeof img !== "string") continue;
        const ref = img.includes("=") ? img.slice(img.indexOf("=") + 1) : img;
        add(`${p}.kustomize.images`, img, looksLikeImage(ref) ? ref : undefined);
      }
    }
    const helm = src?.helm as { parameters?: unknown; valuesObject?: unknown } | undefined;
    if (Array.isArray(helm?.parameters)) {
      const byPrefix = new Map<string, Record<string, string>>();
      for (const prm of helm.parameters as { name?: unknown; value?: unknown }[]) {
        if (typeof prm?.name !== "string" || typeof prm.value !== "string") continue;
        if (!/image/i.test(prm.name)) continue;
        const last = prm.name.lastIndexOf(".");
        const prefix = last > 0 ? prm.name.slice(0, last) : "";
        const leaf = last > 0 ? prm.name.slice(last + 1) : prm.name;
        const g = byPrefix.get(prefix) ?? {};
        g[leaf] = prm.value;
        byPrefix.set(prefix, g);
        add(
          `${p}.helm.parameters.${prm.name}`,
          prm.value,
          looksLikeImage(prm.value) && prm.value.includes("/") ? prm.value : undefined,
        );
      }
      for (const g of byPrefix.values()) {
        if (g.repository && (g.tag || g.digest)) {
          refs.push(`${g.repository}${g.tag ? `:${g.tag}` : ""}${g.digest ? `@${g.digest}` : ""}`);
        }
      }
    }
    if (helm?.valuesObject && typeof helm.valuesObject === "object") {
      const walk = (v: unknown, path: string, depth: number) => {
        if (!v || typeof v !== "object" || depth > 6) return;
        for (const [k, child] of Object.entries(v)) {
          const here = `${path}.${k}`;
          if (k === "image") {
            if (typeof child === "string")
              add(here, child, looksLikeImage(child) ? child : undefined);
            else if (child && typeof child === "object") {
              const c = child as Record<string, unknown>;
              const repo = [c.registry, c.repository]
                .filter((x) => typeof x === "string")
                .join("/");
              const tag = typeof c.tag === "string" ? c.tag : undefined;
              const digest = typeof c.digest === "string" ? c.digest : undefined;
              if (repo) {
                const ref = `${repo}${tag ? `:${tag}` : ""}${digest ? `@${digest}` : ""}`;
                add(here, ref, tag || digest ? ref : undefined);
              }
            }
          } else walk(child, here, depth + 1);
        }
      };
      walk(helm.valuesObject, `${p}.helm.valuesObject`, 0);
    }
  });
  return { fields: [...new Set(fields)].sort(), refs: [...new Set(refs)].sort() };
}

export function summariseSpec(app: ArgoCdApplication): SpecSummary {
  const spec = app.spec ?? {};
  const src = spec.source;
  const auto = spec.syncPolicy?.automated;
  const s: SpecSummary = {
    project: spec.project,
    repoURL: src?.repoURL,
    path: src?.path,
    chart: src?.chart,
    targetRevision: src?.targetRevision,
    destinationServer: spec.destination?.server,
    destinationName: spec.destination?.name,
    destinationNamespace: spec.destination?.namespace,
    automated: !!auto,
    prune: auto ? !!auto.prune : undefined,
    selfHeal: auto ? !!auto.selfHeal : undefined,
    syncOptions: spec.syncPolicy?.syncOptions?.length
      ? [...spec.syncPolicy.syncOptions]
      : undefined,
  };
  if (spec.sources?.length) {
    s.sources = spec.sources.map(
      (x) =>
        `${x.repoURL ?? ""}${x.chart ? `/${x.chart}` : x.path ? `/${x.path}` : ""}@${x.targetRevision ?? ""}`,
    );
  }
  const overrides = imageOverridesOf(app).fields;
  if (overrides.length) s.imageOverrides = overrides;
  for (const k of Object.keys(s) as (keyof SpecSummary)[]) if (s[k] === undefined) delete s[k];
  return s;
}

function specFieldHashes(app: ArgoCdApplication): Record<string, string> {
  const out: Record<string, string> = {};
  flatten(app.spec ?? {}, "", 0, out);
  return out;
}

// ---------------------------------------------------------------------------
// Target, correlation and event assembly
// ---------------------------------------------------------------------------

interface AppIdentity {
  uid: string;
  name: string;
  ns?: string;
  spec: SpecSummary;
}

function targetOf(id: AppIdentity) {
  const s = id.spec;
  return clean({
    type: "application",
    id: id.ns ? `${id.ns}/${id.name}` : id.name,
    name: id.name,
    application: id.name,
    project: s.project,
    repository: s.repoURL,
    ref: s.targetRevision,
    cluster: s.destinationName ?? s.destinationServer,
    namespace: s.destinationNamespace,
  });
}

interface CorrelationParts {
  revisions?: (string | undefined)[];
  sources?: (ArgoCdApplicationSource | { repoURL?: string })[];
  images?: string[];
  imageOverrides?: string[];
  environment?: string;
  deploymentIds?: string[];
}

function correlationOf(p: CorrelationParts): JsonObject {
  const img = imageKeys([...(p.images ?? []), ...(p.imageOverrides ?? [])]);
  return clean({
    commitShas: shas(p.revisions ?? []),
    repositories: repoKeys(p.sources ?? []),
    environments: p.environment ? [p.environment] : undefined,
    imageRefs: img.refs,
    imageDigests: img.digests,
    deploymentIds: p.deploymentIds,
  });
}

function actorOf(by: ArgoCdOperationInitiator | undefined): {
  actor: JsonObject;
  trigger: TriggerType;
  sourceValue?: string;
} {
  if (by?.automated) {
    return { actor: { ...CONTROLLER_ACTOR }, trigger: "auto_sync", sourceValue: "automated" };
  }
  if (by?.username) {
    return {
      actor: { type: "user", login: by.username },
      trigger: "manual",
      sourceValue: "username",
    };
  }
  return { actor: { type: "unknown" }, trigger: "unknown" };
}

function userActor(login: string): JsonObject {
  return { type: "user", login };
}

/** Parent application in an app-of-apps setup, if the object says so. */
function parentAppOf(app: ArgoCdApplication): string | undefined {
  const tracking = app.metadata?.annotations?.["argocd.argoproj.io/tracking-id"];
  if (tracking) return tracking.split(":")[0];
  return app.metadata?.labels?.["app.kubernetes.io/instance"] ?? undefined;
}

class Builder {
  readonly events: CanonicalEventInputLike[] = [];
  #auditEvents: Promise<ArgoCdKubeEvent[] | undefined> | undefined;
  #raw: ReturnType<typeof jsonRawPayload> | undefined;

  constructor(
    readonly ctx: ObserveContext,
    readonly id: AppIdentity,
    readonly rawSource: () => unknown,
  ) {}

  /** K8s events of the app, fetched once, or undefined when unavailable. */
  auditEvents(): Promise<ArgoCdKubeEvent[] | undefined> {
    this.#auditEvents ??= this.ctx.appEvents
      ? this.ctx.appEvents().then(
          (e) => e,
          () => undefined,
        )
      : Promise.resolve(undefined);
    return this.#auditEvents;
  }

  async audit(verbs: AuditVerb[], opts: { near?: Date; notBefore?: Date; notAfter?: Date }) {
    const events = await this.auditEvents();
    if (!events) return { match: undefined as AuditMatch | undefined, available: false };
    return { match: findAuditEntry(events, { verbs, ...opts }), available: true };
  }

  emit(e: {
    key: (string | number)[];
    action: string;
    actor: JsonObject;
    trigger: { type: TriggerType; sourceValue?: string; detail?: string };
    outcome: Outcome;
    occurredAt: string;
    correlation: JsonObject;
    data: Record<string, unknown>;
  }): void {
    const before = new Date(e.occurredAt).getTime() < this.ctx.baselineAt.getTime();
    const method: ObservationMethod = before ? "backfill" : this.ctx.method;
    this.#raw ??= jsonRawPayload(this.rawSource());
    const baseDetail =
      method === "stream" && this.ctx.watchType
        ? `watch ${this.ctx.watchType}`
        : method === "backfill"
          ? "happened before capture started for this connection"
          : undefined;
    const detail =
      this.ctx.transport === "agent"
        ? `in-cluster agent${baseDetail ? `: ${baseDetail}` : method === "reconciliation" ? ": full snapshot" : ""}`
        : baseDetail;
    this.events.push({
      source: SOURCE,
      sourceEventId: sourceEventId(...e.key),
      connectionId: this.ctx.connectionId,
      action: e.action,
      actor: e.actor,
      target: targetOf(this.id),
      trigger: clean(e.trigger) as CanonicalEventInputLike["trigger"],
      outcome: e.outcome,
      occurredAt: e.occurredAt,
      observedAt: this.ctx.observedAt.toISOString(),
      observation: clean({
        method,
        jobId: this.ctx.jobId,
        detail,
      }) as CanonicalEventInputLike["observation"],
      correlation: e.correlation,
      data: clean({ appUid: this.id.uid, ...e.data }),
      rawPayload: this.#raw,
    } as CanonicalEventInputLike);
  }
}

// ---------------------------------------------------------------------------
// Operations (sync / rollback) and history
// ---------------------------------------------------------------------------

interface OpDescription {
  startedAt: string;
  finishedAt?: string;
  phase: string;
  finished: boolean;
  revisions: string[];
  ownHistory?: ArgoCdRevisionHistory;
  actor: JsonObject;
  trigger: { type: TriggerType; sourceValue?: string; detail?: string };
  data: Record<string, unknown>;
  rollback?: {
    toHistoryId?: string;
    revision?: string;
    confidence: Confidence;
    evidence: string[];
  };
}

function historyId(h: ArgoCdRevisionHistory): string | undefined {
  return h.id === undefined || h.id === null ? undefined : String(h.id);
}

const byId = (a: ArgoCdRevisionHistory, b: ArgoCdRevisionHistory) =>
  Number(a.id ?? 0) - Number(b.id ?? 0);

function historyRevisions(h: ArgoCdRevisionHistory): string[] {
  return h.revisions?.length ? [...h.revisions] : h.revision ? [h.revision] : [];
}

function sameRevisions(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** History entry produced by the given operation, if present. */
function ownHistoryOf(
  history: ArgoCdRevisionHistory[],
  os: ArgoCdOperationState,
  startedAt: string,
  targetRevs: string[],
): ArgoCdRevisionHistory | undefined {
  const exact = history.find((h) => iso(h.deployStartedAt) === startedAt);
  if (exact) return exact;
  // Older ArgoCD versions have no deployStartedAt: match revision and time.
  const resultRevs = os.syncResult?.revisions?.length
    ? os.syncResult.revisions
    : os.syncResult?.revision
      ? [os.syncResult.revision]
      : targetRevs;
  const started = new Date(startedAt).getTime();
  return history.find(
    (h) =>
      !h.deployStartedAt &&
      sameRevisions(historyRevisions(h), resultRevs) &&
      new Date(h.deployedAt ?? 0).getTime() >= started - 1000,
  );
}

async function describeOperation(
  b: Builder,
  app: ArgoCdApplication,
  os: ArgoCdOperationState,
  startedAt: string,
): Promise<OpDescription> {
  const op = os.operation ?? {};
  const sync = op.sync ?? {};
  const phase = os.phase ?? "Unknown";
  const finished = FINISHED_PHASES.has(phase);
  const history = [...(app.status?.history ?? [])].sort(byId);
  const targetRevs = sync.revisions?.length
    ? [...sync.revisions]
    : sync.revision
      ? [sync.revision]
      : [];
  const resultRevs = os.syncResult?.revisions?.length
    ? [...os.syncResult.revisions]
    : os.syncResult?.revision
      ? [os.syncResult.revision]
      : [];
  const revisions = resultRevs.length ? resultRevs : targetRevs;
  const own = ownHistoryOf(history, os, startedAt, targetRevs);
  const prior = history.filter(
    (h) => h !== own && new Date(h.deployedAt ?? 0).getTime() <= new Date(startedAt).getTime(),
  );
  const lastDeployed = prior.at(-1);
  const syncOptions = sync.syncOptions ?? [];
  const force =
    !!sync.syncStrategy?.apply?.force ||
    !!sync.syncStrategy?.hook?.force ||
    syncOptions.some((o) => /^Force=true$/i.test(o));
  const { actor, trigger, sourceValue } = actorOf(op.initiatedBy);
  const data: Record<string, unknown> = {
    phase,
    message: truncate(os.message),
    startedAt,
    finishedAt: iso(os.finishedAt),
    revision: revisions[0],
    revisions: revisions.length > 1 ? revisions : undefined,
    targetRevision: targetRevs[0],
    sources: sourcesOf(app).map((s, i) =>
      clean({
        repoURL: s.repoURL,
        path: s.path,
        chart: s.chart,
        revision: revisions[i] ?? s.targetRevision,
      }),
    ),
    prune: !!sync.prune,
    force,
    replace: syncOptions.some((o) => /^Replace=true$/i.test(o)),
    dryRun: sync.dryRun ? true : undefined,
    syncOptions: syncOptions.length ? syncOptions : undefined,
    selectiveSync: sync.resources?.length
      ? sync.resources.map(
          (r) => `${r.group ?? ""}/${r.kind ?? ""}/${r.namespace ?? ""}/${r.name ?? ""}`,
        )
      : undefined,
    retryCount: os.retryCount !== undefined ? Number(os.retryCount) : undefined,
    historyId: own ? historyId(own) : undefined,
    chart: app.spec?.source?.chart,
    chartVersion: app.spec?.source?.chart ? revisions[0] : undefined,
  };
  if (!op.initiatedBy) data.actorNote = "operation has no initiatedBy";

  let rollback: OpDescription["rollback"];
  let detail: string | undefined;
  if (op.initiatedBy?.automated) {
    const lastRevs = lastDeployed ? historyRevisions(lastDeployed) : [];
    const reason = !lastDeployed
      ? "first_sync"
      : sameRevisions(lastRevs, revisions)
        ? "self_heal_or_retry"
        : "git_change";
    data.autoSync = {
      reason,
      confidence: "medium",
      selfHeal: !!app.spec?.syncPolicy?.automated?.selfHeal,
    };
    detail = reason;
  } else {
    // ArgoCD records a rollback as a sync of an older history entry's revision
    // (and source). Evidence, strongest first: argocd-server's audit event
    // "initiated rollback to <id>", an operation info entry, the revision being
    // one deployed earlier but not the last one.
    const evidence: string[] = [];
    let toId: string | undefined;
    let confidence: Confidence | undefined;
    const infoHint = (op.info ?? []).some((i) =>
      /rollback/i.test(`${i.name ?? ""} ${i.value ?? ""}`),
    );
    if (infoHint) {
      evidence.push("operation.info mentions rollback");
      confidence = "high";
    }
    const earlier = prior
      .slice(0, -1)
      .reverse()
      .find((h) => sameRevisions(historyRevisions(h), targetRevs));
    const differsFromLast =
      !lastDeployed || !sameRevisions(historyRevisions(lastDeployed), targetRevs);
    if (earlier && differsFromLast) {
      evidence.push(
        `revision was deployed earlier as history id ${historyId(earlier)}, not the last deployed one`,
      );
      toId = historyId(earlier);
      confidence ??= "medium";
    }
    if (confidence || op.initiatedBy?.username) {
      const started = new Date(startedAt);
      const { match } = await b.audit(["rollback", "sync"], {
        near: started,
        notBefore: new Date(started.getTime() - ATTRIBUTION_WINDOW_MS),
        notAfter: new Date(started.getTime() + ATTRIBUTION_WINDOW_MS),
      });
      if (match?.entry.verb === "rollback") {
        evidence.unshift(`kubernetes event: "${truncate(match.entry.message, 200)}"`);
        toId = match.entry.rollbackToId ?? toId;
        confidence = "high";
      } else if (match?.entry.verb === "sync" && confidence === "medium") {
        // The user explicitly ran a sync (e.g. `argocd app sync --revision <old>`).
        evidence.push(
          `kubernetes event says sync, not rollback: "${truncate(match.entry.message, 200)}"`,
        );
        confidence = "low";
      }
    }
    if (confidence) {
      rollback = { toHistoryId: toId, revision: targetRevs[0], confidence, evidence };
    }
  }
  const finalTrigger = rollback && rollback.confidence !== "low" ? "rollback" : trigger;
  return {
    startedAt,
    finishedAt: iso(os.finishedAt),
    phase,
    finished,
    revisions,
    ownHistory: own,
    actor,
    trigger: clean({
      type: finalTrigger,
      sourceValue: finalTrigger === "rollback" ? "rollback" : sourceValue,
      detail,
    }) as OpDescription["trigger"],
    data: clean({ ...data, rollback: rollback ? clean(rollback) : undefined }),
    rollback,
  };
}

function finishedAction(
  phase: string,
  message: string | undefined,
): { action: string; outcome: Outcome } {
  if (phase === "Succeeded") return { action: ARGOCD_ACTIONS.SYNC_SUCCEEDED, outcome: "succeeded" };
  if (/terminat/i.test(message ?? ""))
    return { action: ARGOCD_ACTIONS.SYNC_TERMINATED, outcome: "cancelled" };
  return { action: ARGOCD_ACTIONS.SYNC_FAILED, outcome: "failed" };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Compares the current Application with what was last seen and returns the
 * events for every change. Call once per observed object version.
 */
export async function observeApplication(
  prev: AppCaptureState | null,
  app: ArgoCdApplication,
  ctx: ObserveContext,
): Promise<ObserveResult> {
  const uid = app.metadata?.uid;
  const name = app.metadata?.name;
  if (!uid || !name) throw new Error("application has no metadata.uid/name");
  const observedAt = ctx.observedAt.toISOString();
  const ns = appNs(app);
  const spec = summariseSpec(app);
  const id: AppIdentity = { uid, name, ns, spec };
  const minimised = minimiseApplication(app);
  const b = new Builder(ctx, id, () =>
    ctx.watchType ? { type: ctx.watchType, application: minimised } : { application: minimised },
  );
  const environment = (ctx.environmentOf ?? defaultEnvironmentOf)(app);
  const sources = sourcesOf(app);
  const images = app.status?.summary?.images ?? [];
  const history = [...(app.status?.history ?? [])].sort(byId);
  const latest = history.at(-1);
  const latestId = latest ? historyId(latest) : undefined;

  const specHash = hashJson(app.spec ?? {});
  const fieldHashes = specFieldHashes(app);
  const next: AppCaptureState = {
    uid,
    name,
    ...(ns ? { appNamespace: ns } : {}),
    firstSeenAt: prev?.firstSeenAt ?? observedAt,
    lastSeenAt: observedAt,
    ...(app.metadata?.resourceVersion ? { lastResourceVersion: app.metadata.resourceVersion } : {}),
    specHash,
    specFieldHashes: fieldHashes,
    spec,
    specChanges: prev?.specChanges ?? 0,
    historyIds: [],
  };
  const statusRevisions = app.status?.sync?.revisions?.length
    ? app.status.sync.revisions
    : app.status?.sync?.revision
      ? [app.status.sync.revision]
      : latest
        ? historyRevisions(latest)
        : [];
  const currentCorrelation = () =>
    correlationOf({
      revisions: statusRevisions,
      sources,
      images,
      environment,
      deploymentIds: latestId ? [deploymentId(ns, name, latestId)] : undefined,
    });

  // --- application created ------------------------------------------------
  if (!prev) {
    const createdAt = iso(app.metadata?.creationTimestamp) ?? observedAt;
    const afterBaseline = new Date(createdAt).getTime() >= ctx.baselineAt.getTime();
    const near = new Date(createdAt);
    const { match, available } = afterBaseline
      ? await b.audit(["created"], {
          near,
          notBefore: new Date(near.getTime() - ATTRIBUTION_WINDOW_MS),
          notAfter: new Date(near.getTime() + ATTRIBUTION_WINDOW_MS),
        })
      : { match: undefined, available: false };
    const parent = parentAppOf(app);
    let actor: JsonObject = { type: "unknown" };
    let trigger: { type: TriggerType; sourceValue?: string; detail?: string } = { type: "unknown" };
    let attribution: Record<string, unknown> = {
      confidence: "low",
      note: available ? "no matching kubernetes event" : "kubernetes events not available",
    };
    if (match?.entry.user) {
      actor = userActor(match.entry.user);
      trigger = { type: "manual", sourceValue: "argocd-api" };
      attribution = {
        source: "kubernetes_event",
        confidence: "high",
        message: truncate(match.entry.message, 200),
      };
    } else if (parent) {
      actor = { ...CONTROLLER_ACTOR };
      trigger = {
        type: "upstream",
        sourceValue: "app-of-apps",
        detail: `managed by application ${parent}`,
      };
      attribution = { source: "tracking_label", confidence: "medium", parentApplication: parent };
    }
    b.emit({
      key: ["application", uid, "created"],
      action: ARGOCD_ACTIONS.APPLICATION_CREATED,
      actor,
      trigger,
      outcome: "succeeded",
      occurredAt: createdAt,
      correlation: correlationOf({
        revisions: [spec.targetRevision],
        sources,
        environment,
        imageOverrides: imageOverridesOf(app).refs,
      }),
      data: { spec: spec as unknown as JsonObject, attribution: clean(attribution) },
    });
  }

  // --- spec changed -------------------------------------------------------
  if (prev && prev.specHash !== specHash) {
    const changed = [
      ...new Set([...Object.keys(prev.specFieldHashes), ...Object.keys(fieldHashes)]),
    ]
      .filter((k) => prev.specFieldHashes[k] !== fieldHashes[k])
      .sort();
    const summaryChanges: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(prev.spec), ...Object.keys(spec)]) as Set<
      keyof SpecSummary
    >;
    for (const k of keys) {
      const a = prev.spec[k];
      const c = spec[k];
      if (JSON.stringify(a) !== JSON.stringify(c)) summaryChanges[k] = clean({ from: a, to: c });
    }
    const notBefore = new Date(new Date(prev.lastSeenAt).getTime() - 5000);
    const { match, available } = await b.audit(["updated"], { notBefore });
    const parent = parentAppOf(app);
    let actor: JsonObject = { type: "unknown" };
    let trigger: { type: TriggerType; sourceValue?: string; detail?: string } = { type: "unknown" };
    let attribution: Record<string, unknown> = {
      confidence: "low",
      note: available
        ? "no matching kubernetes event (changed with kubectl, by GitOps or longer ago than event retention)"
        : "kubernetes events not available",
    };
    if (match?.entry.user) {
      actor = userActor(match.entry.user);
      trigger = { type: "manual", sourceValue: "argocd-api" };
      attribution = clean({
        source: "kubernetes_event",
        confidence: match.others.length ? "medium" : "high",
        message: truncate(match.entry.message, 200),
        otherCandidates: match.others.map((o) => o.user ?? "unknown").slice(0, 10),
      });
    } else if (parent) {
      actor = { ...CONTROLLER_ACTOR };
      trigger = {
        type: "upstream",
        sourceValue: "app-of-apps",
        detail: `managed by application ${parent}`,
      };
      attribution = { source: "tracking_label", confidence: "medium", parentApplication: parent };
    }
    const overrides = imageOverridesOf(app);
    const prevOverrides = prev.spec.imageOverrides ?? [];
    const changedOverrides = overrides.fields.filter((f) => !prevOverrides.includes(f));
    next.specChanges = prev.specChanges + 1;
    b.emit({
      key: ["application", uid, "updated", next.specChanges, specHash.slice(0, 12)],
      action: ARGOCD_ACTIONS.APPLICATION_UPDATED,
      actor,
      trigger,
      outcome: "succeeded",
      occurredAt: match?.entry.at.toISOString() ?? observedAt,
      correlation: correlationOf({
        revisions: [spec.targetRevision],
        sources,
        environment,
        imageOverrides: overrides.refs,
      }),
      data: {
        change: clean({
          fields: changed,
          summary: summaryChanges,
          imageOverrides: changedOverrides.length ? changedOverrides : undefined,
          removedImageOverrides: prevOverrides.filter((f) => !overrides.fields.includes(f)),
        }),
        occurredAtSource: match ? "kubernetes_event" : "observed",
        attribution: clean(attribution),
      },
    });
  }

  // --- refresh requested --------------------------------------------------
  const refresh = app.metadata?.annotations?.[REFRESH_ANNOTATION];
  if (refresh && prev?.refreshPending !== refresh) {
    const { match } = await b.audit(["refresh"], {
      near: ctx.observedAt,
      notBefore: new Date(ctx.observedAt.getTime() - ATTRIBUTION_WINDOW_MS),
    });
    b.emit({
      key: ["refresh", uid, app.metadata?.resourceVersion ?? observedAt],
      action: ARGOCD_ACTIONS.APPLICATION_REFRESHED,
      actor: match?.entry.user ? userActor(match.entry.user) : { type: "unknown" },
      trigger: match?.entry.user
        ? { type: "manual", sourceValue: "refresh" }
        : { type: "unknown", sourceValue: "refresh" },
      outcome: "none",
      occurredAt: match?.entry.at.toISOString() ?? observedAt,
      correlation: currentCorrelation(),
      data: {
        refreshType: refresh,
        confidence: "certain",
        note: "the refresh annotation is removed within seconds; refreshes that start and finish between two observations are not recorded",
        attribution: match?.entry.user
          ? {
              source: "kubernetes_event",
              confidence: "medium",
              message: truncate(match.entry.message, 200),
            }
          : {
              confidence: "low",
              note: "ArgoCD does not record who requested a refresh on the object",
            },
      },
    });
  }
  if (refresh) next.refreshPending = refresh;

  // --- operation (sync, rollback) -----------------------------------------
  const os = app.status?.operationState;
  const handledHistory = new Set<string>(prev?.historyIds ?? []);
  const startedAt = iso(os?.startedAt);
  if (os && startedAt) {
    const sameOp = prev?.operation?.startedAt === startedAt;
    const phase = os.phase ?? "Unknown";
    const finished = FINISHED_PHASES.has(phase);
    const needStart = !sameOp;
    const needFinish = finished && !(sameOp && prev?.operation?.finished);
    const ownHistory = ownHistoryOf(
      history,
      os,
      startedAt,
      os.operation?.sync?.revision ? [os.operation.sync.revision] : [],
    );
    if (ownHistory) handledHistory.add(historyId(ownHistory) ?? "");
    if (needStart || needFinish) {
      const d = await describeOperation(b, app, os, startedAt);
      const opSources = d.data.sources as unknown as { repoURL?: string }[];
      const corr = (withDeployment: boolean) =>
        correlationOf({
          revisions: d.revisions,
          sources: opSources,
          images,
          environment,
          deploymentIds:
            withDeployment && d.ownHistory && historyId(d.ownHistory)
              ? [deploymentId(ns, name, historyId(d.ownHistory)!)]
              : undefined,
        });
      if (needStart) {
        b.emit({
          key: ["sync", uid, startedAt, "started"],
          action: ARGOCD_ACTIONS.SYNC_STARTED,
          actor: d.actor,
          trigger: d.trigger,
          outcome: "in_progress",
          occurredAt: startedAt,
          correlation: corr(false),
          data: d.data,
        });
      }
      if (needFinish) {
        const { action, outcome } = finishedAction(phase, os.message);
        const extra: Record<string, unknown> = {};
        if (action === ARGOCD_ACTIONS.SYNC_TERMINATED) {
          const fin = new Date(d.finishedAt ?? observedAt);
          const { match } = await b.audit(["terminated"], {
            near: fin,
            notBefore: new Date(new Date(startedAt).getTime() - 1000),
          });
          if (match?.entry.user) extra.terminatedBy = match.entry.user;
        }
        b.emit({
          key: ["sync", uid, startedAt, "finished"],
          action,
          actor: d.actor,
          trigger: d.trigger,
          outcome,
          occurredAt: d.finishedAt ?? observedAt,
          correlation: corr(outcome === "succeeded"),
          data: { ...d.data, ...extra },
        });
        if (d.rollback && d.rollback.confidence !== "low") {
          b.emit({
            key: ["rollback", uid, startedAt],
            action: ARGOCD_ACTIONS.ROLLED_BACK,
            actor: d.actor,
            trigger: d.trigger,
            outcome,
            occurredAt: d.finishedAt ?? observedAt,
            correlation: corr(outcome === "succeeded"),
            data: clean({ ...d.rollback, startedAt, phase }),
          });
        }
      }
    }
    next.operation = { startedAt, phase, finished };
  } else if (prev?.operation) {
    next.operation = prev.operation;
  }

  // --- history entries not seen as operations (missed while disconnected) --
  for (const h of history) {
    const hid = historyId(h);
    if (!hid || handledHistory.has(hid)) continue;
    handledHistory.add(hid);
    const deployedAt = iso(h.deployedAt) ?? observedAt;
    const hStarted = iso(h.deployStartedAt);
    const revs = historyRevisions(h);
    const { actor, trigger, sourceValue } = actorOf(h.initiatedBy);
    const earlierEntries = history.filter((x) => Number(x.id ?? 0) < Number(h.id ?? 0));
    const previous = earlierEntries.at(-1);
    const rolledBackTo =
      !h.initiatedBy?.automated && previous && !sameRevisions(historyRevisions(previous), revs)
        ? earlierEntries
            .slice(0, -1)
            .reverse()
            .find((x) => sameRevisions(historyRevisions(x), revs))
        : undefined;
    const hSources = h.sources?.length ? h.sources : h.source ? [h.source] : sources;
    const corr = correlationOf({
      revisions: revs,
      sources: hSources,
      environment,
      deploymentIds: [deploymentId(ns, name, hid)],
      // Images are only known for what is live now.
      images: hid === latestId ? images : undefined,
    });
    const hTrigger = clean({
      type: rolledBackTo ? "rollback" : trigger,
      sourceValue: rolledBackTo ? "rollback" : sourceValue,
    }) as { type: TriggerType; sourceValue?: string };
    const data = {
      recoveredFrom: "status.history",
      historyId: hid,
      revision: revs[0],
      revisions: revs.length > 1 ? revs : undefined,
      startedAt: hStarted,
      finishedAt: deployedAt,
      sources: hSources.map((s, i) =>
        clean({ repoURL: s.repoURL, path: s.path, chart: s.chart, revision: revs[i] }),
      ),
      actorNote: h.initiatedBy
        ? undefined
        : "this ArgoCD version does not record initiatedBy in history",
      note: "history records successful syncs only; options (prune/force) are not recorded there",
      rollback: rolledBackTo
        ? {
            toHistoryId: historyId(rolledBackTo),
            confidence: "low",
            evidence: [
              "revision equals an earlier history entry and differs from the previous one",
            ],
          }
        : undefined,
    };
    if (hStarted) {
      b.emit({
        key: ["sync", uid, hStarted, "started"],
        action: ARGOCD_ACTIONS.SYNC_STARTED,
        actor,
        trigger: hTrigger,
        outcome: "in_progress",
        occurredAt: hStarted,
        correlation: clean({ ...corr, deploymentIds: undefined }),
        data,
      });
    }
    b.emit({
      key: hStarted ? ["sync", uid, hStarted, "finished"] : ["history", uid, hid],
      action: ARGOCD_ACTIONS.SYNC_SUCCEEDED,
      actor,
      trigger: hTrigger,
      outcome: "succeeded",
      occurredAt: deployedAt,
      correlation: corr,
      data,
    });
    if (rolledBackTo) {
      b.emit({
        key: hStarted ? ["rollback", uid, hStarted] : ["rollback", "history", uid, hid],
        action: ARGOCD_ACTIONS.ROLLED_BACK,
        actor,
        trigger: hTrigger,
        outcome: "succeeded",
        occurredAt: deployedAt,
        correlation: corr,
        data,
      });
    }
  }
  next.historyIds = history.map(historyId).filter((x): x is string => !!x);

  // --- status transitions (only after a first observation) ----------------
  const syncStatus = app.status?.sync?.status;
  const health = app.status?.health;
  const reconciledAt = iso(app.status?.reconciledAt);
  const transitionNote =
    ctx.method === "reconciliation"
      ? "found by reconciliation: intermediate transitions while Afe was not watching are not visible"
      : undefined;
  if (prev?.syncStatus && syncStatus && syncStatus !== prev.syncStatus) {
    b.emit({
      key: [
        "sync_status",
        uid,
        prev.syncStatus,
        syncStatus,
        reconciledAt ?? app.metadata?.resourceVersion ?? observedAt,
      ],
      action: ARGOCD_ACTIONS.SYNC_STATUS_CHANGED,
      actor: { ...CONTROLLER_ACTOR },
      trigger: { type: "system", sourceValue: "reconciliation" },
      outcome: "none",
      occurredAt: reconciledAt ?? observedAt,
      correlation: currentCorrelation(),
      data: {
        from: prev.syncStatus,
        to: syncStatus,
        revision: statusRevisions[0],
        note: transitionNote,
      },
    });
  }
  if (prev?.healthStatus && health?.status && health.status !== prev.healthStatus) {
    const at = iso(health.lastTransitionTime) ?? reconciledAt;
    b.emit({
      key: [
        "health",
        uid,
        prev.healthStatus,
        health.status,
        at ?? app.metadata?.resourceVersion ?? observedAt,
      ],
      action: ARGOCD_ACTIONS.HEALTH_CHANGED,
      actor: { ...CONTROLLER_ACTOR },
      trigger: { type: "system", sourceValue: "health_assessment" },
      outcome: "none",
      occurredAt: at ?? observedAt,
      correlation: currentCorrelation(),
      data: {
        from: prev.healthStatus,
        to: health.status,
        message: truncate(health.message, 500),
        syncRevision: statusRevisions[0],
        note: transitionNote,
      },
    });
  }
  if (syncStatus) next.syncStatus = syncStatus;
  else if (prev?.syncStatus) next.syncStatus = prev.syncStatus;
  if (statusRevisions[0]) next.syncRevision = statusRevisions[0];
  if (health?.status) next.healthStatus = health.status;
  else if (prev?.healthStatus) next.healthStatus = prev.healthStatus;
  if (images.length) next.images = [...images];

  // --- deletion requested (cascade deletion in progress) -------------------
  const deletionTs = iso(app.metadata?.deletionTimestamp);
  if (deletionTs) {
    next.deletionRequestedAt = prev?.deletionRequestedAt ?? deletionTs;
    if (!prev?.deletionRequestedAt) {
      const at = new Date(deletionTs);
      const { match } = await b.audit(["deleted"], {
        near: at,
        notBefore: new Date(at.getTime() - ATTRIBUTION_WINDOW_MS),
        notAfter: new Date(at.getTime() + ATTRIBUTION_WINDOW_MS),
      });
      if (match?.entry.user) next.deletionRequestedBy = match.entry.user;
      b.emit({
        key: ["application", uid, "deletion_requested"],
        action: ARGOCD_ACTIONS.APPLICATION_DELETED,
        actor: match?.entry.user ? userActor(match.entry.user) : { type: "unknown" },
        trigger: match?.entry.user
          ? { type: "manual", sourceValue: "argocd-api" }
          : { type: "unknown" },
        outcome: "in_progress",
        occurredAt: deletionTs,
        correlation: currentCorrelation(),
        data: {
          cascade: (app.metadata?.finalizers ?? []).some((f) => f.includes("resources-finalizer")),
          attribution: match?.entry.user
            ? {
                source: "kubernetes_event",
                confidence: "high",
                message: truncate(match.entry.message, 200),
              }
            : { confidence: "low" },
        },
      });
    }
  } else if (prev?.deletionRequestedBy) {
    next.deletionRequestedBy = prev.deletionRequestedBy;
  }

  const significant =
    !prev ||
    b.events.length > 0 ||
    prev.specHash !== next.specHash ||
    prev.syncStatus !== next.syncStatus ||
    prev.healthStatus !== next.healthStatus ||
    prev.refreshPending !== next.refreshPending ||
    JSON.stringify(prev.operation) !== JSON.stringify(next.operation) ||
    JSON.stringify(prev.historyIds) !== JSON.stringify(next.historyIds) ||
    JSON.stringify(prev.images) !== JSON.stringify(next.images) ||
    new Date(observedAt).getTime() - new Date(prev.lastSeenAt).getTime() > 60_000;
  return { events: b.events, next, significant };
}

export interface DeletionEvidence {
  /** The object from a DELETED watch event, if any. */
  app?: ArgoCdApplication;
  /** How the deletion was established, e.g. "watch DELETED" or "absent from list; GET returned 404". */
  evidence: string;
  confidence: Confidence;
}

/** Records that an application no longer exists. */
export function observeDeletion(
  prev: AppCaptureState | null,
  ctx: ObserveContext,
  ev: DeletionEvidence,
): ObserveResult {
  const app = ev.app;
  const uid = app?.metadata?.uid ?? prev?.uid;
  const name = app?.metadata?.name ?? prev?.name;
  if (!uid || !name) throw new Error("deletion without application uid/name");
  const observedAt = ctx.observedAt.toISOString();
  const spec = app ? summariseSpec(app) : (prev?.spec ?? {});
  const ns = app ? appNs(app) : prev?.appNamespace;
  const id: AppIdentity = { uid, name, ns, spec };
  const b = new Builder(ctx, id, () =>
    app
      ? { type: ctx.watchType ?? "DELETED", application: minimiseApplication(app) }
      : {
          absent: true,
          evidence: ev.evidence,
          lastKnown: {
            uid,
            name,
            namespace: ns ?? null,
            spec,
            lastSeenAt: prev?.lastSeenAt ?? null,
          },
        },
  );
  const next: AppCaptureState = prev
    ? { ...prev, lastSeenAt: observedAt, deletedAt: observedAt }
    : {
        uid,
        name,
        ...(ns ? { appNamespace: ns } : {}),
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        specHash: hashJson(app?.spec ?? {}),
        specFieldHashes: {},
        spec,
        specChanges: 0,
        historyIds: [],
        deletedAt: observedAt,
      };
  if (prev?.deletedAt) return { events: [], next: prev, significant: false };
  const by = prev?.deletionRequestedBy;
  b.emit({
    key: ["application", uid, "deleted"],
    action: ARGOCD_ACTIONS.APPLICATION_DELETED,
    actor: by ? userActor(by) : { type: "unknown" },
    trigger: by ? { type: "manual", sourceValue: "argocd-api" } : { type: "unknown" },
    outcome: "succeeded",
    occurredAt: observedAt,
    correlation: correlationOf({
      revisions: [prev?.syncRevision],
      sources: spec.repoURL ? [{ repoURL: spec.repoURL }] : [],
      images: prev?.images,
    }),
    data: {
      evidence: ev.evidence,
      confidence: ev.confidence,
      deletionRequestedAt: iso(app?.metadata?.deletionTimestamp) ?? prev?.deletionRequestedAt,
      lastSeenAt: prev?.lastSeenAt,
      occurredAtApproximate: ctx.method !== "stream" ? true : undefined,
      attribution: by
        ? { source: "kubernetes_event", confidence: "high", note: "actor of the deletion request" }
        : {
            confidence: "low",
            note: "ArgoCD keeps no record of who deleted an application once it is gone",
          },
    },
  });
  return { events: b.events, next, significant: true };
}
