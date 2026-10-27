# Event query API

HTTP API for asking Afe what happened recently across your delivery tools
(AFE-14). Code: `apps/server/src/api/events.ts` (routes),
`packages/db/src/event-query.ts` (SQL), `packages/core/src/event-filter.ts`
(filter semantics).

Afe keeps events for a retention window (`AFE_EVENT_RETENTION_DAYS`, default
30 days, at most 60; [ADR 0008](decisions/0008-open-source-scope-without-audit-log.md)).
Older events are not returned because they are deleted. There is no export or
audit-verification endpoint.

## Authentication

Every `/api/*` route requires authentication ([ADR 0006](decisions/0006-api-authentication.md));
webhooks (`/webhooks/*`, signature-verified), `/healthz` and the static UI are
public. The tenant is always the authenticated principal's (OSS: `default`),
never a request parameter.

- **API clients:** `Authorization: Bearer <token>` with `AFE_ADMIN_TOKEN`
  (full access) or `AFE_VIEWER_TOKEN` (read-only).

  ```sh
  curl -H "Authorization: Bearer $AFE_ADMIN_TOKEN" http://127.0.0.1:8080/api/events
  ```

- **Web UI:** `POST /api/session` with `{"token": "..."}` sets an HttpOnly
  session cookie (`afe_session`, `Path=/api`, `SameSite=Lax`, `Secure` with an
  https `AFE_PUBLIC_URL`, default lifetime 12 h) and a readable `afe_csrf`
  cookie. Mutating requests made with the session cookie must send
  `X-Afe-CSRF: <afe_csrf value>`. `GET /api/session` returns the principal,
  `DELETE /api/session` logs out.
- Mutating requests with an `Origin` header must come from Afe's own origin.

| Endpoint                                                                             | Role   | Purpose                       |
| ------------------------------------------------------------------------------------ | ------ | ----------------------------- |
| `POST /api/session`, `DELETE /api/session`                                           | public | Log in with a token / log out |
| `GET /api/session`                                                                   | viewer | Who am I                      |
| `GET` events, deployments, connections, health                                       | viewer | Read                          |
| Create/test/disconnect connections, Vercel project selection (incl. listing)         | admin  | Change connections            |
| GitHub install, setup callback, App manifest flow; Vercel install and OAuth callback | admin  | Install flows                 |

Errors: `401 {"error":"unauthorized"}` without valid credentials (a browser
navigation is redirected to `/login?next=...` instead), `403
{"error":"forbidden"}` for a missing role or a cross-origin request, `403
{"error":"csrf_failed"}` for a missing/wrong CSRF token. Another tenant's
resources answer `404`.

## Endpoints

| Method and path           | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `GET /api/events`         | Filtered, paginated event list, each with provenance     |
| `GET /api/events/:id`     | One event: full canonical event, provenance, raw payload |
| `GET /api/events/:id/raw` | The raw source payload bytes (download, for debugging)   |
| `GET /api/deployments`    | "Who deployed what to where, and when" view across tools |

Errors: `400 {"error":"bad_request","message":...}` for invalid parameters
(including unknown parameters: a typo never silently widens a query),
`404 {"error":"not_found"}`.

## Filters

Shared by `/api/events` and `/api/deployments`. List
parameters can be repeated or comma-separated (`source=github,vercel`, at most
50 values). Values of one parameter are OR-ed; different parameters are
AND-ed.

