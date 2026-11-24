/**
 * GitHub organization membership for Sign in with GitHub (ADR 0020).
 *
 * - Membership is proven with `GET /user/memberships/orgs/{org}` using the user's
 *   own token: only `state: "active"` with role `admin` or `member` qualifies.
 *   Pending invitations, outside collaborators (no membership: 404) and tokens that
 *   are not authorised for the org's SAML SSO (403) never qualify. `/user/orgs` is
 *   never used: it under-reports without `read:org` and is easy to misread.
 * - An organization counts only while this tenant's own GitHub App installation on
 *   it is active (stored, tenant-owned connection; never a request field), so a
 *   tenant cannot list another tenant's organization and provision its employees.
 */
import type pg from "pg";
import { GitHubApiError, GitHubHttp } from "@afe/connector-github";
import { listConnections } from "@afe/db";
import type { Secret } from "@afe/core/security";

/** `active`: proven member. `none`: proven not a member. `unknown`: could not be proven. */
export type Membership = "active" | "none" | "unknown";

const ORG = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

export function normalizeOrgLogin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return ORG.test(v) ? v : null;
}

/** Lowercase logins of organizations where this tenant's GitHub App installation is active. */
export async function activeInstallationOrgs(
  pool: pg.Pool,
  tenantId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of await listConnections(pool, tenantId, {
    source: "github",
    statuses: ["active"],
  })) {
    const account = c.config.account as { login?: unknown; type?: unknown } | undefined;
    if (c.config.suspendedAt) continue;
    if (account?.type !== "Organization") continue;
    const login = normalizeOrgLogin(account.login);
    if (login) out.add(login);
  }
  return out;
}

export async function githubOrgMembership(
  token: Secret<string>,
  org: string,
  bucket: string,
  http = new GitHubHttp({ maxRetries: 0 }),
): Promise<Membership> {
  try {
    const res = await http.request<{
      state?: unknown;
      role?: unknown;
      organization?: { login?: unknown };
    }>({
      method: "GET",
      path: `/user/memberships/orgs/${encodeURIComponent(org)}`,
      token,
      bucket,
    });
    const d = res.data ?? {};
    const login = normalizeOrgLogin(d.organization?.login);
    if (login !== null && login !== org) return "unknown";
    return d.state === "active" && (d.role === "admin" || d.role === "member") ? "active" : "none";
  } catch (error) {
    // 404: no membership (outside collaborators included). 403 can mean SSO or a
    // missing scope: it does not prove membership, but it does not prove its loss either.
    if (error instanceof GitHubApiError && error.status === 404) return "none";
    return "unknown";
  }
}

/**
 * Membership in any allowed organization that also has an active installation
 * of this tenant's App. `active` as soon as one org proves it; `none` only when
 * every candidate org proved non-membership.
 */
export async function allowedOrgMembership(
  pool: pg.Pool,
  tenantId: string,
  allowedOrgs: readonly string[],
  token: Secret<string>,
  bucket: string,
): Promise<{ membership: Membership; orgs: string[] }> {
  const installed = await activeInstallationOrgs(pool, tenantId);
  const candidates = allowedOrgs.filter((o) => installed.has(o));
  if (!candidates.length) return { membership: "none", orgs: [] };
  let unknown = false;
  const orgs: string[] = [];
  for (const org of candidates) {
    const m = await githubOrgMembership(token, org, bucket);
    if (m === "active") orgs.push(org);
    else if (m === "unknown") unknown = true;
  }
  if (orgs.length) return { membership: "active", orgs };
  return { membership: unknown ? "unknown" : "none", orgs };
}
