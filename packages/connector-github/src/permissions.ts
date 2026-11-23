import type { PermissionMap } from "./types.ts";

/**
 * Repository permissions the Afe GitHub App requests. Read-only, each one
 * justified in docs/connectors/github.md (docs/security/rules.md R1).
 */
export const REQUIRED_PERMISSIONS = {
  /** Workflow runs and jobs (REST + `workflow_run`/`workflow_job` webhooks). */
  actions: "read",
  /** Deployments and deployment statuses (REST + `deployment`/`deployment_status`/`deployment_review` webhooks). */
  deployments: "read",
  /** Environments and their protection rules (who can approve, branch policies). */
  environments: "read",
  /** Mandatory for every GitHub App: repository list, names, ids. */
  metadata: "read",
} as const satisfies PermissionMap;

/**
 * Read permissions that enable optional features. Never required: a
 * connection without them stays `active` and the feature is simply off
 * (listed in `PermissionCheck.optionalMissing`).
 * - contents: `push`, `create`, `delete`, `release` webhooks (ref.pushed...)
 *   and commit containment (`GET /repos/{o}/{r}/compare/{base}...{head}`,
 *   AFE-22). Afe still never downloads file contents. Not requested by default.
 * - pull_requests: `pull_request` webhooks (opened, reopened, synchronize,
 *   closed, merged) for "My changes". Requested by the manifest since M1 (P2).
 *   Afe never requests pull request files, diffs or patches, and never stores
 *   pull request bodies.
 * - packages: `registry_package` webhooks (artifact.published, AFE-21).
 *   Requested by the manifest (REQUESTED_OPTIONAL_PERMISSIONS).
 * - attestations: build provenance lookups
 *   (`GET /repos/{o}/{r}/attestations/{digest}`, AFE-21). Requested by the manifest.
 */
export const OPTIONAL_READ_PERMISSIONS = [
  "attestations",
  "contents",
  "packages",
  "pull_requests",
] as const;

/**
 * Optional permissions the App manifest requests by default (read only), so
 * new Apps capture artifacts out of the box. Installations that decline them
 * (or were installed before AFE-21) keep working without artifact capture.
 */
export const REQUESTED_OPTIONAL_PERMISSIONS = {
  /** Container package publications (`registry_package` webhook). */
  packages: "read",
  /** Build provenance attestations of published images. */
  attestations: "read",
  /** Pull request metadata (`pull_request` webhook) for "My changes" (M1, P2). */
  pull_requests: "read",
} as const satisfies PermissionMap;

/**
 * Shown for installations that have not accepted an optional permission the
 * default manifest requests (for example installs made before it was added).
 * Each text states exactly what the permission grants and what Afe does with it.
 */
export const OPTIONAL_PERMISSION_NOTICES: Readonly<Record<string, string>> = {
  pull_requests:
    "Afe now asks for Pull requests: read. On GitHub it grants read-only access to pull requests and their related comments, assignees, labels, milestones and merges. Afe uses it only to receive pull request events (opened, reopened, updated, closed, merged) and to read pull request metadata such as number, title, author, branches and commit SHAs, so your pull requests appear in My changes. Afe never reads pull request files, diffs or patches, does not store pull request bodies, and gains no write access. An organization owner accepts the update in GitHub (Settings, GitHub Apps, Afe, Review request). Until then Afe keeps working without pull request events.",
};

export interface PermissionCheck {
  /** True when every required permission is granted at least as read and nothing is writable. */
  ok: boolean;
  /** Required permissions that are absent. */
  missing: string[];
  /** Permissions granted with write or admin access (Afe never needs these). */
  writable: string[];
  /** Read permissions granted beyond the required set (allowed, reported for review). */
  extra: string[];
  /**
   * Optional read permissions (OPTIONAL_READ_PERMISSIONS) that are not
   * granted, i.e. the optional features that are off. Not a problem: `ok`
   * ignores it. Absent on checks stored before AFE-21.
   */
  optionalMissing?: string[];
  /**
   * Upgrade notices for optional permissions the default manifest requests but
   * the installation has not granted (OPTIONAL_PERMISSION_NOTICES).
   */
  optionalNotices?: { permission: string; message: string }[];
}

/**
 * Checks what an installation actually granted. Installation owners can
 * accept or decline permission updates, and the App owner can widen the App's
 * permissions; both show up here.
 */
export function checkPermissions(granted: PermissionMap | null | undefined): PermissionCheck {
  const perms = granted ?? {};
  const missing = Object.keys(REQUIRED_PERMISSIONS)
    .filter((k) => !["read", "write", "admin"].includes(String(perms[k])))
    .sort();
  const writable = Object.entries(perms)
    .filter(([, v]) => v === "write" || v === "admin")
    .map(([k]) => k)
    .sort();
  const extra = Object.entries(perms)
    .filter(([k, v]) => v === "read" && !(k in REQUIRED_PERMISSIONS))
    .map(([k]) => k)
    .sort();
  const optionalMissing = OPTIONAL_READ_PERMISSIONS.filter((k) => !isGranted(perms[k]));
  const optionalNotices = optionalMissing
    .filter((k) => k in REQUESTED_OPTIONAL_PERMISSIONS && OPTIONAL_PERMISSION_NOTICES[k])
    .map((permission) => ({ permission, message: OPTIONAL_PERMISSION_NOTICES[permission]! }));
  return {
    ok: missing.length === 0 && writable.length === 0,
    missing,
    writable,
    extra,
    optionalMissing,
    ...(optionalNotices.length ? { optionalNotices } : {}),
  };
}

function isGranted(level: unknown): boolean {
  return level === "read" || level === "write" || level === "admin";
}

/** Whether a permission is granted at least as read (e.g. `packages` for artifact capture). */
export function hasPermission(granted: PermissionMap | null | undefined, name: string): boolean {
  return isGranted(granted?.[name]);
}

/** Human-readable summary of a failed check, for the connection's status reason. */
export function describePermissionProblems(check: PermissionCheck): string | null {
  const parts: string[] = [];
  if (check.writable.length > 0) {
    parts.push(`write access granted (Afe needs read only): ${check.writable.join(", ")}`);
  }
  if (check.missing.length > 0) {
    parts.push(`missing read permission: ${check.missing.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * The permissions to request when minting an installation token: every
 * permission the installation granted, narrowed to `read`. Asking for a
 * permission the installation lacks makes GitHub reject the request, so this
 * never adds any.
 */
export function readOnlyTokenPermissions(granted: PermissionMap | null | undefined): PermissionMap {
  const out: PermissionMap = {};
  for (const [k, v] of Object.entries(granted ?? {})) {
    if (v === "read" || v === "write" || v === "admin") out[k] = "read";
  }
  return out;
}
