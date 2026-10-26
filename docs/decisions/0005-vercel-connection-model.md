# ADR 0005: Vercel connection model

- Status: Accepted
- Date: 2026-10-26
- Issue: AFE-11

## Context

Afe must read Vercel deployments for the teams and projects a user chooses,
receive deployment webhooks, and notice when access is withdrawn. Security rule
R1 (docs/security/rules.md) requires the narrowest, read-only access a tool
allows. Vercel offers two ways for a third party to call its API on a user's
behalf:

1. A **Vercel Integration** (OAuth2). The user installs the integration on a
   personal account or team and picks "all projects" or specific projects. Afe
   exchanges the returned `code` for an installation-scoped token at
   `POST https://api.vercel.com/v2/oauth/access_token`.
2. An **access token** the user creates in Account Settings > Tokens, optionally
   scoped to one team and given an expiry.

The Vercel docs were not reachable while writing this ADR. The shapes and
names below come from our knowledge of the docs listed under References. Items
we are not sure of are in "To verify against the docs".

## Options

| Criterion                   | Vercel Integration (OAuth)                                                                                           | Access token (team-scoped)                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Granularity                 | Per-resource permissions set in the Integration Console, with read or read/write per resource                        | None. Full access to everything in its scope (account or one team), with the creator's role          |
| Read-only possible          | Yes, for the resources Afe needs (to be confirmed, see below)                                                        | No. This is a documented exception to R1                                                             |
| Project limitation          | Yes. The installer can grant only specific projects, and Afe adds its own project selection on top                   | No. Only Afe's own selection limits it                                                               |
| Who holds the secret        | Afe stores a token it got itself. The user never copies a secret                                                     | The user copies a powerful token into Afe                                                            |
| Revocation visible to Afe   | `integration-configuration.removed` webhook on uninstall, plus 401/403 from the API                                  | 401/403 from the API only                                                                            |
| Webhooks                    | Webhook URL and events set in the Integration Console, signed with the client secret. No API write permission needed | The user creates an account webhook in the dashboard (Pro/Enterprise) and pastes its secret into Afe |
| Setup cost for self-hosters | Must create their own integration (console form, client id and secret, slug) and expose a public callback URL        | Paste a token                                                                                        |

## Decision

1. **Primary path: a Vercel Integration (OAuth).** The hosted service ships one
   integration. Self-hosters may create their own and configure it with
   `AFE_VERCEL_CLIENT_ID`, `AFE_VERCEL_CLIENT_SECRET` (or `_FILE`),
   `AFE_VERCEL_INTEGRATION_SLUG` and `AFE_PUBLIC_URL`.
2. **Fallback: a user-created access token**, for self-hosters who will not
   create an integration. The API and docs warn every time that the token
   cannot be read-only. Users are told to scope it to one team, set an expiry,
   and create it as a member with the least-privileged role. Afe only ever
   sends `GET` with it.
3. **Connection identity:** `externalId` is the Vercel team id, or the user id
   for a personal account. `connections.config` holds `mode`
   (`integration`|`token`), `teamId`, `userId`, `configurationId` (integration
   only) and `projectSelection`. Tokens and webhook secrets live only in
   `credentials` (roles `access_token` and `webhook_secret`). No new table or
   migration is needed.
4. **Project selection:** a new connection observes **no** projects. The user
   picks project ids, or explicitly picks `all`. The selection is enforced in
   code. `ScopedVercelReader` never requests an unselected project's data, and
   the webhook receiver does not queue events for unselected projects. With the
   integration path this sits on top of Vercel's own per-installation project
   limitation.
5. **Revocation:**
   - A 401/403 from any Vercel call marks the connection `revoked`, with a
     reason. This covers revoked or expired tokens, a removed integration, and
     lost team access.
   - `integration-configuration.removed` revokes the stored credentials and
     marks the connection `revoked`.
   - User disconnect (`DELETE`) revokes Afe's credentials and marks the
     connection `disconnected`. For integrations, Afe also tries to delete its
     own configuration (`DELETE /v1/integrations/configuration/{id}`). If that
     fails, the user is told to remove the integration in Vercel. For tokens,
     the user is told to delete the token in Vercel.
6. **Auth-lifecycle exception to "GET only":** two non-GET calls exist, both in
   `oauth.ts` and kept apart from the read-only `VercelClient`. One is the OAuth
   code exchange (POST). The other removes Afe's own installation on disconnect
   (DELETE). Neither touches customer resources. Tests assert that no other
   method is used.

## Permissions Afe requests (integration)

Configure these in the Integration Console. Request nothing else.

