/**
 * Environment and service mapping API (AFE-19). Shapes mirror
 * apps/server/src/mapping/routes.ts and docs/api.md.
 */
import type {
  EnvironmentKind,
  MappingEnvironment,
  MappingRule,
  MappingService,
  MatchType,
  Observations,
  PlacementConfidence,
  RuleKind,
} from "@afe/core/types";
import { request } from "./client.ts";

export type {
  EnvironmentKind,
  MappingEnvironment,
  MappingRule,
  MappingService,
  MatchType,
  PlacementConfidence,
  RuleKind,
};

export interface RuleView extends MappingRule {
  inactiveReason: string | null;
}

export interface MappingState {
  revision: number;
  customised: boolean;
  services: MappingService[];
  environments: MappingEnvironment[];
  rules: RuleView[];
  builtinRules: RuleView[];
  fields: string[];
  environmentKinds: EnvironmentKind[];
}

export interface PlacementView {
  service: { id: string; name: string } | null;
  environment: { id: string; name: string; kind: string; order: number } | null;
  confidence: PlacementConfidence;
  matchedRuleIds: string[];
  unmapped: ("service" | "environment")[];
}

export interface PreviewItem {
  eventId: string;
  when: string;
  source: string;
  action: string;
  label: string;
  observations: Observations;
  current: PlacementView;
  proposed: PlacementView;
  changed: boolean;
}

export interface PreviewResult {
  sampleSize: number;
  summary: {
    current: Record<PlacementConfidence, number>;
    proposed: Record<PlacementConfidence, number>;
    changed: number;
  };
  inactive: { ruleId: string; reason: string }[];
  items: PreviewItem[];
}

export interface UnmappedValue {
  source: string;
  field: string;
  value: string;
  count: number;
  lastSeen: string;
  missing: ("service" | "environment")[];
  exampleEventId: string;
}

/** A rule as edited in the UI and sent to the API. */
export interface RuleDraft {
  id?: string;
  kind: RuleKind;
  field: string;
  match: MatchType;
  pattern: string;
  caseSensitive: boolean;
  targetId: string;
  enabled: boolean;
  priority?: number;
  note?: string | null;
}

const enc = encodeURIComponent;

export const mappingApi = {
  get: (signal?: AbortSignal) => request<MappingState>("GET", "/api/mapping", undefined, signal),
  unmapped: (signal?: AbortSignal) =>
    request<{ sampleSize: number; values: UnmappedValue[] }>(
      "GET",
      "/api/mapping/unmapped",
      undefined,
      signal,
    ),
  preview: (
    body: { rules?: RuleDraft[]; builtinOverrides?: Record<string, boolean>; items?: number },
    signal?: AbortSignal,
  ) => request<PreviewResult>("POST", "/api/mapping/preview", body, signal),

  createService: (body: { id?: string; name: string; description?: string | null }) =>
    request<{ service: MappingService }>("POST", "/api/mapping/services", body),
  deleteService: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/mapping/services/${enc(id)}`),

  createEnvironment: (body: { name: string; kind: EnvironmentKind; order?: number }) =>
    request<{ environment: MappingEnvironment }>("POST", "/api/mapping/environments", body),
  updateEnvironment: (id: string, body: { name: string; kind: EnvironmentKind; order?: number }) =>
    request<{ environment: MappingEnvironment }>(
      "PUT",
      `/api/mapping/environments/${enc(id)}`,
      body,
    ),
  deleteEnvironment: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/mapping/environments/${enc(id)}`),

  createRule: (draft: RuleDraft) =>
    request<{ rule: MappingRule }>("POST", "/api/mapping/rules", ruleBody(draft)),
  updateRule: (id: string, draft: RuleDraft) =>
    request<{ rule: MappingRule }>("PUT", `/api/mapping/rules/${enc(id)}`, ruleBody(draft)),
  deleteRule: (id: string) => request<{ ok: true }>("DELETE", `/api/mapping/rules/${enc(id)}`),
  reorderRules: (kind: RuleKind, ids: string[]) =>
    request<{ rules: MappingRule[] }>("POST", "/api/mapping/rules/reorder", { kind, ids }),
  setBuiltin: (id: string, enabled: boolean) =>
    request<{ rule: MappingRule }>("PUT", `/api/mapping/builtin-rules/${enc(id)}`, { enabled }),
};

/** The API body of a rule (no id). */
export function ruleBody(d: RuleDraft) {
  return {
    kind: d.kind,
    field: d.field,
    match: d.match,
    pattern: d.pattern,
    caseSensitive: d.caseSensitive,
    targetId: d.targetId,
    enabled: d.enabled,
    ...(d.priority !== undefined ? { priority: d.priority } : {}),
    ...(d.note ? { note: d.note } : {}),
  };
}
