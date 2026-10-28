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

## Permission modes

Each user has a separate setting for GitHub, Vercel, ArgoCD and Terraform:

| Mode            | Access                                                          |
| --------------- | --------------------------------------------------------------- |
| none            | No access; omitted settings also mean none. The tool is hidden. |
| source          | The user's own linked tool account determines resource access.  |
| custom          | Only resources explicitly granted by the Afe administrator.     |
| source + custom | Union of current source access and administrator grants.        |

The current product is read-only. Custom grants therefore specify `read` and
one exact resource identifier per line:

- GitHub repository: `repository:owner/name` (case-insensitive).
- Vercel project: `project:prj_…` (project ID, not its display name).
- ArgoCD application: `application:app-name`.
- Whole Afe connection: `connection:<UUID>` (all that connection's events and
  connection health; choose this only when the whole connection is intended).

There are no wildcard grants. Sources are isolated, and correlated resources
do not independently confer access to an event. Event lists apply authorization
in SQL before pagination, and event details recheck the same rules. Upstream
ArgoCD grants also bind the application to its specific Afe connection.
A source grant to a repository/project/application does not expose whole
connection health, configuration or other resources on that connection.

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
own upstream accounts for tools whose mode includes source access. Credentials
are encrypted using Afe's existing key provider. Unlinking destroys their local
ciphertext. Afe never substitutes the administrator's integration credentials.
Source access is revalidated upstream when querying data; expiry, revocation,
network errors or rate limits fail closed for source access, while independent
custom grants still work. Large GitHub accounts are bounded to 5,000 repositories
per authorization check; exceeding this fails closed.

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

Terraform CLI reports have no personal upstream identity. Its source mode
therefore grants no access; use custom connection, repository or
`project:<workspace-name>` grants. Combined mode retains these custom grants.

SMTP and transactional email are optional and are not required for manual
provisioning or sign-in.

## Invitations and email recovery

Optional SMTP enables invitation and credential-reset emails from **Users**,
plus **Forgot your access credential?** on the sign-in page. Links expire and
are single-use; redemption generates a new credential and ends old sessions.
Manual provisioning remains available without email. See
[SMTP and account emails](self-hosting/email.md) for configuration, delivery
checks, retry behavior and sender verification.
