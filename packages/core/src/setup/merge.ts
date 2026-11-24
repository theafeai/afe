/**
 * Effective setup: admin overrides win, then the environments the admin
 * created (Mapping page), then inference. Pure. Inference is only ever
 * reported against an admin value ("Afe noticed"), never applied over it.
 */
import type { Environment, EnvironmentKind, MappingRule } from "../mapping/types.ts";
import {
  subjectEnvironmentId,
  type AdminEnvironment,
  type EffectiveEnvironment,
  type EnvironmentSource,
  type InferredFactRecord,
  type InferredValue,
  type OverrideField,
  type SetupConfidence,
  type SetupNotice,
  type SetupOverrideRecord,
  type SetupValue,
} from "./types.ts";

export interface SetupInputs {
  adminEnvironments: readonly AdminEnvironment[];
  inferred: readonly InferredFactRecord[];
  overrides: readonly SetupOverrideRecord[];
}

export interface MergedSetup {
  /** Every environment, in effective order (excluded ones included, flagged). */
  environments: EffectiveEnvironment[];
  noticed: SetupNotice[];
  /** Environments for the mapping resolver (included ones only). */
  mappingEnvironments: Environment[];
  /** Rules that place events in environments by the names tools report. */
  inferredRules: MappingRule[];
  /** Latest inference run, if any. */
  computedAt: string | null;
}

/** Inference this weak is shown, but never reported as a disagreement. */
const NOTICE_CONFIDENCE: readonly SetupConfidence[] = ["certain", "strong", "probable"];
/** Fields compared with inference for "Afe noticed". Order is relative and is not compared yet. */
const NOTICE_FIELDS: readonly OverrideField[] = ["productionLike", "gating", "batching"];
/** Inferred environments without an order go after the known ones. */
const UNORDERED = 1_000_000;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The legacy `kind` of an inferred environment, kept in the API for
 * compatibility only (AFE-117). It is never derived from the name: an org's
 * `uat` is not Afe's "staging" (D-0009, D-0010). Production-like environments
 * are `production`, a short-lived family is `preview` (it is one by
 * construction), every other environment is `other`. The UI shows no kind;
 * it shows the production-like flag.
 */
function legacyKind(productionLike: boolean, family: boolean): EnvironmentKind {
  if (productionLike) return "production";
  if (family) return "preview";
  return "other";
}

