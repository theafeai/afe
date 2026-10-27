/**
 * Correlation API used by the journey page (AFE-25): `GET /api/journeys`,
 * `GET /api/events/:id/links` and the parts of `GET /api/environments/state`
 * the "Where it went" summary needs. Shapes mirror
 * apps/server/src/correlation/routes.ts and views.ts, and docs/api.md
 * "Environments and journeys".
 */
import { request } from "./client.ts";

export type Confidence = "certain" | "strong" | "probable" | "weak";
export const CONFIDENCE_ORDER: readonly Confidence[] = ["certain", "strong", "probable", "weak"];

export type Stage = "change" | "ci" | "artifact" | "config" | "deploy" | "runtime" | "other";

export interface CorrelationWindow {
  from: string;
  to: string;
  events: number;
  asOfSeq: number;
  stale: boolean;
  truncated: boolean;
  computedAt: string;
}

/** Compact event as the correlation API returns it (`eventSummary`). */
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

export interface Evidence {
  kind: string;
  confidence: Confidence;
  key: string;
  detail?: string;
}

export interface JourneyStep {
  eventId: string;
  stage: Stage;
  confidence: Confidence;
  reachedFrom?: string;
  via: Evidence[];
  event: EventSummary;
}

export interface JourneyEdge {
  from: string;
  to: string;
  confidence: Confidence;
  evidence: Evidence[];
}

export type EnvironmentVia = "attribution" | "config_revision" | "reached" | "containment";

export interface JourneyEnvironment {
  environmentKey: string;
  placementEventId: string;
  at: string;
  confidence: Confidence;
  current: boolean;
  via: EnvironmentVia;
  detail?: string;
  target: { key: string; source: string; label: string };
  /** Mapping ids, or `_unmapped`. */
  service: string;
  environment: string;
  event: EventSummary;
}

export interface JourneyContinuation {
  journeyId: string;
  repository: string;
  commitSha: string;
  relation: "merged_as" | "included_in" | "later_commit";
  eventId: string;
}

export interface JourneyConflict {
  kind: "tag_digest_mismatch" | "digest_commit_mismatch" | string;
  events: [string, string];
  key: string;
  detail: string;
}

export interface JourneyGap {
  gapId: string;
  source: string;
  connectionId: string;
  startedAt: string;
  endedAt: string | null;
  reason: string;
  eventId: string;
}

export interface ContainmentCheck {
  placementEventId: string;
  liveCommitSha: string;
  contained: boolean | "unknown";
  reason: string;
  environmentKey: string;
}

export interface Journey {
  id: string;
  repository: string;
  commitSha: string;
  ref: string | null;
  startedAt: string;
  root: EventSummary;
  stages: { stage: Stage; steps: string[] }[];
  steps: JourneyStep[];
  edges: JourneyEdge[];
  environments: JourneyEnvironment[];
  excluded: { eventId: string; reason: string; event: EventSummary }[];
  continuesAs: JourneyContinuation[];
  conflicts: JourneyConflict[];
  gaps: JourneyGap[];
  truncated: boolean;
  /** Null unless requested with `include=containment`. */
  containment: ContainmentCheck[] | null;
}

export interface JourneyResponse {
  window: CorrelationWindow;
  journey: Journey;
}

export interface CommitAttribution {
  repository?: string;
  commitSha: string;
  confidence: Confidence;
  via: string;
}

export interface EventLinks {
  eventId: string;
  inWindow: boolean;
  window: CorrelationWindow;
  total: number;
  links: {
    direction: "earlier" | "later";
    confidence: Confidence;
    evidence: Evidence[];
    event: EventSummary;
  }[];
  conflicts: JourneyConflict[];
  placement: {
    target: { key: string; source: string; label: string };
    current: boolean;
    eventId: string;
    at: string;
    kind: string;
    commits: CommitAttribution[];
    attribution: { status: string; confidence: Confidence | null };
    notes: string[];
  } | null;
}

/** The fields of `GET /api/environments/state` the journey summary reads. */
export interface EnvironmentStateLite {
  window: CorrelationWindow;
  services: { id: string; name: string; unmapped: boolean }[];
  environments: { id: string; name: string; kind: string; order: number; unmapped: boolean }[];
  cells: {
    service: string;
    environment: string;
    since: string;
    live: {
      eventId: string;
      at: string;
      label: string;
      commits: CommitAttribution[];
      attribution: { status: string; confidence: Confidence | null };
    };
    targets: { key: string; label: string; source: string }[];
  }[];
}

export function fetchJourney(
  repository: string,
  commit: string,
  options: { containment?: boolean } = {},
  signal?: AbortSignal,
) {
  const q = new URLSearchParams({ repository, commit });
  if (options.containment) q.set("include", "containment");
  return request<JourneyResponse>("GET", `/api/journeys?${q.toString()}`, undefined, signal);
}

export function fetchEventLinks(id: string, signal?: AbortSignal) {
  return request<EventLinks>(
    "GET",
    `/api/events/${encodeURIComponent(id)}/links?limit=200`,
    undefined,
    signal,
  );
}

export function fetchEnvironmentState(service: string, signal?: AbortSignal) {
  const q = new URLSearchParams({ service, targets: "100" });
  return request<EnvironmentStateLite>(
    "GET",
    `/api/environments/state?${q.toString()}`,
    undefined,
    signal,
  );
}

/** "github.com/acme/shop" → "acme/shop" (other hosts keep theirs). */
export function displayRepository(repository: string): string {
  return repository.startsWith("github.com/") ? repository.slice("github.com/".length) : repository;
}

/** UI link to a commit's journey. */
export function journeyPath(repository: string, commit: string): string {
  const q = new URLSearchParams({ repository: displayRepository(repository), commit });
  return `/journeys?${q.toString()}`;
}

/**
 * The repository and commit an event is about, for journey links: the first
 * commit SHA with the first repository (GitHub repositories preferred).
 */
export function journeySubject(e: {
  correlation: { repositories?: string[]; commitShas?: string[] };
}): { repository: string; commit: string } | null {
  const repos = e.correlation.repositories ?? [];
  const repo = repos.find((r) => r.startsWith("github.com/")) ?? repos[0];
  const commit = e.correlation.commitShas?.[0];
  if (!repo || !commit) return null;
  return { repository: displayRepository(repo), commit };
}
