# Personal ArgoCD browser SSO

Afe's local dashboard login and ArgoCD identity are separate. Administrators
configure an OIDC client for each ArgoCD connection. Users assigned `source` or
`source + custom` permissions can then choose a configured connection in
**Profile → ArgoCD** and authenticate in their browser. ArgoCD's own RBAC decides
which applications the linked identity can read. Personal-token linking remains
available.

## Operator prerequisites

1. Deploy Afe with an HTTPS `AFE_PUBLIC_URL` origin, an encryption key, and an
   active ArgoCD connection. Apply migration 0029 before starting the updated
   server/worker. The existing read-only collection account stays separate from
   personal SSO identities.
2. Create a dedicated OIDC client at the **same trusted issuer ArgoCD uses**.
   Register this exact redirect URI (also shown on the connection detail page):

   ```text
   https://<afe-host>/api/profile/tools/argocd/callback
   ```

3. Enable the authorization-code grant with **S256 PKCE**. Public clients use
   `none` client authentication. Confidential clients may use
   `client_secret_basic` or `client_secret_post`; enter the secret in Afe's admin
   settings. Use only `openid` plus the `profile`, `email` and `groups` scopes
   actually supported and needed by the provider. No offline access or refresh
   tokens are requested/stored.
4. Configure ArgoCD to accept the issuer and the Afe client's ID-token audience.
   With direct OIDC, consult the installed ArgoCD version's
   `oidc.config.allowedAudiences` settings and retain its existing audiences.
   Arrange group claims and ArgoCD RBAC mappings for the intended applications.
   Do not grant broader access just to make a test succeed.
5. For Dex, configure a client/trust relationship that issues ID tokens ArgoCD
   will accept, using the issuer URL ArgoCD actually trusts (often the ArgoCD
   `/api/dex` issuer). Audience/trusted-peer configuration depends on the
   deployment. A generic Google login token or a client pointed at an unrelated
   issuer does not prove ArgoCD resource access. If your operator cannot issue an
   acceptable ID token, use personal-token linking until they provision the
   client. Afe does not alter the IdP or ArgoCD configuration.

ArgoCD and IdP versions/configuration vary. Validate audience/group handling
against the running installation. Afe verifies the ID token locally and asks
ArgoCD to accept that **same** token; both checks must pass. It does not infer
ArgoCD access from an email address, an OAuth access token, or Afe permissions.

## Configure in Afe

Open **Connections → your ArgoCD connection → Personal ArgoCD SSO**. Enter the
exact issuer from discovery, client ID, authentication method, required scopes,
and optional extra IdP CA certificates. For a confidential client, supply its
secret. Choose **Save SSO settings**. Afe checks discovery, endpoint safety,
code-flow/PKCE support and the advertised token authentication method before
saving. Use the public client option only if the provider advertises it.

The secret is write-only and encrypted in the tenant-bound credentials
repository. Blank means keep the current secret when issuer/client ID stay the
same; changing either requires a new explicit secret. A public-client switch or
**Disable browser SSO** destroys the old secret. Saving settings assigns a new
revision, invalidating earlier SSO grants and pending flows; users must relink.
Manual personal-token links are independent of the OIDC configuration.

Saving publishes this connection's **name and ID** as a sign-in choice to users
assigned ArgoCD source permissions in that tenant. It does not expose connection
URLs, client secrets, health, other connection settings or application names.
No choices are shown for `none` or `custom` mode. Only active configured
connections can be selected. A user currently links one ArgoCD account to one
connection; signing in again replaces that link.

Private IdP endpoints require `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true`.
Plain HTTP additionally requires `AFE_ALLOW_INSECURE_HTTP_TARGETS=true` and is
for labs only. TLS verification is always enabled. Use the optional IdP CA
bundle or `NODE_EXTRA_CA_CERTS`; the existing ArgoCD connection CA remains
separate. Discovered authorization/token/JWKS URLs are validated, DNS is checked
again on connect, redirects are refused, and requests have bounded timeouts and
response sizes. The public Afe callback origin still requires HTTPS.

## Verify the user flow

1. Give a test user ArgoCD `source` permission (or `source + custom`). Sign in to
   Afe with that user's local dashboard credential.
2. In **Profile**, choose the ArgoCD connection and select **Sign in with
   ArgoCD**. Complete consent at the configured identity provider and return to
   Profile. The displayed account name comes from ArgoCD's authenticated
   user-info endpoint.
3. Confirm that only applications the identity can read appear in Afe. Confirm
   another ArgoCD connection's events remain hidden. Test `none`, `custom` and
   combined mode separately. Authentication alone does not add custom grants.
4. Revoke access upstream and verify Afe's next read no longer receives source
   grants. Revocation follows ArgoCD's token acceptance/RBAC semantics: an IdP
   logout alone may leave an already issued JWT usable until it expires.
5. Disconnect the profile account. Source grants disappear; the local Afe login
   and any independent custom grants continue to work.

## Security and lifecycle

Flows expire after ten minutes and are bound to the tenant, user, browser
session, selected connection and settings revision. State is hashed; the random
PKCE verifier and nonce are encrypted in the credentials repository. The
callback consumes the state once and destroys its secret payload before token
exchange. A worker job hourly destroys expired flow payloads and removes their
metadata; starting another flow also cleans expired state for that tenant.
Unlinking or replacing the account invalidates pending flows, including a
callback whose network exchange is already running.

Afe requires a signed RS256, PS256 or ES256 ID token with the exact issuer,
client audience, nonce, subject, expiry and issued-at claims. Tokens must be
freshly issued (within ten minutes, allowing 30 seconds of clock tolerance).
Multiple audiences require the expected authorized party. JWKS keys come only
from the validated issuer's discovery, never from an untrusted token URL.
Tokens must then work against ArgoCD user-info and application-list read APIs.
SSO grants remain bound to that connection/revision and expire with the ID token.

There is no silent refresh: when the token expires, sign in again from Profile.
Each resource read still checks ArgoCD using the user's own token; failures grant
no source access. Provider errors and account tokens are not logged or returned
in API error bodies. OAuth callback query parameters are excluded from logs.
