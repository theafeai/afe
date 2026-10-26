/**
 * The subset of Vercel REST API response fields Afe reads. Fields Afe does not
 * use are not typed, and the client never returns `env`/`build.env` values
 * (docs/security/data-inventory.md); see `stripSensitive`.
 *
 * Shapes follow https://vercel.com/docs/rest-api/reference. Anything not
 * listed as certain there is on the "To verify" list in docs/connectors/vercel.md.
 */

export interface VercelUser {
  id: string;
  username: string;
  name?: string | null;
  defaultTeamId?: string | null;
}

export interface VercelTeam {
  id: string;
  slug: string;
  name?: string | null;
}

export interface VercelProject {
  id: string;
  name: string;
  accountId?: string;
  framework?: string | null;
  createdAt?: number;
  updatedAt?: number;
  /**
   * Deployments currently aliased per target; `targets.production` is the live
   * production deployment (AFE-12 uses it to detect promotions and rollbacks).
   */
  targets?: Record<string, VercelProjectTargetDeployment | null | undefined> | null;
  /** The most recent promote/rollback request on the project, when Vercel reports one. */
  lastAliasRequest?: VercelAliasRequest | null;
  /** Connected Git repository (`type` "github" | "gitlab" | "bitbucket"). */
  link?: { type?: string; org?: string; repo?: string; productionBranch?: string } | null;
}

/** A deployment as embedded in a project's `targets`. */
export interface VercelProjectTargetDeployment {
  id: string;
  name?: string;
  createdAt?: number;
  readyState?: string;
  target?: string | null;
  url?: string | null;
  ready?: number | null;
  source?: string | null;
  creator?: VercelDeploymentCreator;
  meta?: Record<string, string>;
}

/**
 * `project.lastAliasRequest` (on the "To verify" list): written when a
 * deployment is promoted or instantly rolled back.
 */
export interface VercelAliasRequest {
  fromDeploymentId?: string | null;
  toDeploymentId?: string | null;
  jobStatus?: string;
  requestedAt?: number;
  /** "promote" or "rollback". */
  type?: string;
}

/** Fields shared by list items and single deployments that AFE-12 maps. */
export interface VercelDeploymentCaptureFields {
  /** How the deployment was started: "git", "cli", "redeploy", "import", ... */
  source?: string | null;
  buildingAt?: number | null;
  /** When it became READY (for errors, when the build ended). */
  ready?: number | null;
  canceledAt?: number | null;
  inspectorUrl?: string | null;
  aliasAssigned?: number | boolean | null;
  isRollbackCandidate?: boolean | null;
  customEnvironment?: { id?: string; slug?: string; name?: string } | null;
}

export interface VercelDeploymentCreator {
  uid: string;
  username?: string;
  email?: string;
}

/** An item of `GET /v6/deployments` (note: `uid`, not `id`). */
export interface VercelDeploymentListItem extends VercelDeploymentCaptureFields {
  uid: string;
  name: string;
  url?: string | null;
  projectId?: string;
  state?: string;
  readyState?: string;
  target?: string | null;
  created: number;
  createdAt?: number;
  creator?: VercelDeploymentCreator;
  meta?: Record<string, string>;
}

/** `GET /v13/deployments/{id}`. */
export interface VercelDeployment extends VercelDeploymentCaptureFields {
  id: string;
  name: string;
  url?: string | null;
  projectId: string;
  readyState?: string;
  target?: string | null;
  createdAt: number;
  creator?: VercelDeploymentCreator;
  meta?: Record<string, string>;
  team?: { id: string; slug?: string; name?: string } | null;
}

/** `pagination` object of list endpoints. `next` is a timestamp passed back as `until`. */
export interface VercelPagination {
  count: number;
  next: number | null;
  prev: number | null;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** When the window resets (from `x-ratelimit-reset`, epoch seconds). */
  reset: Date | null;
}
