/**
 * Environment and service mapping model (AFE-19). Pure types, safe to import
 * from browser code through `@afe/core/types`. Reference:
 * docs/environment-mapping.md.
 */

export const ENVIRONMENT_KINDS = ["production", "staging", "preview", "development", "other"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/** A service: one row of the environment matrix ("the same thing across environments"). */
export interface Service {
  /** Slug, unique per tenant: `^[a-z0-9][a-z0-9_-]{0,63}$`. */
  id: string;
  name: string;
  description?: string | null;
}

/** An environment: one column of the environment matrix. */
export interface Environment {
  /** Slug, unique per tenant: `^[a-z0-9][a-z0-9_-]{0,63}$`. */
  id: string;
  name: string;
  /** Column position (ascending). */
  order: number;
  kind: EnvironmentKind;
}

export const RULE_KINDS = ["service", "environment"] as const;
/** Which dimension a rule assigns. */
export type RuleKind = (typeof RULE_KINDS)[number];

export const MATCH_TYPES = ["exact", "glob", "regex"] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

/**
 * Raw observation fields a rule can match, as `<source>.<field>`. ArgoCD
 * labels are `argocd.label:<key>` (any label key). See `observationsOf`.
 */
export const MAPPING_FIELDS = [
  "github.environment",
  "github.repository",
  "argocd.application",
  "argocd.project",
  "argocd.namespace",
  "argocd.cluster",
  "argocd.environment",
  "argocd.repository",
  "vercel.project",
  "vercel.target",
  "vercel.repository",
] as const;
export type KnownMappingField = (typeof MAPPING_FIELDS)[number];
export const LABEL_FIELD_PREFIX = "argocd.label:";
/** A known field, or `argocd.label:<key>`. */
export type MappingField = KnownMappingField | `argocd.label:${string}`;

export interface MappingRule {
  /** uuid for tenant rules, `builtin:<name>` for built-in defaults. */
  id: string;
  kind: RuleKind;
  field: MappingField;
  match: MatchType;
  pattern: string;
  /** Default false: names differ in case across tools (`Production` vs `production`). */
  caseSensitive: boolean;
  /** Evaluation order within its kind, ascending; the first matching rule wins. */
  priority: number;
  /** Service id (kind service) or environment id (kind environment). */
  targetId: string;
  enabled: boolean;
  note?: string | null;
  /** True for the built-in defaults (evaluated after every tenant rule). */
  builtIn?: boolean;
}

/** Everything the resolver needs for one tenant. */
export interface MappingConfig {
  services: Service[];
  environments: Environment[];
  /** Tenant rules (any order; sorted by priority when compiled). */
  rules: MappingRule[];
  /** Built-in rule id → enabled. Missing ids are enabled. */
  builtinOverrides?: Record<string, boolean>;
}

/**
 * How certain the placement is:
 * - `configured`: service and environment both assigned by the tenant's rules;
 * - `default`: both assigned, at least one only by a built-in default rule;
 * - `partial`: one of the two is unmapped;
 * - `unmapped`: neither is mapped. Unmapped is shown as such, never guessed.
 */
export type PlacementConfidence = "configured" | "default" | "partial" | "unmapped";

export interface DimensionMatch {
  ruleId: string;
  builtIn: boolean;
  field: string;
  value: string;
}

export interface PlacementResolution {
  serviceId: string | null;
  environmentId: string | null;
  /** The rules that decided: the service rule first, then the environment rule. */
  matchedRuleIds: string[];
  confidence: PlacementConfidence;
  service: DimensionMatch | null;
  environment: DimensionMatch | null;
}

/** Raw observed values per field, e.g. `{"vercel.target": ["production"]}`. */
export type Observations = Partial<Record<string, string[]>>;
