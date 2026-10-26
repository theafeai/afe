/**
 * Actor attribution from the Kubernetes Events ArgoCD records about an
 * Application (`GET /api/v1/applications/{name}/events`).
 *
 * argocd-server writes one event per API action of a user, with the message
 * `"<user> <action>"` (server/application/application.go `logAppEvent`), e.g.
 *   "alice created application"            (reason ResourceCreated)
 *   "alice updated application spec"       (reason ResourceUpdated)
 *   "alice patched application argocd/app" (reason ResourceUpdated)
 *   "alice deleted application"            (reason ResourceDeleted)
 *   "alice initiated sync to main (abc12)" (reason OperationStarted)
 *   "alice initiated rollback to 3"        (reason OperationStarted)
 *   "alice terminated running operation"   (reason ResourceUpdated)
 * The controller writes automated actions without a user, e.g.
 * "Initiated automated sync to 'abc12'". Exact wording is on the "to verify"
 * list in docs/connectors/argocd.md; parsing is tolerant and every use of it
 * is labelled with `attribution: "kubernetes_event"` in the event data.
 */
import type { ArgoCdKubeEvent } from "../types.ts";

export type AuditVerb =
  "created" | "updated" | "deleted" | "sync" | "rollback" | "terminated" | "refresh";

const VERBS: [RegExp, AuditVerb][] = [
  [/^created application\b/i, "created"],
  [/^(updated|patched) application\b/i, "updated"],
  [/^deleted application\b/i, "deleted"],
  [/^initiated rollback\b/i, "rollback"],
  [/^initiated sync\b/i, "sync"],
  [/^terminated running operation\b/i, "terminated"],
  [/^(requested|initiated)( a)?( hard| normal)? refresh\b|^refreshed application\b/i, "refresh"],
];

const VERB_START =
  /\s(created application|updated application|patched application|deleted application|initiated rollback|initiated sync|terminated running operation|requested( a)?( hard| normal)? refresh|initiated( a)?( hard| normal)? refresh|refreshed application)/i;

export interface AuditEntry {
  /** ArgoCD username (local account, or the SSO subject/email). Absent for "Unknown user". */
  user?: string;
  verb: AuditVerb;
  /** Text after the verb, e.g. "to main (abc12)" or "to 3". */
  detail: string;
  /** For rollbacks: the history id rolled back to. */
  rollbackToId?: string;
  at: Date;
  reason?: string;
  message: string;
}

export function eventTime(e: ArgoCdKubeEvent): Date | undefined {
  const t = e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp;
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Parses a user-attributed argocd-server audit message; undefined for anything else. */
export function parseAuditEvent(e: ArgoCdKubeEvent): AuditEntry | undefined {
  const message = e.message?.trim();
  const at = eventTime(e);
  if (!message || !at) return undefined;
  const m = VERB_START.exec(message);
  if (!m || m.index === 0) return undefined;
  const userPart = message.slice(0, m.index).trim();
  const rest = message.slice(m.index + 1);
  const verb = VERBS.find(([re]) => re.test(rest))?.[1];
  if (!verb) return undefined;
  const phrase = m[1] ?? "";
  const detail = rest.slice(phrase.length).trim();
  const entry: AuditEntry = {
    verb,
    detail,
    at,
    message,
    ...(e.reason ? { reason: e.reason } : {}),
  };
  if (userPart && !/^unknown user$/i.test(userPart)) entry.user = userPart;
  if (verb === "rollback") {
    const id = /\bto\s+(\d+)\b/.exec(detail)?.[1];
    if (id) entry.rollbackToId = id;
  }
  return entry;
}

export interface FindAuditOptions {
  verbs: AuditVerb[];
  /** Only entries at or after this time. */
  notBefore?: Date;
  /** Only entries at or before this time. */
  notAfter?: Date;
  /** Prefer the entry closest to this time (default: the latest). */
  near?: Date;
}

export interface AuditMatch {
  entry: AuditEntry;
  /** Other matching entries (e.g. two users updated the spec while Afe was away). */
  others: AuditEntry[];
}

export function findAuditEntry(
  events: readonly ArgoCdKubeEvent[],
  options: FindAuditOptions,
): AuditMatch | undefined {
  const entries = events
    .map(parseAuditEvent)
    .filter((x): x is AuditEntry => !!x && options.verbs.includes(x.verb))
    .filter((x) => !options.notBefore || x.at.getTime() >= options.notBefore.getTime())
    .filter((x) => !options.notAfter || x.at.getTime() <= options.notAfter.getTime());
  if (entries.length === 0) return undefined;
  const near = options.near?.getTime();
  entries.sort((a, b) =>
    near !== undefined
      ? Math.abs(a.at.getTime() - near) - Math.abs(b.at.getTime() - near)
      : b.at.getTime() - a.at.getTime(),
  );
  const [entry, ...others] = entries;
  return { entry: entry!, others };
}
