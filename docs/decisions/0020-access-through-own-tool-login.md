# ADR 0020: Access through each person's own tool login

- Status: Accepted
- Date: 2026-11-24
- Amends: [ADR 0012](0012-administrator-github-linking.md) (identity binding on
  administrator rotation) and [ADR 0014](0014-github-source-permissions.md) (live
  checks for read views)
- Consistent with: [ADR 0015](0015-open-source-inherited-permissions.md) (Source or
  None only)
- Reference: [User management](../user-management.md), "GitHub identity", "GitHub
  access cache" and "Sign in with GitHub"

## Context

Afe shows and acts on data from tools people already have accounts in. An admin
connects each tool with admin access so Afe can observe it. Everyone else should see
and do only what they can already see and do in that tool, with their own login, so
Afe never becomes a way around a tool's permissions (ADR 0015). Three gaps remained:
GitHub accounts were matched by login, which can be renamed and then taken by someone
else; signing in to Afe needed a separate Afe login; and checking each managed user's
repository access live on every read made read views slow and rate-limit heavy.

## Decision

1. **Tools act and read as the person.** Actions and protected reads use the person's
   own linked account for that tool. "Link your account first" is an expected state,
   and the API says so in its `403` rather than falling back to any other credential.
   Observer credentials (the GitHub App, admin connections) stay read-only collection
   credentials and never supply a person's authority.
2. **GitHub identity is the numeric user id.** Linking GitHub stores the numeric GitHub
   user id with the login (`user_external_identities`). Afe matches by id only; the
   login is display data. One GitHub account links to at most one Afe user per tenant
   (`409 identity_in_use` otherwise). Links made before this stored only the login and
   are resolved from GitHub's `/user`, with the user's own token, on the next access
   refresh.
3. **Administrator storage-account exception (amends ADR 0012).** An administrator's
   personal GitHub link is held by an administrator storage account bound to the
   administrator principal. When that principal changes (for example
   `AFE_ADMIN_TOKEN` rotation), ADR 0012 requires a fresh link, which creates a new
   storage account; the identity then moves to it from the old storage account. Old
   grants are not transferred. An identity never moves to or from a managed user, and
   storage accounts can never be signed in to.
4. **Sign in with GitHub.** Open-source Afe offers Sign in with GitHub through the
   existing personal-linking OAuth app. It is off by default and only for Afe's own
   local authentication; a hosted build with its own `AuthProvider` and
   `TenantResolver` must map the organisation to a tenant through the verified
   installation. Users are matched by numeric id only. Auto-provisioning is a separate
   opt-in, off by default, and needs at least one allowed organisation with an active
   installation of the tenant's own GitHub App; membership is proven with
   `/user/memberships/orgs/{org}` (`state: active`) at every sign-in and access
   refresh. Provisioned users are viewers with GitHub in Source mode and nothing else.
   Login CSRF is prevented by a single-use state (stored as a digest, ten minutes)
   bound to a pre-login browser cookie; the redirect URI is fixed, `next` is limited
   to same-origin paths, and start and callback are rate limited. Sessions from this
   flow stay valid only while the user is enabled and still linked.
5. **Per-user read cache, with hard limits (amends ADR 0014).** A managed user's GitHub
   repository access, as their own account reports it, may be cached in
   `user_source_access` and served to **read views only** (event lists and details,
   environments, journeys, drift, mapping, run metadata):
   - at most five minutes, measured on the server clock; an older row is never
     served, and a failed refresh deletes the row and denies, with no grace period;
   - bound to the linked credential, so relinking never reuses old rules;
   - deleted at once on unlink, relink, policy or deny-rule change, disable and
     deletion, and dropped from the access-scoped snapshot cache;
   - never shown to other users. Large accounts are bounded to 5,000 repositories per
     check; exceeding it fails closed.
     Long-lived streams re-check access before each push and close when the session
     expires or the user is disabled, deleted or unlinked. Snapshots shared between users
     with the same rules are keyed by tenant and rule fingerprint, bounded per tenant,
     and one tenant can never evict another's.
     Everything that acts or reads protected content (mutations, prepare and confirm,
     receipt replay, log reads, artifact and archive downloads, workflow-source reads,
     automations, notification sends) keeps ADR 0014's live check.

## Consequences

- The accepted cost: read views may show a repository's data for up to five minutes
  after GitHub revokes a user's access. Actions are never affected.
- Migrations `0039` (identities), `0040` (read cache) and `0041` (Sign in with GitHub
  settings and pending states) are forward-only and add tables only; every row carries
  `tenant_id`. The hourly `retention.purge` job removes cache rows past the TTL.
- **Launch blocker.** Profile linking and Sign in with GitHub store, encrypted, a
  GitHub OAuth user token with the `repo` scope: write access to every private
  repository the person can reach. Before any public or hosted launch it must be
  replaced by a write-capable GitHub App with expiring, fine-grained user tokens, in a
  new ADR amending [ADR 0011](0011-opt-in-delivery-actions.md).
