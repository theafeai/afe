/**
 * Observation gaps are first-class audit events: a period during which Afe
 * could not observe a source through a connection, so events may be missing.
 * They are recorded as `observation_gap.opened` / `observation_gap.closed`
 * events with source "afe" and the gap in `data.gap` (validated by
 * `observationGapSchema`). AFE-13 (connection health) produces them.
 *
 * A gap discovered after the fact (e.g. Afe was down) is recorded by emitting
 * both events with the past start/end times; `observedAt` stays "now".
 */
import { ACTIONS } from "./actions.ts";
import {
  sourceEventId,
  type CanonicalEvent,
  type CanonicalEventInputLike,
  type ObservationGap,
  type ObservationGapReason,
} from "./event.ts";

export interface ObservationGapParams {
  gapId: string;
  connectionId: string;
  /** The source tool that could not be observed. */
  source: string;
  startedAt: string | Date;
  reason: ObservationGapReason;
  detail?: string;
  /** Display name of the connection (target.name). */
  connectionName?: string;
  /** Defaults to now. */
  observedAt?: string | Date;
}

const AFE_SYSTEM_ACTOR = { type: "system", id: "afe", login: "afe" } as const;

function gapEvent(
  action: string,
  occurredAt: string | Date,
  p: ObservationGapParams,
  endedAt: string | Date | null,
): CanonicalEventInputLike {
  return {
    source: "afe",
    sourceEventId: sourceEventId("observation_gap", p.gapId, action.split(".")[1]!),
    connectionId: p.connectionId,
    action,
    actor: AFE_SYSTEM_ACTOR,
    target: { type: "connection", id: p.connectionId, name: p.connectionName ?? null },
    trigger: { type: "system" },
    outcome: "none",
    occurredAt,
    observedAt: p.observedAt ?? new Date(),
    observation: { method: "internal" },
    correlation: {},
    data: {
      gap: {
        gapId: p.gapId,
        connectionId: p.connectionId,
        source: p.source,
        startedAt: new Date(p.startedAt).toISOString(),
        endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
        reason: p.reason,
        detail: p.detail ?? null,
      },
    },
  };
}

/** Event input for the start of an observation gap (occurredAt = startedAt). */
export function observationGapOpened(p: ObservationGapParams): CanonicalEventInputLike {
  return gapEvent(ACTIONS.OBSERVATION_GAP_OPENED, p.startedAt, p, null);
}

/** Event input for the end of an observation gap (occurredAt = endedAt). */
export function observationGapClosed(
  p: ObservationGapParams & { endedAt: string | Date },
): CanonicalEventInputLike {
  return gapEvent(ACTIONS.OBSERVATION_GAP_CLOSED, p.endedAt, p, p.endedAt);
}

export function isObservationGapEvent(
  e: Pick<CanonicalEvent, "action" | "data">,
): e is Pick<CanonicalEvent, "action"> & { data: { gap: ObservationGap } } {
  return e.action.startsWith("observation_gap.");
}
