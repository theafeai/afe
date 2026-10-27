/**
 * Drift and untracked deploy detection (AFE-26): types, severities, settings
 * parsing and the `drift.finding.*` event builders. Pure: no I/O, no clock.
 * Detection itself is in `detect.ts`; the server module
 * (apps/server/src/drift) persists findings, records their transitions as
 * events and sends alerts. See docs/drift.md.
 */
import { ACTIONS } from "../actions.ts";
import { sourceEventId, type CanonicalEventInputLike, type JsonObject } from "../event.ts";

/**
 * Built-in finding types. The type is an open string (`DriftFindingType`):
 * extra detectors (`DetectDriftOptions.detectors`) may add their own.
 *
 * - `manual_override`: an ArgoCD Application's image/parameter overrides were
 *   set outside Git (`argocd.application.updated` with image override
 *   changes, not made by a parent app-of-apps).
 * - `untracked_deploy`: a deployment without Git metadata (e.g. Vercel CLI or
 *   API deploy) whose content traces to no commit (attribution `unknown`, or
 *   only a weak time-proximity `guess`).
 * - `unknown_image`: an image runs that no observed build links to a commit.
 * - `ambiguous_attribution`: the running image traces to several commits
 *   (mutable tag rebuilt) or its tag/digest identifiers conflict.
 * - `out_of_band_change`: what is live (traceable to Git) differs from the
 *   target's latest Git-triggered deploy, through a manual sync/deploy or a
 *   rollback.
 */
export const DRIFT_FINDING_TYPES = [
  "manual_override",
  "untracked_deploy",
  "unknown_image",
  "ambiguous_attribution",
  "out_of_band_change",
] as const;
export type BuiltinDriftFindingType = (typeof DRIFT_FINDING_TYPES)[number];
export type DriftFindingType = BuiltinDriftFindingType | (string & {});

/** Finding type names: lower snake case (same rule as the database check). */
export const DRIFT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export const DRIFT_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type DriftSeverity = (typeof DRIFT_SEVERITIES)[number];

export function severityRank(s: DriftSeverity): number {
  return DRIFT_SEVERITIES.indexOf(s);
}

/** Default severity per built-in type; configurable per tenant (settings API). */
export const DEFAULT_DRIFT_SEVERITY: Record<BuiltinDriftFindingType, DriftSeverity> = {
  manual_override: "high",
  untracked_deploy: "medium",
  unknown_image: "medium",
  ambiguous_attribution: "low",
  out_of_band_change: "medium",
};

export type DriftStatus = "open" | "resolved";

/** Why an event is part of a finding's evidence. */
export type DriftEvidenceRole =
  /** A placement (deploy, sync, promotion, rollback) that exhibits the finding. */
  | "placement"
  /** The ArgoCD Application change that set (or removed) the override. */
  | "override"
  /** A build/artifact or same-deployment event the attribution relies on. */
  | "build"
  /** One side of an identifier conflict (moved tag, digest claimed by two commits). */
  | "conflict"
  /** The latest Git-triggered deploy the live state differs from. */
  | "git_deploy"
  /** Other context (e.g. the push a weak time-proximity guess points at). */
  | "related"
  /** The placement that ended the finding (it is no longer exhibited). */
  | "resolution";

export interface DriftEvidence {
  eventId: string;
  role: DriftEvidenceRole;
  /** occurredAt of the event. */
  at: string;
  /** Self-contained description, so the finding still reads well after the event is purged. */
  summary: string;
}

/**
 * A finding as computed from the events of the retention window. Findings
 * are episodes: they open at the first event exhibiting the condition in a
 * target and stay one finding while consecutive placements keep exhibiting
 * it, so repeated evaluation and repeated deploys do not duplicate them.
 */
