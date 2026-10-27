# ADR 0006: API authentication, sessions and admin access

- Status: Accepted
- Date: 2026-10-27
- Issue: AFE-27

## Context

Every `/api/*` route (connection management, events query, export, raw
payloads, audit verification) had no authentication and acted on the
`default` tenant. ADR 0002 defines `AuthProvider` and `TenantResolver`
extension points; neither was wired. This must land before an instance is
reachable beyond localhost. The hosted service will replace the OSS
authentication with SSO and map users to tenants, so the server must take
the principal and tenant from the extension points only.

## Decision

### Extension point (`@afe/core`, `packages/core/src/auth.ts`)

```ts
interface AuthProvider {
  authenticate(req: { headers; cookies }): Principal | null | Promise<Principal | null>;
  isActive?(principal: Principal): boolean | Promise<boolean>;
}
interface Principal {
  id;
  tenantId;
  roles: ("admin" | "viewer")[];
  kind;
  name?;
}
```

No Fastify types in core. `isActive` lets a provider end sessions whose
principal is gone (rotated token, removed user).

OSS default `StaticTokenAuthProvider`: `AFE_ADMIN_TOKEN` (or `_FILE`) is the
admin; optional `AFE_VIEWER_TOKEN` is read-only. Both at least 32 characters,
no whitespace, distinct. Comparison is constant time (SHA-256 digests compared
with `timingSafeEqual`, both tokens checked on every call). Tenant is always
`default`. Principal ids are token fingerprints (truncated SHA-256 with a
label), never the token.

`TenantResolver` is now on `ServerContext` (`ctx.tenantResolver`). The server
default `principalTenantResolver` returns `principal.tenantId` and rejects a
request without a principal. Route handlers read the tenant only through
`requestTenant(req)` (apps/server/src/auth), which throws 401 if the auth hook
did not run, so a mis-wired route fails closed. The hard-coded
`DEFAULT_TENANT_ID` in API handlers is gone (it remains only for webhook
adoption of self-host GitHub installations and the manifest-registered App).

### Enforcement: one hook, a fail-closed route policy

`registerAuth` runs in `buildAfe` before any route is registered:

- An `onRoute` hook gives every route an access level, `public | viewer |
admin`, from `config.access` or `defaultRouteAccess(method, url)`:
  - outside `/api/` → `public` (webhooks verify signatures, `/healthz`, UI);
  - `/api/*` reads → `viewer`, except `ADMIN_READ_ROUTES` (GitHub install,
    setup callback, manifest and manifest callback; Vercel install, OAuth
    callback and project listing; export public key);
  - every other method → `admin` (create, disconnect, test, project selection).
  - Explicit: `POST`/`DELETE /api/session` public (login/logout),
    `POST /api/audit/anchors/verify` viewer (it only checks supplied receipts).
- An `onRequest` hook authenticates every request whose route is not public,
  including unknown `/api/*` paths (a 404 does not reveal which routes exist).
  It calls the provider first, then Afe's session cookie; sets `req.principal`
  and `req.tenantId`; answers 401 (JSON with `WWW-Authenticate: Bearer`) or 403
  (role). A browser navigation (`GET`, `Accept: text/html`) without a session
  is redirected to `/login?next=<path>` when the UI is served, so the GitHub
  and Vercel callbacks the browser reaches after a redirect still require the
  session, and resume after login.
- `buildAfe` returns `routes` (method, url, access). The test suite enumerates
  them: every non-public `/api` route must answer 401 unauthenticated, 403 for
  the viewer if admin, and 404 for another tenant's id. A new route is covered
  without touching the tests.

### Web UI sessions

`POST /api/session {"token": ...}` checks the token with the provider and
sets:

- `afe_session`: `v1.<base64url(JSON)>.<base64url(HMAC-SHA256)>`, payload
  principal id/tenant/roles, issue and expiry time (default 12 h,
  `AFE_SESSION_TTL`) and a random CSRF token. `HttpOnly; SameSite=Lax;
Path=/api`, `Secure` when `AFE_PUBLIC_URL` is https (or the request is).
  It never contains the token.
- `afe_csrf`: the same CSRF token, readable by the UI (`Path=/`, not HttpOnly).

