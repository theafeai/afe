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
| Deployments | Read   | `GET /v6/deployments`, `GET /v13/deployments/{id}`: the event data |

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
- `mapping.ts`, `capture.ts`, `polling.ts` (AFE-12): map deployments to
  canonical events, process deployment webhooks, poll, backfill and
  reconcile, and detect promotions and rollbacks. See
  docs/connectors/vercel.md "Event capture".
- `testing.ts`: `FakeVercelApi`, a local fake used in tests, and
  `MemoryVercelCaptureStore`.

## Optional action transport

`VercelActionClient` is separate from the GET-only observer. It is used only by
explicitly confirmed personal operations in [the capability matrix](../../docs/vercel-actions.md).
The server supplies a separate encrypted personal action token, narrowed by
current source user/team/project access and per-project operation consent.
Read needs User/Team/Projects/Deployments and project-domain/alias visibility;
write needs Deployments for deploy/redeploy/cancel/delete, Projects/production
traffic rights for promote/rollback, Aliases/Domains for assignment, Projects
write for the two configuration flags. Exact integration console labels vary;
this implementation does not request or upgrade OAuth integration permissions.
Owner is required by Afe for domain assignment/configuration, and upstream
role/token/plan restrictions remain authoritative for every operation.
The action transport has fixed API origin, bounded responses, a 15-second timeout,
manual redirects and no retries. Neither provider payloads nor token values are
returned in operational receipts. See [ADR 0017](../../docs/decisions/0017-vercel-delivery-actions.md).
