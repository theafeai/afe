/**
 * Built-in defaults (AFE-19): four environments and environment rules for
 * the names tools commonly use. Tenants can disable any built-in rule and
 * override it with their own (tenant rules are always evaluated first). No
 * built-in rule assigns a service: services are the tenant's to define, and
 * an event without a service rule is shown as unmapped.
 */
import type { Environment, MappingField, MappingRule } from "./types.ts";

export const DEFAULT_ENVIRONMENTS: readonly Environment[] = [
  { id: "production", name: "Production", order: 10, kind: "production" },
  { id: "staging", name: "Staging", order: 20, kind: "staging" },
  { id: "preview", name: "Preview", order: 30, kind: "preview" },
  { id: "development", name: "Development", order: 40, kind: "development" },
];

/** Leading environment words: `production`, `Production – web`, `prod-eu`, `staging`, `pr-42`... */
const NAME_PATTERNS: [string, string][] = [
  ["production", "^(prod|production|prd|live)\\b"],
  ["staging", "^(stag|stage|staging|stg|uat|preprod|pre-prod)\\b"],
  ["preview", "^(preview|review|pr-\\d+)\\b"],
  ["development", "^(dev|develop|development|test|testing|qa|sandbox)\\b"],
];

/** Trailing environment suffixes of Kubernetes names: `web-prod`, `payments-staging`. */
const SUFFIX_PATTERNS: [string, string][] = [
  ["production", "(^|[-_.])(prod|production|prd)$"],
  ["staging", "(^|[-_.])(stag|stage|staging|stg|uat)$"],
  ["development", "(^|[-_.])(dev|development|test|qa)$"],
];

function builtIn(
  name: string,
  field: MappingField,
  match: MappingRule["match"],
  pattern: string,
  targetId: string,
  note: string,
): Omit<MappingRule, "priority"> {
  return {
    id: `builtin:${name}`,
    kind: "environment",
    field,
    match,
    pattern,
    caseSensitive: false,
    targetId,
    enabled: true,
    note,
    builtIn: true,
  };
}

const rules: Omit<MappingRule, "priority">[] = [
  builtIn(
    "vercel-target-production",
    "vercel.target",
    "exact",
    "production",
    "production",
    "Vercel production target",
  ),
  builtIn(
    "vercel-target-preview",
    "vercel.target",
    "exact",
    "preview",
    "preview",
    "Vercel preview target",
  ),
];
for (const field of ["github.environment", "argocd.environment", "vercel.target"] as const) {
  const source = field.split(".")[0];
  for (const [env, pattern] of NAME_PATTERNS) {
    rules.push(
      builtIn(`${source}-environment-${env}`, field, "regex", pattern, env, `${env} by name`),
    );
  }
}
for (const field of ["argocd.namespace", "argocd.application"] as const) {
  const what = field.split(".")[1];
  for (const [env, pattern] of SUFFIX_PATTERNS) {
    rules.push(
      builtIn(`argocd-${what}-${env}`, field, "regex", pattern, env, `${what} suffix ${env}`),
    );
  }
}

/** Built-in rules in evaluation order (after all tenant rules). */
export const BUILTIN_RULES: readonly MappingRule[] = rules.map((r, i) => ({
  ...r,
  priority: (i + 1) * 10,
}));

export function isBuiltinRuleId(id: string): boolean {
  return BUILTIN_RULES.some((r) => r.id === id);
}
