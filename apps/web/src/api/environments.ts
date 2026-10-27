/**
 * Environment matrix and placement history API (AFE-20, used by AFE-24).
 * Shapes mirror apps/server/src/correlation/{routes,views}.ts and
 * docs/api.md "Environments and journeys".
 */
import { request } from "./client.ts";

export type Confidence = "certain" | "strong" | "probable" | "weak";
export type AttributionStatus = "attributed" | "ambiguous" | "guess" | "unknown";
export type PlacementKind = "deploy" | "promotion" | "rollback" | "redeploy" | "manual";
export type GapRelation = "evidence_in_gap" | "after_placement";

export interface CorrelationWindow {
  from: string;
  to: string;
  events: number;
  /** The newest event `seq` the answer reflects. */
  asOfSeq: number;
  /** Newer events exist that are not reflected yet (recompute is throttled). */
  stale: boolean;
  /** The per-tenant event limit was hit; the oldest events were left out. */
  truncated: boolean;
  computedAt: string;
}

export interface GapFlagView {
  gapId: string;
  source: string;
  connectionId: string;
  startedAt: string;
  endedAt: string | null;
  reason: string;
  relation: GapRelation;
  eventId: string;
}

export interface BuildCandidate {
  eventId: string;
  commitSha?: string;
  repository?: string;
  confidence: Confidence;
}

export interface ImageAttribution {
  ref?: string;
  digest?: string;
  builds: BuildCandidate[];
  buildsOmitted?: number;
}

export interface CommitAttribution {
  repository?: string;
  commitSha: string;
  confidence: Confidence;
  via: string;
}

export interface PlacementSummary {
  eventId: string;
  at: string;
  source: string;
  action: string;
  kind: PlacementKind;
  how: string;
  actor: string | null;
  deploymentIds: string[];
  deploymentUrls: string[];
  configRevision: { repository?: string; commitSha: string } | null;
  images: ImageAttribution[];
  commits: CommitAttribution[];
  attribution: { status: AttributionStatus; confidence: Confidence | null };
  notes: string[];
  evidenceEventIds: string[];
  gaps: GapFlagView[];
}

export interface ServiceColumn {
  id: string;
  name: string;
  unmapped: boolean;
}

export interface EnvironmentColumn {
  id: string;
  name: string;
  kind: string;
  order: number | null;
  unmapped: boolean;
}

export interface TargetView {
  key: string;
  source: string;
  label: string;
  toolEnvironment: string;
  mapping: { confidence: string; matchedRuleIds: string[] } | null;
  current: PlacementSummary;
  since: string;
  contentSince: string;
  history: {
    placements: number;
    byKind: Partial<Record<PlacementKind, number>>;
    previous: { eventId: string; at: string; kind: PlacementKind; commits: string[] } | null;
  };
}

export interface MatrixCell {
  service: string;
  environment: string;
  unmapped: boolean;
  status: AttributionStatus;
  confidence: Confidence | null;
  since: string;
  contentSince: string;
  consistent: boolean;
  gap: { flagged: boolean; evidenceInGap: boolean; possiblyStale: boolean };
  live: PlacementSummary & { targetKey: string; label: string };
  targets: TargetView[];
  targetsOmitted: number;
  historyUrl: string;
}

export interface EnvironmentStateResponse {
  asOf: string;
  window: CorrelationWindow;
  services: ServiceColumn[];
  environments: EnvironmentColumn[];
  cells: MatrixCell[];
}

export interface EventSummary {
  id: string;
  source: string;
  action: string;
  at: string;
  outcome: string;
  actor: string | null;
  trigger: string;
  target: { type: string; id: string; label: string };
  url: string;
}

export interface CauseView {
  event: EventSummary;
  stage: string;
  confidence: Confidence;
  evidence: { kind: string; key: string; detail?: string }[];
}

export interface HistoryItem {
  target: { key: string; source: string; label: string };
  current: boolean;
  change: "first" | "new_content" | "same_content";
  previousEventId: string | null;
  placement: PlacementSummary;
  event: EventSummary;
  causes: CauseView[];
}

export interface HistoryResponse {
  service: ServiceColumn;
  environment: Omit<EnvironmentColumn, "kind" | "order"> & { kind?: string; order?: number | null };
  window: CorrelationWindow;
  targets: {
    key: string;
    source: string;
    label: string;
    toolEnvironment: string;
    currentEventId: string;
    placements: number;
  }[];
  total: number;
  items: HistoryItem[];
  nextCursor: string | null;
}

/** `_unmapped`: the service or environment of targets no mapping rule matches. */
export const UNMAPPED = "_unmapped";

const enc = encodeURIComponent;

export const environmentsApi = {
  state: (signal?: AbortSignal) =>
    request<EnvironmentStateResponse>("GET", "/api/environments/state", undefined, signal),
  /** One page of a cell's placement history; `params`: `limit`, `cursor`, `target`. */
  history: (
    service: string,
    environment: string,
    params: URLSearchParams,
    signal?: AbortSignal,
  ) => {
    const qs = params.toString();
    return request<HistoryResponse>(
      "GET",
      `/api/environments/${enc(service)}/${enc(environment)}/history${qs ? `?${qs}` : ""}`,
      undefined,
      signal,
    );
  },
};

/** The journey page (AFE-25) for one commit. */
export function journeyHref(repository: string, commitSha: string): string {
  return `/journeys?${new URLSearchParams({ repository, commit: commitSha }).toString()}`;
}
