/**
 * Read-time resolution of an event to a service and an environment (AFE-19).
 *
 * The result is never stored in the event: mapping configuration can change
 * at any time and the audit log is immutable, so every reader resolves with
 * the tenant's current (or a proposed) configuration. Rules are compiled once
 * per configuration and results are cached per distinct set of raw values,
 * so resolving thousands of events costs a few map lookups each.
 *
 * Precedence, per dimension: enabled tenant rules by ascending priority
 * (ties: id), then enabled built-in rules in their fixed order; the first
 * rule whose field has a matching value wins. A rule whose target service or
 * environment does not exist is inactive. No match → `null` (unmapped).
 */
import { BUILTIN_RULES } from "./defaults.ts";
import { observationKey, observationsOf, type MappableEvent } from "./fields.ts";
import { compileGlob } from "./glob.ts";
import { compileSafeRegex } from "./safe-regex.ts";
import type {
  DimensionMatch,
  MappingConfig,
  MappingRule,
  Observations,
  PlacementConfidence,
  PlacementResolution,
  RuleKind,
} from "./types.ts";

export type ValueMatcher = (value: string) => boolean;

/** Compiles one rule's pattern; throws `SafeRegexError` / `GlobError` for an invalid pattern. */
export function compileMatcher(
  rule: Pick<MappingRule, "match" | "pattern" | "caseSensitive">,
): ValueMatcher {
  const ignoreCase = !rule.caseSensitive;
  switch (rule.match) {
    case "exact": {
      const p = ignoreCase ? rule.pattern.toLowerCase() : rule.pattern;
      return ignoreCase ? (v) => v.toLowerCase() === p : (v) => v === p;
    }
    case "glob": {
      const g = compileGlob(rule.pattern, { ignoreCase });
      return (v) => g.test(v);
    }
    case "regex": {
      const r = compileSafeRegex(rule.pattern, { ignoreCase });
      return (v) => r.test(v);
    }
  }
}

interface CompiledRule {
  rule: MappingRule;
  test: ValueMatcher;
}

export interface InactiveRule {
  ruleId: string;
  reason: string;
}

export interface CompiledMapping {
  readonly config: MappingConfig;
  /** Effective rules per kind, in evaluation order (tenant rules, then built-ins). */
  readonly order: Record<RuleKind, readonly MappingRule[]>;
  /** Rules that never apply (disabled, missing target, invalid pattern). */
  readonly inactive: readonly InactiveRule[];
  /** True when some active rule reads ArgoCD labels (the caller must supply them). */
  readonly usesLabels: boolean;
  /** The first active rule of `kind` matching `value` in `field`, if any. */
  firstMatch(kind: RuleKind, field: string, value: string): MappingRule | undefined;
  /** Resolution for a set of observations (cached). */
  resolveObservations(source: string, o: Observations): PlacementResolution;
}

const CACHE_LIMIT = 10_000;

function byPriority(a: MappingRule, b: MappingRule): number {
  return a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function compileMapping(config: MappingConfig): CompiledMapping {
  const serviceIds = new Set(config.services.map((s) => s.id));
  const environmentIds = new Set(config.environments.map((e) => e.id));
  const overrides = config.builtinOverrides ?? {};
  const inactive: InactiveRule[] = [];
  const compiled: Record<RuleKind, CompiledRule[]> = { service: [], environment: [] };

  const tenantRules = config.rules.filter((r) => !r.builtIn).sort(byPriority);
  const builtins = BUILTIN_RULES.map((r) => ({ ...r, enabled: overrides[r.id] ?? r.enabled }));
  for (const rule of [...tenantRules, ...builtins]) {
    if (!rule.enabled) {
      inactive.push({ ruleId: rule.id, reason: "disabled" });
      continue;
    }
    const targets = rule.kind === "service" ? serviceIds : environmentIds;
    if (!targets.has(rule.targetId)) {
      inactive.push({ ruleId: rule.id, reason: `${rule.kind} ${rule.targetId} does not exist` });
      continue;
    }
    try {
      compiled[rule.kind].push({ rule, test: compileMatcher(rule) });
    } catch (err) {
      inactive.push({ ruleId: rule.id, reason: `invalid pattern: ${(err as Error).message}` });
    }
  }

  const byField: Record<RuleKind, Map<string, CompiledRule[]>> = {
    service: new Map(),
    environment: new Map(),
  };
  for (const kind of ["service", "environment"] as const) {
    for (const c of compiled[kind]) {
      const list = byField[kind].get(c.rule.field);
      if (list) list.push(c);
      else byField[kind].set(c.rule.field, [c]);
    }
  }
  const usesLabels = [...compiled.service, ...compiled.environment].some((c) =>
    c.rule.field.startsWith("argocd.label:"),
  );

  const decide = (kind: RuleKind, o: Observations): DimensionMatch | null => {
    for (const { rule, test } of compiled[kind]) {
      const values = o[rule.field];
      if (!values) continue;
      for (const value of values) {
        if (test(value)) {
          return { ruleId: rule.id, builtIn: rule.builtIn === true, field: rule.field, value };
        }
      }
    }
    return null;
  };

  const cache = new Map<string, PlacementResolution>();

  return {
    config,
    order: {
      service: compiled.service.map((c) => c.rule),
      environment: compiled.environment.map((c) => c.rule),
    },
    inactive,
    usesLabels,
    firstMatch(kind, field, value) {
      return byField[kind].get(field)?.find((c) => c.test(value))?.rule;
    },
    resolveObservations(source, o) {
      const key = observationKey(source, o);
      const hit = cache.get(key);
      if (hit) return clone(hit);
      const service = decide("service", o);
      const environment = decide("environment", o);
      const result: PlacementResolution = {
        serviceId: service ? ruleTarget(compiled.service, service.ruleId) : null,
        environmentId: environment ? ruleTarget(compiled.environment, environment.ruleId) : null,
        matchedRuleIds: [service?.ruleId, environment?.ruleId].filter((x): x is string => !!x),
        confidence: confidenceOf(service, environment),
        service,
        environment,
      };
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(key, result);
      return clone(result);
    },
  };
}

function ruleTarget(list: CompiledRule[], ruleId: string): string {
  return list.find((c) => c.rule.id === ruleId)!.rule.targetId;
}

function clone(r: PlacementResolution): PlacementResolution {
  return {
    ...r,
    matchedRuleIds: [...r.matchedRuleIds],
    service: r.service ? { ...r.service } : null,
    environment: r.environment ? { ...r.environment } : null,
  };
}

function confidenceOf(
  service: DimensionMatch | null,
  environment: DimensionMatch | null,
): PlacementConfidence {
  if (!service && !environment) return "unmapped";
  if (!service || !environment) return "partial";
  return service.builtIn || environment.builtIn ? "default" : "configured";
}

/**
 * Resolves where an event belongs: `{serviceId, environmentId,
 * matchedRuleIds, confidence}`. Pass a `CompiledMapping` (from
 * `compileMapping`) when resolving many events; a plain config is compiled on
 * each call.
 */
export function resolvePlacement(
  event: MappableEvent,
  rules: CompiledMapping | MappingConfig,
): PlacementResolution {
  const mapping = "resolveObservations" in rules ? rules : compileMapping(rules);
  return mapping.resolveObservations(event.source, observationsOf(event));
}