export interface DetectedFinding {
  /** Deterministic key: `<type>|<targetKey>|<openingEventId>`. */
  key: string;
  type: DriftFindingType;
  target: {
    /** Correlation target key (`EnvironmentState.key`), e.g. `argocd:argocd/shop-api-production`. */
    key: string;
    source: string;
    label: string;
    /** The tool's environment name (the mapping decides the Afe environment). */
    toolEnvironment: string;
  };
  status: DriftStatus;
  /** Event that opened the finding. */
  openingEventId: string;
  /** Most recent event exhibiting the finding (used to resolve service/environment). */
  latestEventId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** Placement that ended the finding. */
  resolvedByEventId: string | null;
  title: string;
  explanation: string;
  /** Oldest first; capped (`evidenceOmitted`). */
  evidence: DriftEvidence[];
  evidenceOmitted: number;
  /** Type-specific facts (images, override fields, commits...). */
  details: JsonObject;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export class DriftSettingsError extends Error {}

/**
 * Parses a comma-separated list of finding types (`AFE_DRIFT_ALERTS`).
 * "" / undefined → []; "all" → every built-in type. Unknown types throw.
 */
export function parseDriftTypeList(
  raw: string | undefined,
  known: readonly string[] = DRIFT_FINDING_TYPES,
): string[] {
  if (raw === undefined) return [];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0] === "all") return [...known];
  for (const p of parts) {
    if (!known.includes(p)) {
      throw new DriftSettingsError(
        `unknown drift finding type ${JSON.stringify(p.slice(0, 64))} (known: ${known.join(", ")})`,
      );
    }
  }
  return [...new Set(parts)];
}

export function isDriftSeverity(v: unknown): v is DriftSeverity {
  return typeof v === "string" && (DRIFT_SEVERITIES as readonly string[]).includes(v);
}

/** Effective severity of a type: tenant override, else the built-in default, else "medium". */
export function severityOf(
  type: DriftFindingType,
  overrides: Partial<Record<string, DriftSeverity>> = {},
): DriftSeverity {
  return (
    overrides[type] ??
    (DEFAULT_DRIFT_SEVERITY as Record<string, DriftSeverity | undefined>)[type] ??
    "medium"
  );
}

// ---------------------------------------------------------------------------
// Events (source "afe")
// ---------------------------------------------------------------------------

/** What a `drift.finding.*` event records about a finding. */
export interface DriftFindingEventData {
  id: string;
  type: DriftFindingType;
  severity: DriftSeverity;
  title: string;
  explanation: string;
  targetKey: string;
  targetLabel: string;
  targetSource: string;
  toolEnvironment: string;
  service: string | null;
  environment: string | null;
  firstSeenAt: string;
  resolvedAt: string | null;
  openingEventId: string;
  resolvedByEventId: string | null;
  evidenceEventIds: string[];
}

const AFE_SYSTEM_ACTOR = { type: "system", id: "afe", login: "afe" } as const;

function findingEvent(
  action: string,
  status: "opened" | "resolved",
  occurredAt: string,
  f: DriftFindingEventData,
  observedAt: Date,
): CanonicalEventInputLike {
  return {
    source: "afe",
    sourceEventId: sourceEventId("drift_finding", f.id, status),
    action,
    actor: AFE_SYSTEM_ACTOR,
    // The environment target the finding is about (the finding id is in data).
    target: {
      type: "environment",
      id: f.targetKey.slice(0, 512),
      name: f.targetLabel.slice(0, 512),
      environment: f.toolEnvironment.slice(0, 256),
    },
    trigger: { type: "system" },
    outcome: "none",
    occurredAt,
    observedAt,
    observation: { method: "internal" },
    correlation: {},
    data: {
      finding: {
        id: f.id,
        type: f.type,
        severity: f.severity,
        title: f.title,
        explanation: f.explanation,
        target: {
          key: f.targetKey,
          label: f.targetLabel,
          source: f.targetSource,
          toolEnvironment: f.toolEnvironment,
        },
        service: f.service,
        environment: f.environment,
        firstSeenAt: f.firstSeenAt,
        resolvedAt: f.resolvedAt,
        openingEventId: f.openingEventId,
        resolvedByEventId: f.resolvedByEventId,
        evidenceEventIds: f.evidenceEventIds.slice(0, 50),
      },
    },
  };
}

/** Event for a finding being opened (occurredAt = first seen). */
export function driftFindingOpened(
  f: DriftFindingEventData,
  observedAt: Date = new Date(),
): CanonicalEventInputLike {
  return findingEvent(ACTIONS.DRIFT_FINDING_OPENED, "opened", f.firstSeenAt, f, observedAt);
}

/** Event for a finding being resolved (occurredAt = when the replacing placement happened). */
export function driftFindingResolved(
  f: DriftFindingEventData & { resolvedAt: string },
  observedAt: Date = new Date(),
): CanonicalEventInputLike {
  return findingEvent(ACTIONS.DRIFT_FINDING_RESOLVED, "resolved", f.resolvedAt, f, observedAt);
}
