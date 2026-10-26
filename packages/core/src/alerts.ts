/**
 * Alerts (ADR 0002 extension point `AlertSink`). Afe raises alerts about its
 * own ability to observe sources, e.g. a connection that has been blind for
 * longer than the configured threshold (AFE-13). The open-source default sink
 * logs and optionally POSTs JSON to a webhook; the hosted product can supply
 * email, Slack, PagerDuty... by passing its own `AlertSink`.
 *
 * Alerts are also recorded in the audit log as `connection.alert.opened` /
 * `connection.alert.resolved` events (builders below).
 */
import { ACTIONS } from "./actions.ts";
import { sourceEventId, type CanonicalEventInputLike } from "./event.ts";

export const ALERT_KINDS = [
  /** No successful observation for longer than the alert threshold. */
  "connection_blind",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number] | (string & {});

export interface AlertNotification {
  /** "opened" when raised, "resolved" when the condition cleared. */
  status: "opened" | "resolved";
  alertId: string;
  tenantId: string;
  kind: AlertKind;
  connectionId: string;
  connectionName: string;
  /** Source tool of the connection (github, argocd, vercel...). */
  source: string;
  /** Human-readable summary. Never contains credentials. */
  message: string;
  openedAt: string;
  resolvedAt: string | null;
  /** Observation gap the alert is about, if any. */
  gapId: string | null;
  /** Start of the blind period (last successful observation). */
  blindSince: string | null;
}

export interface AlertSink {
  /**
   * Delivers one notification. Throwing means "not delivered"; Afe retries
   * later (bounded), so implementations should be idempotent on
   * (alertId, status).
   */
  send(alert: AlertNotification): Promise<void>;
}

const AFE_SYSTEM_ACTOR = { type: "system", id: "afe", login: "afe" } as const;

function alertEvent(action: string, occurredAt: string, a: AlertNotification) {
  return {
    source: "afe",
    sourceEventId: sourceEventId("connection_alert", a.alertId, a.status),
    connectionId: a.connectionId,
    action,
    actor: AFE_SYSTEM_ACTOR,
    target: { type: "connection", id: a.connectionId, name: a.connectionName },
    trigger: { type: "system" },
    outcome: "none",
    occurredAt,
    observation: { method: "internal" },
    correlation: {},
    data: {
      alert: {
        alertId: a.alertId,
        kind: a.kind,
        source: a.source,
        message: a.message,
        openedAt: a.openedAt,
        resolvedAt: a.resolvedAt,
        gapId: a.gapId,
        blindSince: a.blindSince,
      },
    },
  } satisfies Omit<CanonicalEventInputLike, "observedAt">;
}

/** Audit event for an alert being raised (occurredAt = openedAt). */
export function connectionAlertOpened(
  a: AlertNotification,
  observedAt: Date = new Date(),
): CanonicalEventInputLike {
  return { ...alertEvent(ACTIONS.CONNECTION_ALERT_OPENED, a.openedAt, a), observedAt };
}

/** Audit event for an alert being resolved (occurredAt = resolvedAt). */
export function connectionAlertResolved(
  a: AlertNotification & { resolvedAt: string },
  observedAt: Date = new Date(),
): CanonicalEventInputLike {
  return { ...alertEvent(ACTIONS.CONNECTION_ALERT_RESOLVED, a.resolvedAt, a), observedAt };
}
