# Users and tool access

An administrator can open **Users** to create a named user without email or
SMTP. Afe generates a random access credential and displays it once. Share it
with the user directly; they paste it into the Afe sign-in screen. Only its
SHA-256 digest is stored. The credential contains 256 bits of random secret
material, rather than a human-chosen password.

Resetting a credential or disabling a user invalidates existing local-user
sessions on their next request. Re-enabling a user does not restore those
sessions. The bootstrap `AFE_ADMIN_TOKEN` remains the administrator; newly
created users cannot manage other users or connections.

Run `afe migrate` before starting the updated server (migrations 0026–0027).
Existing bootstrap and static viewer token behavior is preserved. A custom
`authProvider` supplied by a hosted build retains control of authentication;
it can compose `withLocalUsers` if it wants local credentials as well.

## Deleting a user

In **Users**, select an account, then choose **Delete user** under Account
management. The confirmation names that account and describes the effects.
Cancel leaves it unchanged. Deletion is permanent and distinct from disabling.

`DELETE /api/admin/users/:id` requires administrator authorization (and CSRF for
cookie sessions), uses the authenticated tenant, and returns `404` for unknown or
other-tenant IDs. A transaction locks the user, removes the login, permission
settings, personal tool links, OAuth/OIDC states, recovery/invitation links and
their email outbox records. Associated encrypted token, OIDC and email payloads
are revoked and their key material destroyed. Only revoked credential metadata
remains; no user tombstone is kept. No schema migration is required.

The removed credential and every existing local-user session fail their next
authentication check. Already-running requests or email deliveries may finish
before deletion commits; delivered messages cannot be recalled, but their links
stop working. Upstream accounts/tokens and shared observation connections are
kept; revoke upstream tokens at the provider separately if required.

Recorded events keep their original embedded actor identities, and operational
receipts retain their actor IDs under their existing retention rules. These
records do not reference the mutable login row. Reusing a deleted username
creates a new UUID and does not restore credentials, sessions or tool access.

Self-deletion returns `409 self_deletion`. Administrator-linked GitHub storage
accounts are protected (`409 administrator_identity`); use Profile to unlink
personal access instead. Local users are viewers, while the bootstrap administrator
and external-provider administrator roles are managed outside this user table.
Deleting the final managed user therefore cannot delete the last administrator.
External providers remain responsible for their own administrator lifecycle;
this endpoint does not remove provider principals or change administrator roles.

## Permission modes

Open source supports inherited permissions only. Each user has a separate setting
for GitHub, Vercel, ArgoCD and Terraform:

| Mode   | Access                                                                 |
| ------ | ---------------------------------------------------------------------- |
| none   | No access; missing settings also deny access and hide the tool.        |
| source | The user's own linked tool account determines current resource access. |

Afe-managed custom permissions are planned for **Afe Cloud only**, and are not
available through the open-source UI, API or policy writer. GitHub's optional
deny-only action restrictions remain available to narrow inherited operations;
they never grant resource or action access.

Sources are isolated, and correlated resources do not independently confer access
to an event. Event lists apply authorization in SQL before pagination, and event
details recheck the same rules. ArgoCD access binds the application to its specific
Afe connection. Repository/project/application access does not expose whole
connection health, configuration or other resources on that connection.

### Upgrade from custom policies

Existing `custom` and `source + custom` policies are **blocked in full**, including
the source component of combined policies. Stored policy data is kept for review;
there is no automatic conversion, deletion or new inherited access. Existing
`source` policies continue to inherit access and `none` stays disabled. Relinking
an account does not replace its policy. No data migration is needed for this change;
run all existing migrations normally before starting the server.

Administrators must review each affected account in **Users** (or read
`GET /api/admin/users/:id/permissions`). The warning requires an explicit choice:

1. Compare retained grants and restrictions with the linked source identity's
   actual resource access, roles and token scopes. Narrow that identity upstream
   first if required. Switching to Source can grant different or broader access
   than an old allowlist.
2. Choose **No access** to keep the tool disabled, or **Linked tool account** to
   deliberately inherit the reviewed source permissions. Save each tool separately.
3. API clients send `{ "mode": "none", "custom": [] }` or
   `{ "mode": "source", "custom": [] }` to the existing permission PUT endpoint.
   Custom modes and nonempty custom arrays return `400 invalid_policy` without
   changing the stored row. Omit `denied` to preserve existing GitHub restrictions;
   only an explicit `denied: []` clears them.
4. Saving replaces the obsolete custom grants with an empty array. Back up the
   tenant/user/tool policy records first if their contents are needed for review
   or a future cloud transition. Credentials, disabled users and tenant bindings
   are unaffected. Verify access with the affected user after the change.

See [ADR 0015](decisions/0015-open-source-inherited-permissions.md) for the edition
boundary and cloud implementation follow-up.

Managed users can use environment, journey, drift and read-only mapping views.
Graphs are built only from authorized events, independently of the tenant-wide
cache, before computing links, placement histories, dimensions and counts.
Related activity outside their permissions is omitted; the UI labels that scope.
Permission changes and upstream revocation are rechecked on the next read.

