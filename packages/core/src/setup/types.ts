/**
 * Inferred setup and admin overrides (ADR 0019).
 * Pure types, safe to import from browser code through `@afe/core/types`.
 * Reference: docs/environment-mapping.md "Inferred setup".
 *
 * Two stores, never mixed:
 * - inferred facts (table `inferred_setup`), written only by the inference job;
 * - admin overrides (table `setup_overrides`), written only by admin API calls.
 * Effective value = override ?? admin environment row ?? inferred ?? none.
 */
import type { EnvironmentKind, MatchType } from "../mapping/types.ts";

/** How sure Afe is, strongest first. */
export const SETUP_CONFIDENCES = ["certain", "strong", "probable", "weak"] as const;
export type SetupConfidence = (typeof SETUP_CONFIDENCES)[number];

/** How changes reach an environment (the Adjust screen's "How changes get here"). */
export const GATING_VALUES = ["automatic", "approval", "on_demand", "per_change"] as const;
export type Gating = (typeof GATING_VALUES)[number];

/** Whether each change ships on its own or several ship together. */
export const BATCHING_VALUES = ["each_change", "batches"] as const;
export type Batching = (typeof BATCHING_VALUES)[number];

/** Fields the inference job writes. */
export const INFERRED_FIELDS = [
  "name",
  "order",
  "productionLike",
  "gating",
  "batching",
  "cadence",
  "sources",
] as const;
export type InferredField = (typeof INFERRED_FIELDS)[number];

/** Fields an admin can override. `included: false` means "not an environment". */
export const OVERRIDE_FIELDS = [
  "name",
  "order",
  "productionLike",
  "gating",
  "batching",
  "included",
] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

/** A raw tool value that places events in an environment (an inferred mapping rule). */
export interface EnvironmentSource {
  field: string;
  match: Extract<MatchType, "exact" | "regex">;
  pattern: string;
}

export interface Cadence {
  /** Median time between deployments. */
  medianSeconds: number;
  /** 90th percentile time between deployments. */
  p90Seconds: number;
  deployments: number;
}

export interface FieldValues {
  name: string;
  order: number;
  productionLike: boolean;
  gating: Gating;
  batching: Batching;
  cadence: Cadence;
  sources: EnvironmentSource[];
  included: boolean;
}

/**
 * One reason for an inference. Holds tool names, environment names, counts
 * and rule names only: no repository names, logins or commit messages.
 */
export interface SetupEvidence {
  /** Rule id, e.g. `productionLike.declared`, `order.precedence`. */
  rule: string;
  /** The tool the evidence comes from (`github`, `vercel`...), if one. */
  source?: string;
  /** Plain-language detail shown under "Why Afe thinks so". */
  detail: string;
  count?: number;
}

/** Subject of a fact: `environment:<id>`. */
export type SetupSubject = `environment:${string}`;

export function environmentSubject(id: string): SetupSubject {
  return `environment:${id}`;
}

export function subjectEnvironmentId(subject: string): string | null {
  return subject.startsWith("environment:") ? subject.slice("environment:".length) : null;
}

/** What the inference rules produce (one per subject and field). */
export interface InferredFact<F extends InferredField = InferredField> {
  subject: SetupSubject;
  field: F;
  value: FieldValues[F];
  confidence: SetupConfidence;
  /** One line: why (the strongest rule that decided). */
  reason: string;
  evidence: SetupEvidence[];
}

/** An inferred fact as stored. */
export interface InferredFactRecord extends InferredFact {
  firstInferredAt: string;
  computedAt: string;
}

/** Who set an override (from the authenticated principal, never a request field). */
export interface SetupActor {
  id: string;
  name: string | null;
}

/** An admin override as stored. */
export interface SetupOverrideRecord {
  subject: SetupSubject;
  field: OverrideField;
  value: unknown;
  setBy: SetupActor;
  setAt: string;
  /**
   * The inferred value the admin chose to keep their own value against
   * ("Keep Priya's"). While inference still says exactly this, Afe does not
   * report the disagreement again.
   */
  keptInferred: unknown;
}

/** An environment the admin created (a `mapping_environments` row). */
export interface AdminEnvironment {
  id: string;
  name: string;
  order: number;
  kind: EnvironmentKind;
  createdAt: string;
  updatedAt: string;
}

/** Where an effective value came from. */
export type SetupOrigin = "admin" | "inferred" | "none";

export interface InferredValue<T> {
  value: T;
  confidence: SetupConfidence;
  reason: string;
  evidence: SetupEvidence[];
}

/** An effective value with its provenance (drives "inferred" / "set by" markers). */
export interface SetupValue<T> {
  value: T;
  origin: SetupOrigin;
  /**
   * For origin `admin`: `override` (set on the setup), or `mapping` (the
   * environment row the admin created or kept on the Mapping page).
   */
  via?: "override" | "mapping";
  confidence?: SetupConfidence;
  reason?: string;
  evidence?: SetupEvidence[];
  setBy?: SetupActor | null;
  setAt?: string;
  /** Afe's own guess, also when an admin value wins (for "Use Afe's guess"). */
  inferred: InferredValue<T> | null;
}

export interface EffectiveEnvironment {
  id: string;
  /** `admin` when the admin created it (Mapping page or an upgrade), else `inferred`. */
  origin: "admin" | "inferred";
  /** False when the admin said it is not an environment. */
  included: SetupValue<boolean>;
  /** True for a family of short-lived environments (PR previews). */
  family: boolean;
  name: SetupValue<string>;
  order: SetupValue<number>;
  productionLike: SetupValue<boolean>;
  gating: SetupValue<Gating | null>;
  batching: SetupValue<Batching | null>;
  cadence: SetupValue<Cadence | null>;
  /** Legacy kind, derived for compatibility (`kind` on mapping environments). */
  kind: EnvironmentKind;
  /** Raw tool values Afe places here (inferred mapping rules). */
  sources: EnvironmentSource[];
  firstInferredAt: string | null;
}

/** "Afe noticed": new inference Afe reports but never applies. */
export interface SetupNotice {
  /** Stable id: `<kind>:<environment>[:<field>]`. */
  id: string;
  kind: "disagreement" | "new_environment";
  environment: string;
  field?: OverrideField;
  /** The admin's current value (for a disagreement). */
  current?: SetupValue<unknown>;
  inferred: InferredValue<unknown>;
  /** What the admin can do: keep theirs or use Afe's guess; add or dismiss. */
  actions: ("keep" | "use_inferred" | "add" | "not_environment")[];
}
