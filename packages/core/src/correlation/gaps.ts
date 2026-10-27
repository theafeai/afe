/**
 * Observation gaps in correlation (AFE-20): a placement whose evidence was
 * observed inside a gap, or whose environment had a gap after it went live
 * (a later placement may have been missed), is flagged rather than trusted.
 */
import type { JsonObject } from "../event.ts";
import { isGapEvent, type CorrelationEvent } from "./model.ts";

export interface GapSpan {
  gapId: string;
  connectionId: string;
  source: string;
  startedAt: string;
  /** Null while the gap is open. */
  endedAt: string | null;
  reason: string;
}

/**
 * - `evidence_in_gap`: an event the placement or its attribution relies on
 *   happened while its connection was not observed (it was recovered later,
 *   so related events may still be missing).
 * - `after_placement`: the placement's connection had a gap after the
 *   placement went live: a later placement may have been missed, so "what is
 *   live" may be stale.
 */
export type GapRelation = "evidence_in_gap" | "after_placement";

export interface GapFlag extends GapSpan {
  relation: GapRelation;
  /** The event that falls inside the gap (`evidence_in_gap`) or the placement (`after_placement`). */
  eventId: string;
}

/** Gap spans from `observation_gap.opened` / `.closed` events (the closed event wins). */
export function gapsFromEvents(events: Iterable<CorrelationEvent>): GapSpan[] {
  const out = new Map<string, GapSpan>();
  for (const e of events) {
    if (!isGapEvent(e)) continue;
    const g = e.data?.gap as JsonObject | undefined;
    if (!g || typeof g.gapId !== "string" || typeof g.startedAt !== "string") continue;
    const span: GapSpan = {
      gapId: g.gapId,
      connectionId: typeof g.connectionId === "string" ? g.connectionId : "",
      source: typeof g.source === "string" ? g.source : "",
      startedAt: new Date(g.startedAt).toISOString(),
      endedAt: typeof g.endedAt === "string" ? new Date(g.endedAt).toISOString() : null,
      reason: typeof g.reason === "string" ? g.reason : "unknown",
    };
    const prev = out.get(span.gapId);
    if (!prev || (span.endedAt && !prev.endedAt)) out.set(span.gapId, span);
  }
  return [...out.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
}

function appliesTo(g: GapSpan, e: Pick<CorrelationEvent, "source" | "connectionId">): boolean {
  if (e.connectionId && g.connectionId) return e.connectionId === g.connectionId;
  return g.source === e.source;
}

/** Index of gaps per connection/source for fast checks. */
export class GapIndex {
  readonly gaps: readonly GapSpan[];
  constructor(gaps: GapSpan[], readonly now: string) {
    this.gaps = gaps;
  }

  /** Gaps whose period contains the event's time. */
  containing(e: Pick<CorrelationEvent, "source" | "connectionId" | "occurredAt">): GapSpan[] {
    return this.gaps.filter(
      (g) =>
        appliesTo(g, e) && g.startedAt <= e.occurredAt && e.occurredAt < (g.endedAt ?? this.now),
    );
  }

  /** Gaps of the event's connection that overlap (event time, now]. */
  after(e: Pick<CorrelationEvent, "source" | "connectionId" | "occurredAt">): GapSpan[] {
    return this.gaps.filter(
      (g) => appliesTo(g, e) && (g.endedAt === null || g.endedAt > e.occurredAt),
    );
  }

  /**
   * Flags for a placement: its evidence events inside gaps, and (when it is
   * what is live now) gaps after it.
   */
  flags(
    placement: CorrelationEvent,
    evidence: readonly CorrelationEvent[],
    current: boolean,
  ): GapFlag[] {
    if (this.gaps.length === 0) return [];
    const out = new Map<string, GapFlag>();
    for (const e of [placement, ...evidence]) {
      for (const g of this.containing(e)) {
        const k = `${g.gapId}:evidence_in_gap`;
        if (!out.has(k)) out.set(k, { ...g, relation: "evidence_in_gap", eventId: e.id });
      }
    }
    if (current) {
      for (const g of this.after(placement)) {
        const k = `${g.gapId}:after_placement`;
        if (!out.has(k)) out.set(k, { ...g, relation: "after_placement", eventId: placement.id });
      }
    }
    return [...out.values()];
  }
}
