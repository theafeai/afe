/**
 * Drift API (AFE-26): `GET /api/drift/findings`, `GET /api/drift/findings/:id`,
 * `GET /api/drift/settings`. Shapes mirror apps/server/src/drift/routes.ts and
 * docs/api.md "Drift findings".
 */
import { request } from "./client.ts";

export const DRIFT_TYPES = [
  "manual_override",
  "untracked_deploy",
  "unknown_image",
  "ambiguous_attribution",
  "out_of_band_change",
] as const;

export const DRIFT_TYPE_LABELS: Record<string, string> = {
  manual_override: "Manual override",
  untracked_deploy: "Untracked deploy",
  unknown_image: "Unknown image",
  ambiguous_attribution: "Ambiguous attribution",
  out_of_band_change: "Out-of-band change",
};

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

export interface DriftFindingSummary {
  id: string;
  type: string;
  severity: string;
  status: "open" | "resolved";
  title: string;
  explanation: string;
  target: { key: string; source: string; label: string; toolEnvironment: string };
  service: { id: string; name: string } | null;
  environment: { id: string; name: string } | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  openingEventId: string;
  resolvedByEventId: string | null;
  evidenceCount: number;
  url: string;
}

export interface DriftFindingsPage {
  evaluatedAt: string | null;
  counts: { open: number; resolved: number };
  findings: DriftFindingSummary[];
  nextCursor: string | null;
}

export interface DriftEvidenceView {
  eventId: string;
  role: string;
  at: string;
  summary: string;
  available: boolean;
  url: string | null;
}

export interface DriftFindingDetail extends DriftFindingSummary {
  latestEventId: string;
  evidence: DriftEvidenceView[];
  evidenceOmitted: number;
  eventsPurged: number;
  details: Record<string, unknown>;
  journeys: { repository: string; commitSha: string; url: string }[];
  alert: {
    enabled: boolean;
    typeAlertsNow: boolean;
    openedNotifiedAt: string | null;
    resolvedNotifiedAt: string | null;
  };
  detectedAt: string;
  updatedAt: string;
}

export interface DriftFilters {
  status: "open" | "resolved" | "all";
  type: string;
  severity: string;
  service: string;
  environment: string;
}

export const DEFAULT_DRIFT_FILTERS: DriftFilters = {
  status: "open",
  type: "",
  severity: "",
  service: "",
  environment: "",
};

export function parseDriftFilters(p: URLSearchParams): DriftFilters {
  const status = p.get("status");
  return {
    status: status === "resolved" || status === "all" ? status : "open",
    type: p.get("type") ?? "",
    severity: p.get("severity") ?? "",
    service: p.get("service") ?? "",
    environment: p.get("environment") ?? "",
  };
}

export function driftFiltersToSearch(f: DriftFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status !== "open") p.set("status", f.status);
  for (const k of ["type", "severity", "service", "environment"] as const) if (f[k]) p.set(k, f[k]);
  return p;
}

export function fetchDriftFindings(f: DriftFilters, cursor?: string, signal?: AbortSignal) {
  const p = new URLSearchParams({ status: f.status });
  for (const k of ["type", "severity", "service", "environment"] as const) if (f[k]) p.set(k, f[k]);
  if (cursor) p.set("cursor", cursor);
  return request<DriftFindingsPage>("GET", `/api/drift/findings?${p}`, undefined, signal);
}

export function fetchDriftFinding(id: string, signal?: AbortSignal) {
  return request<{ finding: DriftFindingDetail }>(
    "GET",
    `/api/drift/findings/${encodeURIComponent(id)}`,
    undefined,
    signal,
  );
}

/** UI path of an API journey link (`/api/journeys?...` → `/journeys?...`). */
export function journeyPath(apiUrl: string): string {
  return apiUrl.replace(/^\/api\/journeys/, "/journeys");
}