| Permission (console name, to verify) | Access | Why                                                                                                                                                    |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User                                 | Read   | `GET /v2/user`: identify the installing account (personal-account connections, actor ids)                                                              |
| Team                                 | Read   | `GET /v2/teams/{id}`: team name for the connection; the health probe                                                                                   |
| Projects                             | Read   | `GET /v9/projects`: list projects for selection; map deployments to projects                                                                           |
| Deployments                          | Read   | `GET /v6/deployments`, `GET /v13/deployments/{id}`: the audit data itself (AFE-12)                                                                     |
| Webhooks (Integration Console URL)   | n/a    | Deployment events (`deployment.created`, `.succeeded`, `.error`, `.canceled`, `.promoted`) and `project.removed`, delivered to `POST /webhooks/vercel` |

**Webhooks without a write permission.** Afe does **not** create webhooks
through the API, which would need a write-level "Webhooks" permission. It uses
the webhook URL and event list configured once in the Integration Console.
Vercel sends `integration-configuration.*` lifecycle events to that URL for
every integration. If an installation's events stop arriving, AFE-12 polling
(`GET /v6/deployments?since=`) still observes deployments, so webhooks speed
things up but correctness does not depend on them. For token connections,
webhooks are optional. The user creates an account webhook in the dashboard,
pointing at `POST /webhooks/vercel/<team or user id>`, and gives Afe its secret.
Without one, Afe relies on polling.

**Access token fallback:** no scopes exist, so this path is an exception to R1
(already listed in docs/security/rules.md R1.3).

## Consequences

- Hosted onboarding is a single "Connect Vercel" click. Self-hosters can choose
  between creating an integration (better) and pasting a token (simpler).
- The OAuth `state` is signed: HMAC-SHA256 with a key derived from the client
  secret, a 10-minute expiry, and the tenant id. It is also bound to the
  browser with an HttpOnly cookie nonce. An installation started from the
  Vercel marketplace, rather than from Afe, has no state and is refused with a
  message to start from Afe.
- Webhook receipt: the `x-vercel-signature` HMAC-SHA1 is checked over the raw
  body, then the signed `createdAt` must be within 5 minutes, then the delivery
  `id` is recorded with `recordDelivery` (replays get 2xx and are dropped).
  Lifecycle events are applied inline (DB only). Other events are queued as
  `vercel.webhook`. Their handler is a placeholder until AFE-12, which maps and
  ingests them.
- API routes take the tenant from an injectable `resolveTenant`. It defaults to
  the single self-host tenant until API authentication exists.

## To verify against the docs

1. Exact Integration Console permission names, and that **read-only** levels
   exist for Deployments, Projects, Team and User. If Deployments is not
   available read-only, document the exception the same way as for tokens.
2. That the console-configured webhook needs no extra permission, and the
   exact event names (`deployment.canceled` vs `deployment.cancelled`,
   `deployment.error`).
3. The `integration-configuration.removed`, `.permission-upgraded` and
   `.scope-change-confirmed` payload shapes (`payload.configuration.id`,
   `payload.configuration.projects`, `payload.team.id`, `payload.user.id`), and
   whether the legacy `payload.teamId`/`payload.userId` shape still appears.
4. That integration webhooks are signed with the **client secret** and account
   webhooks with the secret shown at creation (HMAC-SHA1 hex, no prefix).
5. Vercel's webhook retry schedule, and whether retries keep the original
   `createdAt`. If retries span more than 5 minutes, widen
   `webhookToleranceMs`.
6. That `state` is passed back unchanged to the redirect URL from
   `https://vercel.com/integrations/<slug>/new?state=…`, and the callback query
   parameters (`code`, `configurationId`, `teamId`, `next`).
7. The OAuth exchange response fields (`access_token`, `installation_id`,
   `user_id`, `team_id`) and that `redirect_uri` must match exactly.
8. That an integration token may call `DELETE /v1/integrations/configuration/{id}`
   on its own configuration.
9. Pagination for `/v9/projects` and `/v2/teams`: that `pagination.next` is
   passed back as `until` (as for deployments), and the maximum `limit`.
10. That rate-limit headers are `x-ratelimit-limit`, `x-ratelimit-remaining`
    and `x-ratelimit-reset` (epoch seconds), and that list items of
    `/v6/deployments` carry `projectId`.

## References

- Integrations: https://vercel.com/docs/integrations/create-integration
- OAuth code exchange: https://vercel.com/docs/integrations/create-integration/submit-integration
- Integration permissions: https://vercel.com/docs/integrations/create-integration/integration-permissions
- Webhooks and signature: https://vercel.com/docs/webhooks/webhooks-api#securing-webhooks
- REST API (pagination, rate limits): https://vercel.com/docs/rest-api
- Endpoints: https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments,
  https://vercel.com/docs/rest-api/reference/endpoints/projects/retrieve-a-list-of-projects
- Access tokens: https://vercel.com/docs/rest-api#creating-an-access-token