`GET /api/session` returns the principal; `DELETE /api/session` clears both
cookies. The UI keeps nothing in localStorage.

Session HMAC key: `AFE_SESSION_SECRET` (≥ 32 chars) when set; otherwise
derived from the admin and viewer tokens (HMAC with a fixed label). We chose
token derivation over the `KeyProvider` because `KeyProvider` only wraps keys
(randomised AES-GCM, no deterministic derivation) and a KMS-backed provider
should not be called per request. Consequences: rotating a token ends every
session; with `AFE_SESSION_SECRET` set, `isActive` still rejects sessions of a
rotated token. With a custom provider and neither secret nor tokens, a random
per-process key is used (sessions end at restart).

Sessions are stateless: logout clears the browser's cookies but a copied
cookie stays valid until expiry. Revoke all sessions by rotating
`AFE_SESSION_SECRET` (or the token). A server-side session table can be added
later without changing the cookie contract.

### CSRF

Chosen: **double-submit token bound to the session** plus an Origin check.

- A mutating request authenticated by the session cookie must send
  `X-Afe-CSRF` equal to the session's CSRF token (constant-time). A cookie
  planted from a sibling subdomain cannot match the signed session.
- Any mutating `/api/*` request with an `Origin` header must be same-origin:
  equal to `AFE_PUBLIC_URL`'s origin, else its host must equal the `Host`
  header. `Origin: null` is rejected. This also protects the login endpoint
  (login CSRF) and bearer clients that run in a browser.
- Bearer-token requests need no CSRF token. `SameSite=Lax` additionally keeps
  the session cookie off cross-site subresource requests, and JSON bodies need
  `Content-Type: application/json` (other types are rejected with 415).

A strict Origin check alone was rejected: older browsers and some proxies
omit `Origin`, and it is easy to misconfigure behind a proxy without
`AFE_PUBLIC_URL`.

### Startup safety

Chosen: **refuse to start unless bound to loopback**, and on loopback generate
a one-time token. Without `AFE_ADMIN_TOKEN`, `afe server` / `afe all` exit with
an error when `AFE_HOST` is not a loopback address. On loopback they generate
a random admin token for that process and print it once to stderr (not to the
JSON log). Nothing is ever served without authentication, and no generated
token ends up in the logs of an exposed server. The docker-compose setup
listens on `0.0.0.0` inside the container, so it requires the token (a Docker
secret, like the encryption key). `afe worker` serves no HTTP and needs no
token. `buildAfe` without any token rejects every `/api` request.

### GitHub installer verification (hosted)

The setup URL's `installation_id` can be edited by anyone who completes an
install flow (AFE-6 finding). With `AFE_GITHUB_VERIFY_INSTALLER=true` (plus
`AFE_GITHUB_APP_CLIENT_ID` and `AFE_GITHUB_APP_CLIENT_SECRET[_FILE]`, and
"Request user authorization (OAuth) during installation" enabled on the App),
the setup callback exchanges the `code` GitHub sends for a user token, checks
the installation id is in `GET /user/installations`, revokes the token
(`DELETE /applications/{client_id}/token`) and only then connects. Missing or
invalid code → 403. Self-host default is unchanged (off); the remaining risk
there is limited by the signed, browser-bound state, the admin session
requirement, the "installation predates this flow" check and the single
tenant. In addition, the setup callback now requires the admin session of the
tenant that started the flow.

## Consequences

- API clients send `Authorization: Bearer <token>`.
- New `/api` routes are authenticated by default; making one public needs an
  explicit `config: { access: "public" }`, visible in review.
- The hosted build supplies `createAfe({ authProvider, tenantResolver,
sessionSecret })`.
- No login rate limiting: a 32+ character random token is not guessable;
  put a reverse proxy rate limit in front if the API is exposed.

## To verify against docs

- GitHub sends `code` to the setup URL when "Request user authorization
  (OAuth) during installation" is enabled, and the setup URL is then not used
  as the OAuth callback:
  https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-the-setup-url
- Code exchange `POST https://github.com/login/oauth/access_token` with JSON
  and `Accept: application/json`, errors as 200 with `error`:
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- `GET /user/installations` lists only installations of the App whose user
  token is used, including org installations where the user is an owner:
  https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token
- Token revocation endpoint and Basic auth:
  https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token
