/**
 * Audit query filter (AFE-14): the one definition of "which events" shared by
 * the SQL query layer (`@afe/db` event-query.ts), the HTTP API, the export
 * manifest and the offline export verifier (which re-checks that every
 * exported event matches the filter stated in the manifest).
 *
 * Semantics: values within one field are OR-ed, fields are AND-ed. String
 * matching is exact unless documented otherwise. See docs/api.md.
 */
import { ACTION_PATTERN } from "./actions.ts";
import { canonicalJson } from "./canonical-json.ts";
import { repositoryKey, type CanonicalEvent } from "./event.ts";
import { sha256Hex } from "./hash-chain.ts";

/** A normalised filter. Every list is de-duplicated and sorted; absent = no constraint. */
export interface EventFilter {
  sources?: string[];
  /** Exact actions, or prefixes written `"deployment.*"`. */
  actions?: string[];
  /** Matches id or login (case-insensitive) of the actor, its `onBehalfOf` or its `triggeredBy`. */
  actors?: string[];
  /** Primary actor id (exact). */
  actorIds?: string[];
  /** Primary actor login (case-insensitive; stored lower-cased here). */
  actorLogins?: string[];
  actorTypes?: string[];
  targetTypes?: string[];
  targetIds?: string[];
  targetNames?: string[];
  /** Case-insensitive; matches `target.environment` or `correlation.environments`. */
  environments?: string[];
  /**
   * Matches `target.repository` (case-insensitive) or
   * `correlation.repositories` (after `repositoryKey()` normalisation).
   */
  repositories?: string[];
  projects?: string[];
  applications?: string[];
  clusters?: string[];
  namespaces?: string[];
  /**
   * Git refs; matches `target.ref` or `correlation.refs`. A short name
   * ("main", "v1.2.3") also matches `refs/heads/<name>` and `refs/tags/<name>`.
   */
  refs?: string[];
  triggerTypes?: string[];
  outcomes?: string[];
  observationMethods?: string[];
  connectionIds?: string[];
  sourceEventIds?: string[];
  /** Full SHAs match exactly; 7–39 hex characters match as a prefix. Lower-cased. */
  commitShas?: string[];
  imageRefs?: string[];
  imageDigests?: string[];
  deploymentIds?: string[];
  runIds?: string[];
  pullRequests?: string[];
  /** occurredAt >= occurredFrom (ISO, UTC ms). */
  occurredFrom?: string;
  /** occurredAt < occurredTo. */
  occurredTo?: string;
  recordedFrom?: string;
  recordedTo?: string;
  /** seq >= seqFrom (inclusive). */
  seqFrom?: number;
  /** seq <= seqTo (inclusive). */
  seqTo?: number;
}

export type EventFilterListKey = {
  [K in keyof EventFilter]-?: NonNullable<EventFilter[K]> extends string[] ? K : never;
}[keyof EventFilter];

export class EventFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventFilterError";
  }
}

/** Most values accepted per list field (keeps generated SQL bounded). */
export const MAX_FILTER_VALUES = 50;

/**
 * Query-string parameter name → filter field. Parameters may be repeated or
 * comma-separated (`?source=github,vercel` or `?source=github&source=vercel`).
 */
export const EVENT_FILTER_LIST_PARAMS: Readonly<Record<string, EventFilterListKey>> = {
  source: "sources",
  action: "actions",
  actor: "actors",
  actorId: "actorIds",
  actorLogin: "actorLogins",
  actorType: "actorTypes",
  targetType: "targetTypes",
  targetId: "targetIds",
  targetName: "targetNames",
  environment: "environments",
  repository: "repositories",
  project: "projects",
  application: "applications",
  cluster: "clusters",
  namespace: "namespaces",
  ref: "refs",
  trigger: "triggerTypes",
  triggerType: "triggerTypes",
  outcome: "outcomes",
  method: "observationMethods",
  observationMethod: "observationMethods",
  connectionId: "connectionIds",
  sourceEventId: "sourceEventIds",
  commitSha: "commitShas",
  commit: "commitShas",
  imageRef: "imageRefs",
  imageDigest: "imageDigests",
  deploymentId: "deploymentIds",
  runId: "runIds",
  pullRequest: "pullRequests",
};

export const EVENT_FILTER_SCALAR_PARAMS = {
  occurredFrom: "occurredFrom",
  from: "occurredFrom",
  occurredTo: "occurredTo",
  to: "occurredTo",
  recordedFrom: "recordedFrom",
  recordedTo: "recordedTo",
  seqFrom: "seqFrom",
  seqTo: "seqTo",
} as const;

const LIST_KEYS = [...new Set(Object.values(EVENT_FILTER_LIST_PARAMS))];
const CASE_INSENSITIVE = new Set<EventFilterListKey>(["actorLogins", "environments"]);
const ACTION_PREFIX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,2}\.\*$/;
const HEX = /^[0-9a-f]+$/;

/** Input accepted by `normaliseEventFilter` (lists may be single strings; times may be Dates). */
export type EventFilterInput = {
  [K in keyof EventFilter]?: NonNullable<EventFilter[K]> extends string[]
    ? string | string[] | null
    : K extends "seqFrom" | "seqTo"
      ? number | string | null
      : string | Date | null;
};

