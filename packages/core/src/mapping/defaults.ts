/**
 * Built-in rules (AFE-19): environment rules for the names tools commonly
 * use. No environment is seeded any more (D-0009, D-0024): environments come
 * from the inferred setup (`@afe/core/setup`) plus the admin's own. The
 * built-in rules target the ids `production`, `staging`, `preview` and
 * `development`, so they only apply where such an environment exists; they
 * are on by default only for tenants set up before inferred environments
 * (`MappingConfig.builtinDefaultEnabled`). Tenants can switch any built-in
 * rule on or off and override it with their own (tenant rules are always
 * evaluated first). No built-in rule assigns a service: services are the
 * tenant's to define, and an event without a service rule is shown as
 * unmapped. The name patterns below are also used by inference, only as a
 * "probable" hint for the production-like flag.
 */
import type { EnvironmentKind, MappingField, MappingRule } from "./types.ts";

/** Leading environment words: `production`, `Production – web`, `prod-eu`, `staging`, `pr-42`... */
export const NAME_PATTERNS: readonly (readonly [EnvironmentKind, string])[] = [
  ["production", "^(prod|production|prd|live)\\b"],
  ["staging", "^(stag|stage|staging|stg|uat|preprod|pre-prod)\\b"],
  ["preview", "^(preview|review|pr-\\d+)\\b"],
  ["development", "^(dev|develop|development|test|testing|qa|sandbox)\\b"],
];

/** Trailing environment suffixes of Kubernetes names: `web-prod`, `payments-staging`. */
export const SUFFIX_PATTERNS: readonly (readonly [EnvironmentKind, string])[] = [
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
for (const field of [
  "github.environment",
  "argocd.environment",
  "vercel.target",
  "terraform.environment",
] as const) {
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
