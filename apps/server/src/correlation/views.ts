/**
 * Response shapes of the correlation API (AFE-20). Reference: docs/api.md
 * "Environments and journeys", docs/correlation.md.
 */
import type { CanonicalEvent } from "@afe/core";
import {
  actorName,
  confidenceRank,
  sameContent,
  stageOf,
  type Confidence,
  type CorrelationEvent,
  type EnvironmentState,
  type GapFlag,
  type Placement,
  type PlacementKind,
} from "@afe/core/correlation";
import type { CorrelationEventRecord } from "@afe/db";
import type { PlacementView } from "../mapping/service.ts";
import type { Snapshot } from "./service.ts";

/** Path token for the "unmapped" service or environment (slugs cannot start with `_`). */
export const UNMAPPED = "_unmapped";

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

export function eventSummary(e: CorrelationEvent): EventSummary {
  const t = e.target;
  return {
    id: e.id,
    source: e.source,
    action: e.action,
    at: e.occurredAt,
    outcome: e.outcome,
    actor: actorName(e) ?? null,
    trigger: e.trigger.type,
    target: {
      type: t.type,
      id: t.id,
      label: t.name ?? t.application ?? t.project ?? t.repository ?? t.environment ?? t.id,
    },
    url: `/api/events/${e.id}`,
  };
}

export interface GapFlagView {
  gapId: string;
  source: string;
  connectionId: string;
  startedAt: string;
  endedAt: string | null;
  reason: string;
  relation: GapFlag["relation"];
  eventId: string;
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
  configRevision: Placement["configRevision"] | null;
  images: Placement["images"];
  commits: Placement["commits"];
  attribution: Placement["attribution"];
  notes: string[];
  evidenceEventIds: string[];
  gaps: GapFlagView[];
}

export function placementSummary(snap: Snapshot, p: Placement, current: boolean): PlacementSummary {
  const event = snap.graph.events.get(p.eventId)!;
  const evidence = p.evidenceEventIds.flatMap((id) => snap.graph.events.get(id) ?? []);
  return {
    eventId: p.eventId,
    at: p.at,
    source: p.source,
    action: p.action,
    kind: p.kind,
    how: p.how,
    actor: p.actor ?? null,
    deploymentIds: p.deploymentIds,
    deploymentUrls: p.deploymentUrls,
    configRevision: p.configRevision ?? null,
    images: p.images,
    commits: p.commits,
    attribution: p.attribution,
    notes: p.notes,
    evidenceEventIds: p.evidenceEventIds,
    gaps: snap.gaps.flags(event, evidence, current).map((g) => ({
      gapId: g.gapId,
      source: g.source,
      connectionId: g.connectionId,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      reason: g.reason,
      relation: g.relation,
      eventId: g.eventId,
    })),
  };
}

/** Mapping events for `ctx.mapping.placements` (labels are read when a raw payload exists). */
export function asMappable(e: CorrelationEventRecord): CanonicalEvent {
  return {
    ...e,
    rawPayload: e.hasRawPayload ? { id: "", sha256: "" } : null,
  } as unknown as CanonicalEvent;
}

export interface TargetView {
  key: string;
  source: string;
  label: string;
  /** The tool's own environment name. */
  toolEnvironment: string;
  mapping: { confidence: PlacementView["confidence"]; matchedRuleIds: string[] } | null;
  current: PlacementSummary;
  /** When the current placement happened. */
  since: string;
  /** When the current content (same commits/images) first went live without interruption. */
  contentSince: string;
  history: {
    placements: number;
    byKind: Partial<Record<PlacementKind, number>>;
    previous: { eventId: string; at: string; kind: PlacementKind; commits: string[] } | null;
  };
}

export function targetView(
  snap: Snapshot,
  state: EnvironmentState,
  placement: PlacementView | null,
): TargetView {
  const h = state.history;
  let contentSince = state.current.at;
  for (let i = h.length - 2; i >= 0 && sameContent(h[i]!, state.current); i--)
    contentSince = h[i]!.at;
  const byKind: Partial<Record<PlacementKind, number>> = {};
  for (const p of h) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  const prev = h.length > 1 ? h[h.length - 2]! : null;
  return {
    key: state.key,
    source: state.source,
    label: state.label,
    toolEnvironment: state.environment,
    mapping: placement
      ? { confidence: placement.confidence, matchedRuleIds: placement.matchedRuleIds }
      : null,
    current: placementSummary(snap, state.current, true),
    since: state.current.at,
    contentSince,
    history: {
      placements: h.length,
      byKind,
      previous: prev
        ? {
            eventId: prev.eventId,
            at: prev.at,
            kind: prev.kind,
            commits: prev.commits.map((c) => c.commitSha),
          }
        : null,
    },
  };
}

export interface CauseView {
  event: EventSummary;
  stage: string;
  confidence: Confidence;
  evidence: { kind: string; key: string; detail?: string }[];
}

/**
 * Events that led to a placement: linked events at or before it that are
 * changes, config edits, artifacts or other events of the same deployment
 * (newest first, bounded).
 */
export function causesOf(snap: Snapshot, placementEventId: string, limit = 8): CauseView[] {
  const e = snap.graph.events.get(placementEventId)!;
  const repo = e.correlation.repositories?.[0] ?? "";
  const out: CauseView[] = [];
  for (const l of snap.graph.adjacency.get(placementEventId) ?? []) {
    if (l.to !== placementEventId) continue;
    const other = snap.graph.events.get(l.from)!;
    if (snap.graph.placements.has(other.id)) continue;
    const stage = stageOf(other, repo);
    if (stage === "runtime" || stage === "other") continue;
    out.push({
      event: eventSummary(other),
      stage,
      confidence: l.confidence,
      evidence: l.evidence.map((ev) => ({
        kind: ev.kind,
        key: ev.key,
        ...(ev.detail ? { detail: ev.detail } : {}),
      })),
    });
  }
  out.sort(
    (a, b) =>
      (a.event.at < b.event.at ? 1 : a.event.at > b.event.at ? -1 : 0) ||
      confidenceRank(b.confidence) - confidenceRank(a.confidence),
  );
  return out.slice(0, limit);
}

/** Opaque keyset cursor over (at, eventId), newest first. */
export function encodeCursor(at: string, id: string, scope: string): string {
  return Buffer.from(JSON.stringify({ v: 1, a: at, i: id, s: scope })).toString("base64url");
}

export function decodeCursor(cursor: string, scope: string): { at: string; id: string } | null {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (c.v !== 1 || typeof c.a !== "string" || typeof c.i !== "string" || c.s !== scope)
      return null;
    return { at: c.a, id: c.i };
  } catch {
    return null;
  }
}