/** Validates and normalises a filter. Throws `EventFilterError`. */
export function normaliseEventFilter(input: EventFilterInput = {}): EventFilter {
  const out: EventFilter = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;
    if ((LIST_KEYS as string[]).includes(key)) {
      const values = normaliseList(key as EventFilterListKey, raw as string | string[]);
      if (values.length > 0) (out as Record<string, unknown>)[key] = values;
    } else if (["occurredFrom", "occurredTo", "recordedFrom", "recordedTo"].includes(key)) {
      (out as Record<string, unknown>)[key] = normaliseTime(key, raw as string | Date);
    } else if (key === "seqFrom" || key === "seqTo") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isSafeInteger(n) || n < 1)
        throw new EventFilterError(`${key} must be a positive integer`);
      out[key] = n;
    } else {
      throw new EventFilterError(`unknown filter field ${key}`);
    }
  }
  if (out.occurredFrom && out.occurredTo && out.occurredFrom > out.occurredTo) {
    throw new EventFilterError("occurredFrom is after occurredTo");
  }
  if (out.recordedFrom && out.recordedTo && out.recordedFrom > out.recordedTo) {
    throw new EventFilterError("recordedFrom is after recordedTo");
  }
  // Return members in a fixed order so the canonical form is stable.
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ) as EventFilter;
}

function normaliseList(key: EventFilterListKey, raw: string | string[]): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (parts.length > MAX_FILTER_VALUES) {
    throw new EventFilterError(`${key}: at most ${MAX_FILTER_VALUES} values`);
  }
  const values = parts.map((v) => {
    if (v.length > 1024) throw new EventFilterError(`${key}: value too long`);
    if (v.includes("\u0000")) throw new EventFilterError(`${key}: invalid value`);
    if (CASE_INSENSITIVE.has(key)) return v.toLowerCase();
    if (key === "actions") {
      if (!ACTION_PATTERN.test(v) && !ACTION_PREFIX.test(v)) {
        throw new EventFilterError(
          `action ${JSON.stringify(v)} is not an action or a prefix like "deployment.*"`,
        );
      }
      return v;
    }
    if (key === "commitShas") {
      const s = v.toLowerCase();
      if (!HEX.test(s) || s.length < 7 || s.length > 64) {
        throw new EventFilterError("commitSha must be 7 to 64 hex characters");
      }
      return s;
    }
    if (key === "imageDigests" || key === "pullRequests") return v.toLowerCase();
    return v;
  });
  return [...new Set(values)].sort();
}

function normaliseTime(key: string, raw: string | Date): string {
  const d = raw instanceof Date ? raw : new Date(String(raw).trim());
  if (
    Number.isNaN(d.getTime()) ||
    (typeof raw === "string" && !/^\d{4}-\d{2}-\d{2}/.test(raw.trim()))
  ) {
    throw new EventFilterError(`${key} must be an ISO 8601 timestamp`);
  }
  return d.toISOString();
}

/**
 * Builds a filter from query-string parameters. Throws `EventFilterError` for
 * unknown parameters unless they are listed in `allowExtra` (so a typo can
 * never silently widen a query or an export).
 */
