/**
 * Timeline filters <-> URL query string <-> API query parameters.
 *
 * The URL uses the API's own parameter names (docs/api.md "Filters") so a
 * filtered timeline URL reads like the API call it makes, plus `range` for
 * relative time presets (resolved to `from`/`to` when the request is made, so
 * a bookmarked "last 24 hours" link stays relative).
 */
import type { ObservationMethod, Outcome, TriggerType } from "@afe/core/types";

export const TOOLS = [
  { id: "github", label: "GitHub" },
  { id: "argocd", label: "ArgoCD" },
  { id: "vercel", label: "Vercel" },
  { id: "afe", label: "Afe" },
] as const;

/** Target filter fields offered in the UI; each is an API parameter. */
export const TARGET_FIELDS = [
  { id: "targetName", label: "Target name" },
  { id: "environment", label: "Environment" },
  { id: "repository", label: "Repository" },
  { id: "application", label: "Application" },
  { id: "project", label: "Project" },
  { id: "targetId", label: "Target id" },
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number]["id"];

export const TRIGGER_TYPES = [
  "push",
  "pull_request",
  "merge_queue",
  "tag",
  "release",
  "manual",
  "schedule",
  "api",
  "cli",
  "rerun",
  "auto_sync",
  "rollback",
  "promotion",
  "redeploy",
  "upstream",
  "system",
  "unknown",
] as const satisfies readonly TriggerType[];

export const OBSERVATION_METHODS = [
  "webhook",
  "poll",
  "stream",
  "reconciliation",
  "backfill",
  "internal",
] as const satisfies readonly ObservationMethod[];

export const OUTCOMES = [
  "succeeded",
  "failed",
  "cancelled",
  "in_progress",
  "pending",
  "skipped",
  "none",
  "unknown",
] as const satisfies readonly Outcome[];

export const RANGE_PRESETS = [
  { id: "1h", label: "Last hour", ms: 3_600_000 },
  { id: "24h", label: "Last 24 hours", ms: 86_400_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
] as const;
export type RangeId = "all" | "custom" | (typeof RANGE_PRESETS)[number]["id"];

/**
 * Every filter parameter the API accepts (EVENT_FILTER_LIST_PARAMS and
 * EVENT_FILTER_SCALAR_PARAMS in @afe/core event-filter.ts). Parameters the UI
 * has no control for (e.g. `connectionId`, `commitSha` from a detail page
 * link) are kept and shown as removable chips.
 */
export const API_FILTER_PARAMS = [
  "source",
  "action",
  "actor",
  "actorId",
  "actorLogin",
  "actorType",
  "targetType",
  "targetId",
  "targetName",
  "environment",
  "repository",
  "project",
  "application",
  "cluster",
  "namespace",
  "ref",
  "trigger",
  "triggerType",
  "outcome",
  "method",
  "observationMethod",
  "connectionId",
  "sourceEventId",
  "commitSha",
  "commit",
  "imageRef",
  "imageDigest",
  "deploymentId",
  "runId",
  "pullRequest",
  "from",
  "to",
  "occurredFrom",
  "occurredTo",
  "recordedFrom",
  "recordedTo",
  "seqFrom",
  "seqTo",
] as const;

const CONTROLLED = new Set<string>([
  "source",
  "actor",
  ...TARGET_FIELDS.map((f) => f.id),
  "trigger",
  "method",
  "outcome",
  "from",
  "to",
  "range",
]);

export interface Filters {
  sources: string[];
  actor: string;
  targetField: TargetField;
  target: string;
  trigger: string;
  method: string;
  outcome: string;
  range: RangeId;
  /** ISO 8601, only with range = custom. */
  from: string;
  to: string;
  /** Other API filter parameters from the URL, in order. */
  extra: [string, string][];
}

export const EMPTY_FILTERS: Filters = {
  sources: [],
  actor: "",
  targetField: "targetName",
  target: "",
  trigger: "",
  method: "",
  outcome: "",
  range: "all",
  from: "",
  to: "",
  extra: [],
};

const RANGE_IDS = new Set<string>(["all", "custom", ...RANGE_PRESETS.map((r) => r.id)]);

export function parseFilters(params: URLSearchParams): Filters {
  const f: Filters = { ...EMPTY_FILTERS, extra: [] };
  f.sources = params
    .getAll("source")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  f.actor = params.get("actor") ?? "";
  const tf = TARGET_FIELDS.find((t) => params.get(t.id));
  if (tf) {
    f.targetField = tf.id;
    f.target = params.get(tf.id) ?? "";
  }
  f.trigger = params.get("trigger") ?? "";
  f.method = params.get("method") ?? "";
  f.outcome = params.get("outcome") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const range = params.get("range") ?? "";
  if (RANGE_IDS.has(range) && range !== "custom") f.range = range as RangeId;
  else if (range === "custom" || from || to) {
    f.range = "custom";
    f.from = from;
    f.to = to;
  }
  for (const [k, v] of params) {
    if (CONTROLLED.has(k) && !(TARGET_FIELDS.some((t) => t.id === k) && k !== f.targetField)) {
      continue;
    }
    if ((API_FILTER_PARAMS as readonly string[]).includes(k) && v !== "") f.extra.push([k, v]);
  }
  return f;
}

/** The URL query for a filter state (stable order, empty values left out). */
export function filtersToSearch(f: Filters): URLSearchParams {
  const q = new URLSearchParams();
  if (f.sources.length) q.set("source", f.sources.join(","));
  if (f.actor.trim()) q.set("actor", f.actor.trim());
  if (f.target.trim()) q.set(f.targetField, f.target.trim());
  if (f.trigger) q.set("trigger", f.trigger);
  if (f.method) q.set("method", f.method);
  if (f.outcome) q.set("outcome", f.outcome);
  if (f.range === "custom") {
    if (f.from) q.set("from", f.from);
    if (f.to) q.set("to", f.to);
    if (!f.from && !f.to) q.set("range", "custom");
  } else if (f.range !== "all") {
    q.set("range", f.range);
  }
  for (const [k, v] of f.extra) q.append(k, v);
  return q;
}

/** API query parameters for a filter state; relative ranges are resolved against `now`. */
export function filtersToApiParams(f: Filters, now: Date = new Date()): URLSearchParams {
  const q = filtersToSearch(f);
  q.delete("range");
  const preset = RANGE_PRESETS.find((r) => r.id === f.range);
  if (preset) q.set("from", new Date(now.getTime() - preset.ms).toISOString());
  return q;
}

/** Number of active filters (for the "Clear filters" affordance and empty states). */
export function activeFilterCount(f: Filters): number {
  return (
    (f.sources.length ? 1 : 0) +
    (f.actor ? 1 : 0) +
    (f.target ? 1 : 0) +
    (f.trigger ? 1 : 0) +
    (f.method ? 1 : 0) +
    (f.outcome ? 1 : 0) +
    (f.range !== "all" ? 1 : 0) +
    f.extra.length
  );
}

/** `datetime-local` input value (local time) <-> ISO 8601 UTC. */
export function isoToLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
