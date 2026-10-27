/**
 * Commit containment API (AFE-22): `GET /api/containment`. Shapes mirror
 * apps/server/src/containment/service.ts and docs/api.md.
 */
import { request } from "./client.ts";

export type Contained = true | false | "unknown";

export interface EnvironmentContainment {
  environment: string;
  environmentId: string | null;
  source: string;
  liveCommit: string | null;
  liveSince: string;
  contained: Contained;
  reasonCode: string;
  reason: string;
  evidence: string[];
  comparison: { status: string; aheadBy: number; behindBy: number } | null;
  cached: boolean;
  retryAfter?: string;
}

export interface ContainmentReport {
  repository: string;
  commit: string;
  checkedAt: string;
  environments: EnvironmentContainment[];
  partial: boolean;
  notes: string[];
}

export function fetchContainment(repository: string, commit: string, signal?: AbortSignal) {
  const q = new URLSearchParams({ repository, commit }).toString();
  return request<ContainmentReport>("GET", `/api/containment?${q}`, undefined, signal);
}
