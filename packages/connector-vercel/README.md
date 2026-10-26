# @afe/connector-vercel

Pure Vercel logic: a read-only REST client, OAuth helpers, project selection and
webhook verification. The server wiring lives in `apps/server/src/connectors/vercel.ts`.

Design: [ADR 0005](../../docs/decisions/0005-vercel-connection-model.md).
User guide: [docs/connectors/vercel.md](../../docs/connectors/vercel.md).

## Permissions requested (rule R1.2)

| Permission  | Access | Why                                                                |
| ----------- | ------ | ------------------------------------------------------------------ |
| User        | Read   | `GET /v2/user`: identify the account                               |
| Team        | Read   | `GET /v2/teams/{id}`: name and health probe                        |
| Projects    | Read   | `GET /v9/projects`: project selection                              |
| Deployments | Read   | `GET /v6/deployments`, `GET /v13/deployments/{id}`: the audit data |

There is no webhook write permission: webhooks are configured in the
Integration Console. Access-token connections have no scopes, which is the
documented exception in docs/security/rules.md R1.3.

## Modules

- `VercelClient`: issues only `GET` requests. It reads the token at use time,
  honours `x-ratelimit-*` (bounded 429/5xx retries), follows `pagination.next`
  through `until`, does not follow redirects, applies a timeout and a response
  size limit, and strips `env`.
- `ScopedVercelReader`: enforces the connection's `ProjectSelection` before
  every request.
- `oauth.ts`: `buildInstallUrl`, `exchangeOAuthCode`,
  `deleteIntegrationConfiguration`, and signed `state`. These are the only
  non-GET calls, and they manage auth only.
- `webhook.ts`: `verifyVercelWebhook` (HMAC-SHA1 over the raw body through
  `verifyVercelSignature`, plus a `createdAt` freshness check) and lifecycle
  event types.
- `testing.ts`: `FakeVercelApi`, a local fake used in tests.