export function mergeSetup(inputs: SetupInputs): MergedSetup {
  const inferredBy = new Map<string, Map<string, InferredFactRecord>>();
  let computedAt: string | null = null;
  for (const f of inputs.inferred) {
    const id = subjectEnvironmentId(f.subject);
    if (!id) continue;
    let m = inferredBy.get(id);
    if (!m) inferredBy.set(id, (m = new Map()));
    m.set(f.field, f);
    if (!computedAt || f.computedAt > computedAt) computedAt = f.computedAt;
  }
  const overridesBy = new Map<string, Map<string, SetupOverrideRecord>>();
  for (const o of inputs.overrides) {
    const id = subjectEnvironmentId(o.subject);
    if (!id) continue;
    let m = overridesBy.get(id);
    if (!m) overridesBy.set(id, (m = new Map()));
    m.set(o.field, o);
  }
  const admins = new Map(inputs.adminEnvironments.map((e) => [e.id, e]));
  const ids = [...new Set([...admins.keys(), ...inferredBy.keys()])];

  const environments: EffectiveEnvironment[] = [];
  const noticed: SetupNotice[] = [];
  // "The admin has looked at the setup since": an admin environment or an override exists.
  const adjustedSince = [
    ...inputs.adminEnvironments.map((e) => e.createdAt),
    ...inputs.overrides.map((o) => o.setAt),
  ].sort()[0];

  for (const id of ids) {
    const admin = admins.get(id);
    const inf = inferredBy.get(id) ?? new Map<string, InferredFactRecord>();
    const ovr = overridesBy.get(id) ?? new Map<string, SetupOverrideRecord>();
    const guess = <T>(field: string): InferredValue<T> | null => {
      const f = inf.get(field);
      return f
        ? { value: f.value as T, confidence: f.confidence, reason: f.reason, evidence: f.evidence }
        : null;
    };
    const fromOverride = <T>(field: OverrideField): SetupValue<T> | null => {
      const o = ovr.get(field);
      return o
        ? {
            value: o.value as T,
            origin: "admin",
            via: "override",
            setBy: o.setBy,
            setAt: o.setAt,
            inferred: guess<T>(field),
          }
        : null;
    };
    const fromInferred = <T>(field: string, fallback: T): SetupValue<T> => {
      const g = guess<T>(field);
      return g
        ? {
            value: g.value,
            origin: "inferred",
            confidence: g.confidence,
            reason: g.reason,
            evidence: g.evidence,
            inferred: g,
          }
        : { value: fallback, origin: "none", inferred: null };
    };
    const fromMapping = <T>(field: string, value: T): SetupValue<T> => ({
      value,
      origin: "admin",
      via: "mapping",
      setBy: null,
      setAt: admin!.updatedAt,
      inferred: guess<T>(field),
    });

    const sources = (guess<EnvironmentSource[]>("sources")?.value ?? []).slice();
    const family = sources.some((s) => s.match === "regex");
    const name =
      fromOverride<string>("name") ??
      (admin ? fromMapping("name", admin.name) : fromInferred<string>("name", id));
    const order =
      fromOverride<number>("order") ??
      (admin ? fromMapping("order", admin.order) : fromInferred<number>("order", UNORDERED));
    // An admin row's kind is the admin's statement about production (D-0012):
    // `production` means production-like; another kind means not.
    const productionLike =
      fromOverride<boolean>("productionLike") ??
      (admin
        ? fromMapping("productionLike", admin.kind === "production")
        : fromInferred<boolean>("productionLike", false));
    // Admin environments are always included (they are deleted on the Mapping page).
    const included: SetupValue<boolean> = admin
      ? fromMapping("included", true)
      : (fromOverride<boolean>("included") ?? { value: true, origin: "none", inferred: null });
    const env: EffectiveEnvironment = {
      id,
      origin: admin ? "admin" : "inferred",
      included,
      family,
      name,
      order,
      productionLike,
      gating: fromOverride("gating") ?? fromInferred("gating", null),
      batching: fromOverride("batching") ?? fromInferred("batching", null),
      cadence: fromInferred("cadence", null),
      kind: admin ? admin.kind : legacyKind(productionLike.value, family),
      sources,
      firstInferredAt:
        inf.size > 0 ? [...inf.values()].map((f) => f.firstInferredAt).sort()[0]! : null,
    };
    environments.push(env);

    // Afe noticed: inference that disagrees with an admin value.
    for (const field of NOTICE_FIELDS) {
      const current = env[field as "productionLike" | "gating" | "batching"] as SetupValue<unknown>;
      const g = current.inferred;
      if (current.origin !== "admin" || !g || !NOTICE_CONFIDENCE.includes(g.confidence)) continue;
      if (same(g.value, current.value)) continue;
      if (same(ovr.get(field)?.keptInferred, g.value)) continue;
      noticed.push({
        id: `disagreement:${id}:${field}`,
        kind: "disagreement",
        environment: id,
        field,
        current,
        inferred: g,
        actions: ["keep", "use_inferred"],
      });
    }
    // Afe noticed: an environment that appeared after the admin adjusted the setup.
    if (
      !admin &&
      !ovr.has("included") &&
      adjustedSince &&
      env.firstInferredAt &&
      env.firstInferredAt > adjustedSince
    ) {
      noticed.push({
        id: `new_environment:${id}`,
        kind: "new_environment",
        environment: id,
        inferred: {
          value: name.value,
          confidence: name.confidence ?? "weak",
          reason: name.reason ?? "New environment",
          evidence: name.evidence ?? [],
        },
        actions: ["add", "not_environment"],
      });
    }
  }

  environments.sort(
    (a, b) =>
      a.order.value - b.order.value ||
      a.name.value.localeCompare(b.name.value) ||
      (a.id < b.id ? -1 : 1),
  );

  const included = environments.filter((e) => e.included.value !== false);
  const mappingEnvironments: Environment[] = included.map((e) => ({
    id: e.id,
    name: e.name.value,
    order: e.order.value,
    kind: e.kind,
    productionLike: e.productionLike.value,
  }));
  const inferredRules: MappingRule[] = [];
  for (const e of included) {
    for (const [i, s] of e.sources.entries()) {
      inferredRules.push({
        id: `inferred:${e.id}:${i + 1}`,
        kind: "environment",
        field: s.field as MappingRule["field"],
        match: s.match,
        pattern: s.pattern,
        caseSensitive: false,
        priority: inferredRules.length + 1,
        targetId: e.id,
        enabled: true,
        note: "Inferred from the names tools report",
        builtIn: true,
      });
    }
  }
  return { environments, noticed, mappingEnvironments, inferredRules, computedAt };
}
