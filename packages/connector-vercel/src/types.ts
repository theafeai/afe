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
}

export interface VercelDeploymentCreator {
  uid: string;
  username?: string;
  email?: string;
}

/** An item of `GET /v6/deployments` (note: `uid`, not `id`). */
export interface VercelDeploymentListItem {
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
export interface VercelDeployment {
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