Drift findings are visible only if the user can read the target source and every
supporting event, including opening, latest and resolving events. Findings with
omitted or purged evidence are hidden because their full authorization cannot
be verified. Counts and pagination apply that same rule. Restricted reads do
not derive or persist alternate drift state from a partial graph.

Mapping exposes only services/environments seen in the most recent 1,000 permitted
deployment events. Rule patterns, configuration descriptions and revisions are
not disclosed. Rule previews, mapping edits, drift settings, raw evidence and
remote commit-containment comparisons remain unavailable to managed users.
Standalone open-source Afe does not provide audit exports.

## Linking personal tool accounts

Afe sign-in and tool sign-in are separate. Users open **Profile** to link their
own upstream accounts for tools in Source mode. Credentials
are encrypted using Afe's existing key provider. Unlinking destroys their local
ciphertext. Afe never substitutes the administrator's integration credentials.
Source access is revalidated upstream when querying data; expiry, revocation,
network errors or rate limits fail closed. Large GitHub accounts are bounded to 5,000 repositories
per authorization check; exceeding this fails closed.

### Administrator GitHub linking

Administrators can link a personal GitHub account directly in **Profile** without
creating or signing in as a separate user. The first link creates a
`github-admin-…` account for encrypted token storage and permissions. Profile
identifies that account in **Users**. It starts with GitHub source access, inheriting supported operations.
Administrator authority does not replace current GitHub roles or token permissions.
See [GitHub operations](github-actions.md) for token permissions and restrictions.

Apply migration `0034_github_admin_identities.sql` before using administrator
linking. Managed-user linking and hosted `githubUserId` mappings are preserved.

### GitHub OAuth

Configure a dedicated GitHub OAuth application (or a GitHub App with appropriate
user permissions), and register this callback URL:

```
https://<your-afe-host>/api/profile/tools/github/callback
```

Set `AFE_PUBLIC_URL`, `AFE_USER_GITHUB_CLIENT_ID`, and
`AFE_USER_GITHUB_CLIENT_SECRET` (or `AFE_USER_GITHUB_CLIENT_SECRET_FILE`).
`AFE_ENCRYPTION_KEY` is required for encrypted account storage. GitHub OAuth
applications request `repo read:user` to include private repositories. For a
GitHub App, its configured permissions further constrain the user token.
This grants Afe a user token; Afe only uses read APIs for resource authorization.
The OAuth state expires after ten minutes, is single-use and is bound to the
current tenant, Afe user and browser session. Provider errors and revoked/expired
credentials require the user to start linking again. Authorization codes and
state are excluded from HTTP request logs.

### Vercel OAuth

Configure a separate Vercel integration for personal account linking, with the
callback `https://<your-afe-host>/api/profile/tools/vercel/callback`. Set
`AFE_USER_VERCEL_CLIENT_ID`, `AFE_USER_VERCEL_CLIENT_SECRET` (or its `_FILE`
variant), and `AFE_USER_VERCEL_INTEGRATION_SLUG`, along with `AFE_PUBLIC_URL`.
Use read-only integration permissions. The user chooses the team and projects
during Vercel consent, so source grants can be narrower than their full Vercel
account. This personal installation is separate from the tenant's collection
integration. OAuth state is bound to the provider, tenant, user and browser
session, and exchanged once. The returned token's user must match the identity
in the OAuth exchange. Personal-token linking remains available as a fallback.

### ArgoCD and personal-token fallback

Vercel users link their own token, optionally scoped to a team. ArgoCD users
provide their own token and an existing Afe connection ID from their admin.
Afe validates the credential against that tool before saving it. ArgoCD uses
the existing connection URL and CA trust, and its normal safe-network policy.
Only one account per user per tool is currently supported; relinking replaces it.
ArgoCD browser SSO is available after an administrator configures a dedicated
OIDC client for that connection. See [ArgoCD browser SSO](self-hosting/argocd-sso.md)
for audience, issuer, PKCE and operator setup requirements. Personal tokens
remain available as a fallback. Arbitrary Google
sign-in is not treated as proof of GitHub, Vercel or ArgoCD resource access.
Google can be added as a tool when a Google integration defines its resources.

Terraform CLI reports have no personal upstream identity and remain unavailable
to managed users. Remote HCP Terraform/TFE workspace selections support verified
personal user-token links and inherited Source permissions. Read access is
separate from the explicit delivery-operation opt-in. See
[Terraform setup and permissions](terraform-actions.md#install-and-authorize).
Administrator observation of existing CLI reports remains unchanged.

SMTP and transactional email are optional and are not required for manual
provisioning or sign-in.

## Account settings

Administrators open **Account → Settings** (`/account/settings`) for account-level
configuration. **Email delivery** shows the configured sender, queues a test
email and lists recent delivery status. SMTP configuration remains operator-managed;
see [SMTP and account emails](self-hosting/email.md). Profile and Users remain
separate items under Account.

## Invitations and email recovery

Optional SMTP enables invitation and credential-reset emails from **Users**,
plus **Forgot your access credential?** on the sign-in page. Links expire and
are single-use; redemption generates a new credential and ends old sessions.
Manual provisioning remains available without email. See
[SMTP and account emails](self-hosting/email.md) for configuration, delivery
checks, retry behavior and sender verification.
