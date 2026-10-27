/**
 * Data minimisation for ArgoCD Application objects (docs/security/rules.md R8,
 * docs/security/data-inventory.md). Afe keeps the parts of an Application it
 * needs to show what happened (identity, source/destination, sync policy, status,
 * operation state, history) and drops everything that can carry configuration
 * values or secrets: Helm values/parameters, Kustomize/plugin/directory
 * settings, resource lists, managed fields and all other annotations.
 */
import type {
  ArgoCdApplication,
  ArgoCdApplicationSource,
  ArgoCdOperation,
  ArgoCdRevisionHistory,
} from "../types.ts";

/** Annotation ArgoCD sets to request a refresh (`normal` or `hard`). */
export const REFRESH_ANNOTATION = "argocd.argoproj.io/refresh";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function pick(obj: unknown, keys: readonly string[]): Record<string, Json> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const out: Record<string, Json> = {};
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
  }
  return out;
}

const SOURCE_KEYS = ["repoURL", "path", "targetRevision", "chart", "ref", "name"] as const;

/** Source without tool settings; `helm.releaseName`/`valueFiles` names are kept (file names, not values). */
export function minimiseSource(src: ArgoCdApplicationSource | undefined): Json | undefined {
  if (!src || typeof src !== "object") return undefined;
  const out: Record<string, Json> = pick(src, SOURCE_KEYS) ?? {};
  const tools = ["helm", "kustomize", "directory", "plugin"].filter((k) => src[k] != null);
  if (tools.length) out.tools = tools;
  return out;
}

function minimiseSources(list: ArgoCdApplicationSource[] | undefined): Json | undefined {
  return Array.isArray(list) ? list.map((s) => minimiseSource(s) ?? {}) : undefined;
}

export function minimiseOperation(op: ArgoCdOperation | undefined): Json | undefined {
  if (!op || typeof op !== "object") return undefined;
  const out: Record<string, Json> = {};
  if (op.sync) {
    const sync: Record<string, Json> =
      pick(op.sync, ["revision", "revisions", "prune", "dryRun"]) ?? {};
    if (Array.isArray(op.sync.syncOptions)) sync.syncOptions = op.sync.syncOptions.map(String);
    const strategy: Record<string, Json> = {};
    if (op.sync.syncStrategy?.apply) strategy.apply = { force: !!op.sync.syncStrategy.apply.force };
    if (op.sync.syncStrategy?.hook) strategy.hook = { force: !!op.sync.syncStrategy.hook.force };
    if (Object.keys(strategy).length) sync.syncStrategy = strategy;
    if (Array.isArray(op.sync.resources)) {
      sync.resources = op.sync.resources.map(
        (r) => pick(r, ["group", "kind", "name", "namespace"]) ?? {},
      );
    }
    const source = minimiseSource(op.sync.source);
    if (source) sync.source = source;
    const sources = minimiseSources(op.sync.sources);
    if (sources) sync.sources = sources;
    out.sync = sync;
  }
  if (op.initiatedBy) out.initiatedBy = pick(op.initiatedBy, ["username", "automated"]) ?? {};
  if (Array.isArray(op.info)) out.info = op.info.map((i) => pick(i, ["name", "value"]) ?? {});
  return out;
}

function minimiseHistory(h: ArgoCdRevisionHistory): Json {
  const out: Record<string, Json> =
    pick(h, ["id", "revision", "revisions", "deployedAt", "deployStartedAt"]) ?? {};
  const source = minimiseSource(h.source);
  if (source) out.source = source;
  const sources = minimiseSources(h.sources);
  if (sources) out.sources = sources;
  if (h.initiatedBy) out.initiatedBy = pick(h.initiatedBy, ["username", "automated"]) ?? {};
  return out;
}

/**
 * The subset of an Application that Afe stores as the raw payload. Deterministic
 * (same input, same output) so payloads hash stably.
 */
export function minimiseApplication(app: ArgoCdApplication): Record<string, Json> {
  const m = app.metadata ?? {};
  const metadata: Record<string, Json> =
    pick(m, [
      "name",
      "namespace",
      "uid",
      "resourceVersion",
      "generation",
      "creationTimestamp",
      "deletionTimestamp",
    ]) ?? {};
  if (m.labels && typeof m.labels === "object") metadata.labels = { ...m.labels };
  const refresh = m.annotations?.[REFRESH_ANNOTATION];
  if (refresh) metadata.annotations = { [REFRESH_ANNOTATION]: refresh };
  if (Array.isArray(m.finalizers)) metadata.finalizers = m.finalizers.map(String);

  const out: Record<string, Json> = { metadata };
  const spec = app.spec;
  if (spec) {
    const s: Record<string, Json> = {};
    if (spec.project) s.project = spec.project;
    const source = minimiseSource(spec.source);
    if (source) s.source = source;
    const sources = minimiseSources(spec.sources);
    if (sources) s.sources = sources;
    const dest = pick(spec.destination, ["server", "namespace", "name"]);
    if (dest) s.destination = dest;
    if (spec.syncPolicy) {
      const sp: Record<string, Json> = {};
      const auto = spec.syncPolicy.automated;
      if (auto) sp.automated = pick(auto, ["prune", "selfHeal", "allowEmpty"]) ?? {};
      if (Array.isArray(spec.syncPolicy.syncOptions))
        sp.syncOptions = spec.syncPolicy.syncOptions.map(String);
      s.syncPolicy = sp;
    }
    out.spec = s;
  }
  const st = app.status;
  if (st) {
    const s: Record<string, Json> = {};
    const sync = pick(st.sync, ["status", "revision", "revisions"]);
    if (sync) s.sync = sync;
    const health = pick(st.health, ["status", "lastTransitionTime"]);
    if (health) s.health = health;
    if (Array.isArray(st.history)) s.history = st.history.map(minimiseHistory);
    const os = st.operationState;
    if (os) {
      const o: Record<string, Json> =
        pick(os, ["phase", "message", "startedAt", "finishedAt", "retryCount"]) ?? {};
      const op = minimiseOperation(os.operation);
      if (op) o.operation = op;
      if (os.syncResult) {
        const r: Record<string, Json> = pick(os.syncResult, ["revision", "revisions"]) ?? {};
        const source = minimiseSource(os.syncResult.source);
        if (source) r.source = source;
        if (Array.isArray(os.syncResult.resources))
          r.resourceCount = os.syncResult.resources.length;
        o.syncResult = r;
      }
      s.operationState = o;
    }
    if (st.reconciledAt) s.reconciledAt = st.reconciledAt;
    if (st.sourceType) s.sourceType = st.sourceType;
    if (Array.isArray(st.summary?.images)) s.summary = { images: st.summary.images.map(String) };
    out.status = s;
  }
  const pending = minimiseOperation(app.operation);
  if (pending) out.operation = pending;
  return out;
}