export function parseEventFilterParams(
  query: Record<string, unknown>,
  allowExtra: readonly string[] = [],
): EventFilter {
  const input: Record<string, unknown> = {};
  for (const [param, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (allowExtra.includes(param)) continue;
    const listKey = EVENT_FILTER_LIST_PARAMS[param];
    if (listKey) {
      const prev = input[listKey] as string[] | undefined;
      const vals = (Array.isArray(value) ? value : [value]).map(String);
      input[listKey] = [...(prev ?? []), ...vals];
      continue;
    }
    const scalarKey = (EVENT_FILTER_SCALAR_PARAMS as Record<string, string>)[param];
    if (scalarKey) {
      if (Array.isArray(value)) throw new EventFilterError(`${param} may only be given once`);
      if (input[scalarKey] !== undefined) throw new EventFilterError(`${param} given twice`);
      input[scalarKey] = String(value);
      continue;
    }
    throw new EventFilterError(`unknown query parameter ${JSON.stringify(param)}`);
  }
  return normaliseEventFilter(input as EventFilterInput);
}

/** True when the filter selects every event. */
export function isEmptyFilter(filter: EventFilter): boolean {
  return Object.keys(filter).length === 0;
}

/** Short stable fingerprint of a (normalised) filter plus extra query shape (e.g. order). */
export function filterFingerprint(filter: EventFilter, extra: Record<string, string> = {}): string {
  return sha256Hex(canonicalJson({ filter, ...extra })).slice(0, 16);
}

/** "deployment.*" → "deployment." ; exact actions → null. */
export function actionPrefix(action: string): string | null {
  return action.endsWith(".*") ? action.slice(0, -1) : null;
}

/** Short ref names also match the fully qualified branch and tag refs. */
export function expandRefs(refs: string[]): string[] {
  const out = new Set<string>();
  for (const r of refs) {
    out.add(r);
    if (!r.startsWith("refs/")) {
      out.add(`refs/heads/${r}`);
      out.add(`refs/tags/${r}`);
    }
  }
  return [...out].sort();
}

/** Correlation repository keys for a repository filter value (or null if it cannot be normalised). */
export function repositoryFilterKey(value: string): string | null {
  try {
    return repositoryKey(value);
  } catch {
    return null;
  }
}

/**
 * Pure implementation of the filter semantics. The SQL query layer must
 * select exactly the events for which this returns true (tests check both
 * against each other); the export verifier uses it to check every exported
 * event against the manifest's filter.
 */
export function eventMatchesFilter(event: CanonicalEvent, filter: EventFilter): boolean {
  const f = filter;
  const inList = (list: string[] | undefined, v: string | undefined | null) =>
    !list || (v !== undefined && v !== null && list.includes(v));
  const lc = (v: string | undefined) => (v === undefined ? undefined : v.toLowerCase());

  if (!inList(f.sources, event.source)) return false;
  if (f.actions) {
    const ok = f.actions.some((a) => {
      const p = actionPrefix(a);
      return p ? event.action.startsWith(p) : event.action === a;
    });
    if (!ok) return false;
  }
  if (f.actors) {
    const refs = [event.actor, event.actor.onBehalfOf, event.actor.triggeredBy];
    const ok = f.actors.some((v) =>
      refs.some(
        (r) => r && (r.id === v || (r.login !== undefined && lc(r.login) === v.toLowerCase())),
      ),
    );
    if (!ok) return false;
  }
  if (!inList(f.actorIds, event.actor.id)) return false;
  if (!inList(f.actorLogins, lc(event.actor.login))) return false;
  if (!inList(f.actorTypes, event.actor.type)) return false;
  if (!inList(f.targetTypes, event.target.type)) return false;
  if (!inList(f.targetIds, event.target.id)) return false;
  if (!inList(f.targetNames, event.target.name)) return false;
  if (f.environments) {
    const envs = event.correlation.environments ?? [];
    const ok = f.environments.some((v) => lc(event.target.environment) === v || envs.includes(v));
    if (!ok) return false;
  }
  if (f.repositories) {
    const repos = event.correlation.repositories ?? [];
    const ok = f.repositories.some((v) => {
      const key = repositoryFilterKey(v);
      return (
        lc(event.target.repository) === v.toLowerCase() || (key !== null && repos.includes(key))
      );
    });
    if (!ok) return false;
  }
  if (!inList(f.projects, event.target.project)) return false;
  if (!inList(f.applications, event.target.application)) return false;
  if (!inList(f.clusters, event.target.cluster)) return false;
  if (!inList(f.namespaces, event.target.namespace)) return false;
  if (f.refs) {
    const refs = expandRefs(f.refs);
    const corr = event.correlation.refs ?? [];
    if (!refs.some((r) => event.target.ref === r || corr.includes(r))) return false;
  }
  if (!inList(f.triggerTypes, event.trigger.type)) return false;
  if (!inList(f.outcomes, event.outcome)) return false;
  if (!inList(f.observationMethods, event.observation.method)) return false;
  if (!inList(f.connectionIds, event.connectionId)) return false;
  if (!inList(f.sourceEventIds, event.sourceEventId)) return false;
  if (f.commitShas) {
    const shas = event.correlation.commitShas ?? [];
    const ok = f.commitShas.some((v) =>
      v.length === 40 || v.length === 64 ? shas.includes(v) : shas.some((s) => s.startsWith(v)),
    );
    if (!ok) return false;
  }
  const corrList = (list: string[] | undefined, values: string[] | undefined) =>
    !list || list.some((v) => (values ?? []).includes(v));
  if (!corrList(f.imageRefs, event.correlation.imageRefs)) return false;
  if (!corrList(f.imageDigests, event.correlation.imageDigests)) return false;
  if (!corrList(f.deploymentIds, event.correlation.deploymentIds)) return false;
  if (!corrList(f.runIds, event.correlation.runIds)) return false;
  if (!corrList(f.pullRequests, event.correlation.pullRequests)) return false;

  const t = (s: string) => Date.parse(s);
  if (f.occurredFrom && t(event.occurredAt) < t(f.occurredFrom)) return false;
  if (f.occurredTo && t(event.occurredAt) >= t(f.occurredTo)) return false;
  if (f.recordedFrom && t(event.recordedAt) < t(f.recordedFrom)) return false;
  if (f.recordedTo && t(event.recordedAt) >= t(f.recordedTo)) return false;
  if (f.seqFrom !== undefined && event.seq < f.seqFrom) return false;
  if (f.seqTo !== undefined && event.seq > f.seqTo) return false;
  return true;
}

/**
 * Actions that make up the "deployments" view: anything that put (or tried to
 * put) a version somewhere, across tools. Reviews and protection-rule checks
 * are not deployments and are excluded.
 */
export const DEPLOYMENT_VIEW_ACTIONS = [
  "argocd.sync.*",
  "deployment.cancelled",
  "deployment.created",
  "deployment.promoted",
  "deployment.rolled_back",
  "deployment.status_updated",
] as const;
