import { REQUESTED_OPTIONAL_PERMISSIONS, REQUIRED_PERMISSIONS } from "./permissions.ts";

/**
 * Webhook events the App subscribes to. Each needs one of the permissions in
 * REQUIRED_PERMISSIONS; nothing here requires write access. They cover every
 * trigger AFE-7 maps (push, pull request, manual dispatch, schedule, API,
 * re-runs, reusable workflows, repository dispatch are all visible on
 * `workflow_run` via `event`, `run_attempt`, `triggering_actor` and
 * `referenced_workflows`), plus deployments, their statuses and environment
 * approvals/rejections (`deployment_review`, and `workflow_job` "waiting").
 *
 * `installation`, `installation_repositories` and `github_app_authorization`
 * are always delivered to a GitHub App and cannot be subscribed to, so they
 * are not listed.
 */
export const SUBSCRIBED_EVENTS = [
  "deployment",
  "deployment_review",
  "deployment_status",
  "workflow_job",
  "workflow_run",
] as const;

/**
 * Events the manifest subscribes to that need an optional permission from
 * REQUESTED_OPTIONAL_PERMISSIONS (`packages`). An installation that declines
 * the permission simply does not receive them.
 *
 * `registry_package` rather than the newer `package` event: its payload
 * carries the container tag, digest and OCI labels (see "To verify" in
 * docs/connectors/github.md). `package` deliveries are mapped the same way
 * (same idempotency key) if an operator subscribes to them.
 */
export const OPTIONAL_SUBSCRIBED_EVENTS = ["registry_package"] as const;

/** Lifecycle events handled by the server module itself (not subscribable). */
export const LIFECYCLE_EVENTS = [
  "installation",
  "installation_repositories",
  "github_app_authorization",
] as const;

/**
 * Optional events, available only if an operator also grants the matching
 * optional read permission (see OPTIONAL_READ_PERMISSIONS).
 */
export const OPTIONAL_EVENTS = {
  contents: ["push", "create", "delete", "release"],
  pull_requests: ["pull_request"],
  packages: ["registry_package", "package"],
} as const;

export interface ManifestOptions {
  /** Public base URL of this Afe instance, e.g. https://afe.example.com */
  publicUrl: string;
  /** App name shown on GitHub; must be unique on github.com. */
  name?: string;
  /** Installable by any account (hosted) or only the owner (self-host default). */
  public?: boolean;
  description?: string;
}

/** Paths of the routes the server module registers. */
export const GITHUB_ROUTES = {
  webhook: "/webhooks/github",
  install: "/api/connections/github/install",
  setup: "/api/connections/github/setup",
  manifest: "/api/connections/github/manifest",
  manifestCallback: "/api/connections/github/manifest/callback",
} as const;

/**
 * GitHub App manifest for the one-click registration flow.
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
export function buildAppManifest(options: ManifestOptions) {
  const base = options.publicUrl.replace(/\/+$/, "");
  return {
    name: options.name ?? "Afe",
    url: base,
    description:
      options.description ??
      "Afe records who deployed what, where and when. Read-only access to Actions and Deployments.",
    hook_attributes: { url: `${base}${GITHUB_ROUTES.webhook}`, active: true },
    redirect_url: `${base}${GITHUB_ROUTES.manifestCallback}`,
    setup_url: `${base}${GITHUB_ROUTES.setup}`,
    setup_on_update: true,
    public: options.public ?? false,
    default_permissions: { ...REQUIRED_PERMISSIONS, ...REQUESTED_OPTIONAL_PERMISSIONS },
    default_events: [...SUBSCRIBED_EVENTS, ...OPTIONAL_SUBSCRIBED_EVENTS],
  };
}

export type AppManifest = ReturnType<typeof buildAppManifest>;

/** Where the manifest form is posted: a personal account or an organization. */
export function manifestRegistrationUrl(
  state: string,
  org?: string,
  webUrl = "https://github.com",
): string {
  const path = org
    ? `/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "/settings/apps/new";
  return `${webUrl}${path}?state=${encodeURIComponent(state)}`;
}

/** https://github.com/apps/<slug>/installations/new?state=... */
export function installUrl(slug: string, state: string, webUrl = "https://github.com"): string {
  return `${webUrl}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}
