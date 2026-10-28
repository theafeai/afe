/**
 * The parts of GitHub REST/webhook objects Afe reads. Shapes follow
 * https://docs.github.com/en/rest (API version 2022-11-28). Fields are
 * optional where GitHub documents them as nullable or omits them in some
 * payloads; unknown fields are kept by the parser (index signature) but not
 * relied on.
 */

/** Permission level as GitHub reports it. */
export type PermissionLevel = "read" | "write" | "admin";
export type PermissionMap = Record<string, PermissionLevel | string>;

export interface GitHubAccount {
  id: number;
  login: string;
  type: "User" | "Organization" | "Enterprise" | string;
  html_url?: string;
}

export interface GitHubInstallation {
  id: number;
  app_id: number;
  app_slug?: string;
  account: GitHubAccount | null;
  target_type?: string;
  repository_selection: "all" | "selected";
  permissions: PermissionMap;
  events: string[];
  created_at?: string;
  updated_at?: string;
  suspended_at?: string | null;
  suspended_by?: { id: number; login: string } | null;
  html_url?: string;
}

/** Repository as listed by GET /installation/repositories (subset). */
export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private?: boolean;
  owner?: { id: number; login: string };
  html_url?: string;
  default_branch?: string;
  archived?: boolean;
}

/** Repository as included in installation webhooks (smaller shape). */
export interface GitHubInstallationRepository {
  id: number;
  name: string;
  full_name: string;
  private?: boolean;
}

export interface GitHubUser {
  id: number;
  login: string;
  type?: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name?: string | null;
  workflow_id: number;
  run_number: number;
  run_attempt?: number;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  path?: string;
  display_title?: string;
  actor?: GitHubUser | null;
  triggering_actor?: GitHubUser | null;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  html_url: string;
  repository?: { id: number; full_name: string };
  /** Reusable workflows referenced by the run. */
  referenced_workflows?: { path: string; sha: string; ref?: string }[];
  /** Pull requests the run is associated with (empty for fork PRs). */
  pull_requests?: GitHubRunPullRequest[];
  status_reason?: string;
}

/** Minimal pull request reference on workflow runs (`workflow_run.pull_requests[]`). */
export interface GitHubRunPullRequest {
  id?: number;
  number: number;
  url?: string;
  head?: { ref?: string; sha?: string; repo?: { id?: number; url?: string; name?: string } };
  base?: { ref?: string; sha?: string; repo?: { id?: number; url?: string; name?: string } };
}

/** A workflow job (`workflow_job` webhook, REST `GET /repos/{o}/{r}/actions/jobs/{id}`). */
export interface GitHubWorkflowJob {
  id: number;
  run_id: number;
  run_attempt?: number;
  workflow_name?: string | null;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch?: string | null;
  html_url?: string;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  labels?: string[];
  runner_id?: number | null;
  runner_name?: string | null;
  runner_group_id?: number | null;
  runner_group_name?: string | null;
  steps?: GitHubWorkflowStep[];
}

export interface GitHubWorkflowStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

/** Repository object as included in repository webhooks (subset). */
export interface GitHubWebhookRepository {
  id: number;
  name?: string;
  full_name: string;
  html_url?: string;
  default_branch?: string;
  owner?: { id: number; login: string };
  /** Push events: epoch seconds; other events: ISO string. */
  pushed_at?: number | string | null;
}

export interface GitHubDeployment {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  original_environment?: string;
  description?: string | null;
  creator: GitHubUser | null;
  created_at: string;
  updated_at: string;
  transient_environment?: boolean;
  production_environment?: boolean;
  performed_via_github_app?: { id: number; slug?: string; name?: string } | null;
  statuses_url?: string;
  url?: string;
  /** Free-form deployment payload set by the creator. Kept in the raw payload only. */
  payload?: unknown;
}

export interface GitHubDeploymentStatus {
  id: number;
  state: string;
  description?: string | null;
  environment?: string;
  creator: GitHubUser | null;
  created_at: string;
  updated_at: string;
  target_url?: string;
  environment_url?: string;
  log_url?: string;
  performed_via_github_app?: { id: number; slug?: string; name?: string } | null;
}

/** POST /app/installations/{id}/access_tokens response. */
export interface GitHubInstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: PermissionMap;
  repository_selection?: "all" | "selected";
}

/** POST /app-manifests/{code}/conversions response (subset). */
export interface GitHubManifestConversion {
  id: number;
  slug: string;
  name: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
  html_url: string;
  owner: GitHubAccount | null;
}

/**
 * One environment review of a run: REST
 * `GET /repos/{o}/{r}/actions/runs/{id}/approvals`. It has no timestamp and no
 * run attempt (see docs/connectors/github.md "Reconciliation").
 */
export interface GitHubRunApproval {
  state: "approved" | "rejected" | string;
  comment?: string | null;
  user: GitHubUser | null;
  environments: { id?: number; name: string }[];
}

/**
 * An event of the repository events API (`GET /repos/{o}/{r}/events`):
 * https://docs.github.com/en/rest/activity/events. Only `PushEvent` and
 * `PullRequestEvent` are used.
 */
export interface GitHubRepoEvent {
  id: string;
  type: string;
  actor?: (GitHubUser & { display_login?: string }) | null;
  repo?: { id: number; name: string; url?: string };
  payload?: Record<string, unknown>;
  created_at?: string;
}
