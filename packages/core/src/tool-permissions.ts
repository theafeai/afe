/** Per-tool policy. Source grants must come from a verified, current upstream account. */
export const TOOL_PERMISSION_MODES = ["none", "source", "custom", "source + custom"] as const;
export type ToolPermissionMode = (typeof TOOL_PERMISSION_MODES)[number];

/** Exact upstream resource identifiers and actions; no implicit wildcard grants. */
export interface ToolGrant {
  resource: string;
  action: string;
}
export interface ToolPolicy {
  mode: ToolPermissionMode;
  custom: readonly ToolGrant[];
}

/** Authentication alone never grants tool access. A missing policy denies access. */
export function permitsToolAction(
  policy: ToolPolicy | null | undefined,
  requested: ToolGrant,
  source: { verified: boolean; grants: readonly ToolGrant[] } | null,
): boolean {
  if (!policy || policy.mode === "none") return false;
  const includes = (grants: readonly ToolGrant[]) =>
    grants.some((g) => g.resource === requested.resource && g.action === requested.action);
  const fromSource =
    (policy.mode === "source" || policy.mode === "source + custom") &&
    source?.verified === true &&
    includes(source.grants);
  const fromCustom =
    (policy.mode === "custom" || policy.mode === "source + custom") && includes(policy.custom);
  return fromSource || fromCustom;
}

export interface EventAccessRule {
  source: string;
  resource: string;
  connectionId?: string;
  targetId?: string;
}
/** Match primary resources only: correlation with another resource does not grant access. */
export function eventResourceKeys(event: {
  connectionId: string | null;
  target: { id?: string; repository?: string; project?: string; application?: string };
}): string[] {
  return [
    ...(event.connectionId ? [`connection:${event.connectionId}`] : []),
    ...(event.target.repository ? [`repository:${event.target.repository.toLowerCase()}`] : []),
    ...(event.target.project ? [`project:${event.target.project}`] : []),
    ...(event.target.application ? [`application:${event.target.application}`] : []),
  ];
}
export function eventAllowed(
  rules: readonly EventAccessRule[],
  event: {
    source: string;
    connectionId: string | null;
    target: { id?: string; repository?: string; project?: string; application?: string };
  },
): boolean {
  const keys = eventResourceKeys(event);
  return rules.some(
    (r) =>
      r.source === event.source &&
      (!r.connectionId || r.connectionId === event.connectionId) &&
      (!r.targetId || r.targetId === event.target.id) &&
      keys.includes(r.resource),
  );
}