| Parameter                                                         | Matches                                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `source`                                                          | `source` (`github`, `vercel`, `argocd`, `afe`, ...)                                                                   |
| `action`                                                          | exact action, or a prefix written `deployment.*`, `argocd.sync.*`                                                     |
| `actor`                                                           | id, or login (case-insensitive), of the actor **or** its `onBehalfOf` **or** `triggeredBy`                            |
| `actorId`, `actorLogin`                                           | the primary actor only (`actorLogin` case-insensitive)                                                                |
| `actorType`                                                       | `user`, `bot`, `token`, `system`, `unknown`                                                                           |
| `targetType`, `targetId`, `targetName`                            | `target.type` / `.id` / `.name`                                                                                       |
| `environment`                                                     | `target.environment` or `correlation.environments`, case-insensitive                                                  |
| `repository`                                                      | `target.repository` (case-insensitive) or `correlation.repositories`; `acme/api`, URLs and `host/owner/name` all work |
| `project`, `application`, `cluster`, `namespace`                  | the target field                                                                                                      |
| `ref`                                                             | `target.ref` or `correlation.refs`; `main` also matches `refs/heads/main` and `refs/tags/main`                        |
| `trigger` (`triggerType`)                                         | `trigger.type` (`push`, `manual`, `auto_sync`, `promotion`, ...)                                                      |
| `outcome`                                                         | `succeeded`, `failed`, `pending`, ...                                                                                 |
| `method` (`observationMethod`)                                    | provenance: `webhook`, `poll`, `reconciliation`, `backfill`, `stream`, `internal`                                     |
| `connectionId`, `sourceEventId`                                   | exact                                                                                                                 |
| `commitSha` (`commit`)                                            | full SHA exactly, or 7–39 hex characters as a prefix                                                                  |
| `imageRef`, `imageDigest`, `deploymentId`, `runId`, `pullRequest` | correlation keys (see [event model](event-model.md#correlation-keys))                                                 |
| `from` (`occurredFrom`), `to` (`occurredTo`)                      | `occurredAt` in `[from, to)`; ISO 8601 with offset                                                                    |
| `recordedFrom`, `recordedTo`                                      | `recordedAt` in `[from, to)`                                                                                          |
| `seqFrom`, `seqTo`                                                | per-tenant storage order (`seq`), inclusive                                                                           |

The pure function `eventMatchesFilter` in `@afe/core` is the reference
definition; the SQL selects exactly the same events (tested).

## Pagination

`GET /api/events` and `/api/deployments` take `order=desc|asc` (by
`occurredAt`, ties by `seq`; default `desc`), `limit` (1–500, default 100) and
`cursor`. Responses:

```json
{ "items": [...], "nextCursor": "eyJ2IjoxLC...", "snapshotSeq": 1234 }
```

Pass `nextCursor` back unchanged with the **same filters and order** to get
the next page; `null` means the end. The cursor is opaque (base64url JSON of
the last `(occurredAt, seq)`, the snapshot seq and a fingerprint of the
query); a cursor from a different query, or a malformed one, is rejected with 400. Changing a cursor cannot widen access: tenant and filters always come
from the request.

Stability: the first page pins the traversal to the tenant's latest `seq` at
that moment (`snapshotSeq`). Later pages only show events with
`seq <= snapshotSeq`, so events stored while you page — including late
arrivals with an older `occurredAt` found by reconciliation — never shift,
duplicate or skip rows. Start a new traversal (no cursor) to see them. Events
the retention purge deletes while you page simply do not appear on later
pages.

## Items and provenance

Each list item is `{ "event": <canonical event>, "provenance": {...} }`. The
`event` is exactly the stored canonical event (see
[event-model.md](event-model.md)).

```json
"provenance": {
  "source": "github",
  "sourceEventId": "deployment:1234567:status:987",
  "method": "reconciliation",
  "discoveredByReconciliation": true,
  "deliveryId": null,
  "jobId": "…",
  "connectionId": "conn_gh_1",
  "observedAt": "2026-10-01T10:00:05.000Z",
  "recordedAt": "2026-10-01T10:00:05.120Z"
}
```

## `GET /api/events/:id`

```json
{
  "event": { ... },
  "provenance": { ... },
  "rawPayload": {
    "id": "…", "sha256": "…", "contentType": "application/json", "sizeBytes": 2048,
    "receivedAt": "…", "url": "/api/events/<id>/raw"
  }
}
```

`rawPayload` is null for events Afe produced itself (observation gaps,
alerts).

## `GET /api/events/:id/raw`

Returns the raw payload bytes exactly as stored. Connectors strip secrets and
everything listed in [data-inventory.md](security/data-inventory.md) before
storing, so nothing secret is held here. The payload is a debugging aid and
is deleted together with its event. The response is always a download that a browser
will not render: `Content-Type` is the stored type only for
`application/json` / `text/plain` (otherwise `application/octet-stream`),
with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`
and a sandboxing CSP. Headers `X-Afe-Raw-Sha256` and
`X-Afe-Original-Content-Type` carry the stored digest and type.

## `GET /api/deployments`

The same filters and pagination, restricted (unless `action` is given) to the
deployment family across tools: `deployment.created`, `.status_updated`,
`.promoted`, `.rolled_back`, `.cancelled` and `argocd.sync.*`. Each item:

```json
{
  "eventId": "…", "seq": 17, "when": "2026-10-01T10:03:00.000Z",
  "source": "vercel", "action": "deployment.promoted", "outcome": "succeeded",
  "who":  { "type": "user", "id": "u_9", "login": "alice", "name": null, "onBehalfOf": null, "triggeredBy": null },
  "what": { "commitShas": ["…"], "refs": ["refs/heads/main"], "imageRefs": [], "imageDigests": [], "deploymentIds": ["vercel:dpl_1"] },
  "where": { "environment": "production", "targetType": "project", "targetId": "prj_1", "project": "web", "application": null, "cluster": null, ... },
  "how": { "type": "promotion" },
  "provenance": { "method": "reconciliation", ... }
}
```

### Examples: who deployed what to where, and when

```sh
# Everything that reached production last week, oldest first (within the retention window)
curl "$AFE/api/deployments?environment=production&from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z&order=asc"

# Successful deployments by alice (as actor, on-behalf-of or triggering user)
curl "$AFE/api/deployments?actor=alice&outcome=succeeded"

# Where did commit 4f2c9b8 go?
curl "$AFE/api/deployments?commitSha=4f2c9b8"

# ArgoCD syncs of the payments application that were not automated
curl "$AFE/api/deployments?source=argocd&application=payments&trigger=manual,api,cli"

# Deployments Afe only learned about through reconciliation (missed webhooks)
curl "$AFE/api/events?action=deployment.*&method=reconciliation"
```
