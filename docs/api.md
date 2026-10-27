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

| Method and path                                       | Purpose                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/events`                                     | Filtered, paginated event list, each with provenance                                       |
| `GET /api/events/:id`                                 | One event: full canonical event, provenance, raw payload                                   |
| `GET /api/events/:id/raw`                             | The raw source payload bytes (download, for debugging)                                     |
| `GET /api/deployments`                                | "Who deployed what to where, and when" view across tools                                   |
| `/api/mapping/...`                                    | Environment and service mapping (see [below](#environment-and-service-mapping))            |
| `GET /api/containment`                                | Is commit X included in what is live, per environment (see [below](#commit-containment))   |
| `GET /api/environments/state`                         | What is live where: service × environment matrix (see [below](#environments-and-journeys)) |
| `GET /api/environments/:service/:environment/history` | Placements of one matrix cell over time, with their causes                                 |
| `GET /api/journeys`                                   | Where a commit went: change → CI → artifact → config → deploy → runtime                    |
| `GET /api/events/:id/links`                           | Events related to one event, with typed evidence and confidence                            |
| `/api/drift/...`                                      | Drift and untracked deploy findings, settings (see [below](#drift-findings))               |

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
  "provenance": { "method": "reconciliation", ... },
  "placement": {
    "service": { "id": "web", "name": "Web" },
    "environment": { "id": "production", "name": "Production", "kind": "production", "order": 10 },
    "confidence": "configured", "matchedRuleIds": ["…", "…"], "unmapped": []
  }
}
```

`placement` (AFE-19) is resolved with the tenant's current
[environment and service mapping](environment-mapping.md) when the page is
read; it is not part of the event and changes when the mapping changes. A
dimension no rule assigns is `null` and listed in `unmapped`; `confidence` is
`configured`, `default` (a built-in rule decided), `partial` or `unmapped`.

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

## Commit containment

`GET /api/containment?repository=<owner/name>&commit=<sha>` (viewer, AFE-22):
for every environment where the GitHub repository is live (latest successful
deployment, promotion, rollback or ArgoCD sync within the retention window),
is `commit` included in the live commit? Details, permissions and limits:
[containment.md](containment.md).

- `repository`: `owner/name`, `github.com/owner/name` or a GitHub URL.
- `commit`: 7 to 64 hex characters (a full SHA is best).

```json
{
  "repository": "acme/web",
  "commit": "4f2c9b8…",
  "checkedAt": "2026-10-27T10:00:00.000Z",
  "partial": false,
  "notes": ["placements since 2026-09-27T10:00:00.000Z (retention window) were considered"],
  "environments": [
    {
      "environment": "Production",
      "environmentId": "production",
      "source": "github",
      "liveCommit": "9d1e…",
      "liveSince": "2026-10-26T09:12:00.000Z",
      "contained": true,
      "reasonCode": "ancestor",
      "reason": "the live commit is 3 commit(s) ahead and includes this commit",
      "evidence": ["<event id>", "<event id>"],
      "comparison": { "status": "ahead", "aheadBy": 3, "behindBy": 0, "mergeBaseSha": "4f2c…" },
      "cached": false
    }
  ]
}
```

- `contained`: `true`, `false` or `"unknown"`; `reasonCode`/`reason` say why
  (e.g. `missing_permission`, `commit_not_found`, `rate_limited` with
  `retryAfter`, `timeout`, `not_checked_limit`).
- `environment` is the mapped environment name ([mapping](environment-mapping.md)),
  else the tool's own name; `environmentId` is null when unmapped.
- `evidence`: ids of the placement events (newest first) behind `liveCommit`
  and `liveSince`.
- `partial: true` when the request did not check everything (time budget,
  environment limit, rate limit) or not all placements were read; `notes`
  explain.
- `404 {"error":"not_found"}` when the tenant has neither recent placements
  of the repository nor a GitHub connection covering it (also for another
  tenant's repository). `400` for invalid parameters.

## Environments and journeys

Correlation (AFE-20, viewer access, tenant of the caller). How it works, the
confidence model and the measurements: [correlation.md](correlation.md).
Every response has `window`: `{from, to, events, asOfSeq, stale, truncated,
computedAt}`: the retention window the answer is computed from, the newest
event `seq` it reflects, and whether newer events are not reflected yet
(recompute is throttled for busy tenants). Unknown query parameters answer
`400`. Confidence is one of `certain`, `strong`, `probable`, `weak`, always
shown with its evidence (`via`, `evidence[]`, `notes`).

### `GET /api/environments/state`

The environment matrix. Query: `service`, `environment` (an id, or
`_unmapped`), `source` (`github`, `argocd`, `vercel`), `targets` (targets per
cell, 1–100, default 20).

```json
{
  "asOf": "2026-10-27T10:00:00.000Z",
  "window": { "from": "2026-09-27T10:00:00.000Z", "asOfSeq": 4182, "stale": false, "...": "..." },
  "services": [
    { "id": "shop-api", "name": "Shop API", "unmapped": false },
    { "id": "_unmapped", "name": "Unmapped", "unmapped": true }
  ],
  "environments": [
    {
      "id": "production",
      "name": "Production",
      "kind": "production",
      "order": 10,
      "unmapped": false
    }
  ],
  "cells": [
    {
      "service": "shop-api",
      "environment": "staging",
      "unmapped": false,
      "status": "attributed",
      "confidence": "probable",
      "since": "2026-10-21T14:05:40.000Z",
      "contentSince": "2026-10-21T14:05:40.000Z",
      "consistent": true,
      "gap": { "flagged": false, "evidenceInGap": false, "possiblyStale": false },
      "live": {
        "targetKey": "argocd:argocd/shop-api-staging",
        "label": "shop-api-staging",
        "eventId": "…",
        "at": "2026-10-21T14:05:40.000Z",
        "source": "argocd",
        "action": "argocd.sync.succeeded",
        "kind": "deploy",
        "how": "auto_sync",
        "actor": null,
        "deploymentIds": ["argocd:argocd/shop-api-staging:12"],
        "deploymentUrls": [],
        "configRevision": { "repository": "github.com/acme/shop-deploy", "commitSha": "…" },
        "images": [
          {
            "ref": "ghcr.io/acme/shop-api:4f2c9b8",
            "builds": [
              {
                "eventId": "…",
                "commitSha": "…",
                "repository": "github.com/acme/shop",
                "confidence": "probable"
              }
            ]
          }
        ],
        "commits": [
          {
            "repository": "github.com/acme/shop",
            "commitSha": "…",
            "confidence": "probable",
            "via": "ghcr.io/acme/shop-api:4f2c9b8 built by … (tag match)"
          }
        ],
        "attribution": { "status": "attributed", "confidence": "probable" },
        "notes": [],
        "evidenceEventIds": ["…"],
        "gaps": []
      },
      "targets": [
        {
          "key": "argocd:argocd/shop-api-staging",
          "source": "argocd",
          "label": "shop-api-staging",
          "toolEnvironment": "staging",
          "mapping": {
            "confidence": "default",
            "matchedRuleIds": ["…", "builtin:…"]
          },
          "current": { "...": "placement as in live" },
          "since": "…",
          "contentSince": "…",
          "history": {
            "placements": 2,
            "byKind": { "deploy": 2 },
            "previous": { "eventId": "…", "at": "…", "kind": "deploy", "commits": ["…"] }
          }
        }
      ],
      "targetsOmitted": 0,
      "historyUrl": "/api/environments/shop-api/staging/history"
    }
  ]
}
```

- Rows/columns are the tenant's services and environments (all of them, in
  mapping order) plus `_unmapped` when a target is not mapped. Only cells
  with placements are listed.
- `status`: `attributed`, `ambiguous` (several candidate commits, mutable
  tag), `guess` (no Git metadata, weak time-proximity guess), `unknown`
  (nothing traces to a commit, e.g. a manually overridden image).
- `kind`: `deploy`, `promotion`, `rollback`, `redeploy`, `manual`.
- `gaps[]` per placement: `{gapId, source, connectionId, startedAt, endedAt,
reason, relation, eventId}`, `relation` `evidence_in_gap` or
  `after_placement` (possibly stale).

### `GET /api/environments/:service/:environment/history`

Placements of one cell (all its targets), newest first. `:service` and
`:environment` are mapping ids or `_unmapped`; unknown ids answer `404`.
Query: `limit` (1–200, default 50), `cursor` (from `nextCursor`; bound to the
cell), `target` (one target key).

```json
{
  "service": { "id": "web", "name": "Web", "unmapped": false },
  "environment": {
    "id": "production",
    "name": "Production",
    "kind": "production",
    "order": 10,
    "unmapped": false
  },
  "targets": [
    {
      "key": "vercel:web:production",
      "source": "vercel",
      "label": "web",
      "toolEnvironment": "production",
      "currentEventId": "…",
      "placements": 7
    }
  ],
  "total": 8,
  "items": [
    {
      "target": { "key": "vercel:web:production", "source": "vercel", "label": "web" },
      "current": false,
      "change": "new_content",
      "previousEventId": "…",
      "placement": { "kind": "rollback", "...": "as in the matrix" },
      "event": {
        "id": "…",
        "source": "vercel",
        "action": "deployment.rolled_back",
        "at": "…",
        "outcome": "succeeded",
        "actor": "alice",
        "trigger": "rollback",
        "target": { "type": "project", "id": "prj_…", "label": "web" },
        "url": "/api/events/…"
      },
      "causes": [
        {
          "event": { "...": "…" },
          "stage": "deploy",
          "confidence": "certain",
          "evidence": [{ "kind": "same_deployment", "key": "deployment:vercel:dpl_…" }]
        }
      ]
    }
  ],
  "nextCursor": "…"
}
```

`change`: `first`, `new_content` or `same_content` (a restart/redeploy of the
same commits and images). `causes`: up to 8 linked earlier events that are
changes, config edits, artifacts or the same deployment (e.g. the PR that
bumped the GitOps repository, the deployment a rollback made live again).

### `GET /api/journeys?repository=&commit=`

The journey of one commit. `repository`: `owner/name`, `host/owner/name` or a
URL; `commit`: 7–64 hex characters (a prefix must be unique within the
repository in the window, else `400` with `candidates`). Optional:
`include=containment`, `maxSteps` (1–2000, default 300). `404` when no event
in the window carries the commit in that repository.

```json
{
  "window": { "...": "…" },
  "journey": {
    "id": "github.com/acme/shop@…",
    "repository": "github.com/acme/shop",
    "commitSha": "…",
    "ref": "refs/heads/main",
    "startedAt": "…",
    "root": { "id": "…", "action": "ref.pushed", "...": "…" },
    "stages": [
      { "stage": "change", "steps": ["<event id>"] },
      { "stage": "ci", "steps": ["…"] }
    ],
    "steps": [
      {
        "eventId": "…",
        "stage": "artifact",
        "confidence": "certain",
        "reachedFrom": "…",
        "via": [{ "kind": "same_run", "confidence": "certain", "key": "run:github:…" }],
        "event": { "...": "…" }
      }
    ],
    "edges": [
      {
        "from": "…",
        "to": "…",
        "confidence": "probable",
        "evidence": [
          {
            "kind": "same_image_tag",
            "confidence": "probable",
            "key": "image:ghcr.io/acme/shop-api:4f2c9b8"
          }
        ]
      }
    ],
    "environments": [
      {
        "environmentKey": "argocd:argocd/shop-api-production",
        "placementEventId": "…",
        "at": "…",
        "confidence": "strong",
        "current": false,
        "via": "attribution",
        "target": {
          "key": "argocd:argocd/shop-api-production",
          "source": "argocd",
          "label": "shop-api-production"
        },
        "service": "shop-api",
        "environment": "production",
        "event": { "...": "…" }
      }
    ],
    "excluded": [
      {
        "eventId": "…",
        "reason": "deployed images do not trace to this commit (e.g. image overridden outside Git)",
        "event": { "...": "…" }
      }
    ],
    "continuesAs": [
      {
        "journeyId": "github.com/acme/web@…",
        "repository": "github.com/acme/web",
        "commitSha": "…",
        "relation": "merged_as",
        "eventId": "…"
      }
    ],
    "conflicts": [],
    "gaps": [],
    "truncated": false,
    "containment": null
  }
}
```

- `stages` are in flow order (`change`, `ci`, `artifact`, `config`,
  `deploy`, `runtime`, `other`), only those with steps.
- `environments[].via`: `attribution`, `config_revision` (the GitOps revision
  synced), `reached` (unattributed placement reached through links) or
  `containment`.
- `continuesAs[].relation`: `merged_as`, `included_in` (pushed together, the
  other commit is the head), `later_commit`.
- `include=containment`: checks (at most 5) whether the commit is included in
  the live commit of current placements of the same repository
  ([commit containment](#commit-containment)); `containment` then lists
  `{placementEventId, liveCommitSha, contained, reason, environmentKey}` and
  included ones appear in `environments` with `via: "containment"`. Without
  it `containment` is `null` and no GitHub call is made.

### `GET /api/events/:id/links`

Events linked to one event, strongest first. Query: `limit` (1–200,
default 50).

```json
{
  "eventId": "…",
  "inWindow": true,
  "window": { "...": "…" },
  "total": 12,
  "links": [
    {
      "direction": "earlier",
      "confidence": "certain",
      "evidence": [
        { "kind": "same_deployment", "confidence": "certain", "key": "deployment:vercel:dpl_…" }
      ],
      "event": { "...": "…" }
    }
  ],
  "conflicts": [],
  "placement": null
}
```

`direction`: whether the other event is `earlier` or `later`. Hot keys (more
than 24 events share a commit, digest, tag, …) are linked as a chain plus
the first event, so an event in such a bucket lists its neighbours, not every
member (see [correlation.md](correlation.md#linking-core)). `placement` is
set when the event put something live (as in the matrix, plus its `target`
and whether it is `current`). `404` for unknown ids and other tenants'
events; `inWindow: false` for events without correlation keys.

## Drift findings

Drift and untracked deploy detection (AFE-26): placements whose content does
not trace to Git. How findings are derived, resolved, alerted and retained:
[drift.md](drift.md). Reads are viewer access, `PUT /api/drift/settings` is
admin; everything is scoped to the caller's tenant (another tenant's finding
id answers `404`). Reads first bring the findings up to date with the
correlation window (cheap when nothing changed). Unknown query parameters
answer `400`.

### `GET /api/drift/findings`

Most recently seen first. Filters (all optional): `status` (`open`,
`resolved`, `all`; default `all`), `type` and `severity` (comma-separated),
`service` and `environment` (mapping ids or `_unmapped`), `target` (a
correlation target key, e.g. `argocd:argocd/shop-api-production`), `limit`
(1–200, default 50), `cursor` (from `nextCursor`).

```json
{
  "evaluatedAt": "2026-10-27T10:00:00.000Z",
  "counts": { "open": 3, "resolved": 1 },
  "findings": [
    {
      "id": "…",
      "type": "manual_override",
      "severity": "high",
      "status": "open",
      "title": "Manual image override on shop-api-production",
      "explanation": "The ArgoCD Application's image/parameter overrides were changed outside Git (via cli by alice), pointing at ghcr.io/acme/shop-api:hotfix-1022. 1 sync ran the overridden content.",
      "target": {
        "key": "argocd:argocd/shop-api-production",
        "source": "argocd",
        "label": "shop-api-production",
        "toolEnvironment": "production"
      },
      "service": { "id": "shop-api", "name": "Shop API" },
      "environment": { "id": "production", "name": "Production" },
      "firstSeenAt": "…",
      "lastSeenAt": "…",
      "resolvedAt": null,
      "openingEventId": "…",
      "resolvedByEventId": null,
      "evidenceCount": 2,
      "url": "/api/drift/findings/…"
    }
  ],
  "nextCursor": null
}
```

`counts` are per status with the other filters applied. `type`:
`manual_override`, `untracked_deploy`, `unknown_image`,
`ambiguous_attribution`, `out_of_band_change` (open set: extra detectors may
add types). `severity`: `info`, `low`, `medium`, `high`, `critical`.
`service`/`environment` are `null` when unmapped.

### `GET /api/drift/findings/:id`

`{ "finding": { ... } }`: the summary fields plus

- `evidence[]`: `{eventId, role, at, summary, available, url}`. `role`:
  `override`, `placement`, `build`, `conflict`, `git_deploy`, `related`,
  `resolution`. `available: false` and `url: null` when the event was purged
  by retention (the summary is kept). `evidenceOmitted`: entries not listed.
- `eventsPurged`: how many referenced events are no longer stored.
- `latestEventId`, `details` (type-specific: images, override fields,
  commits, the Git deploy compared with…), `journeys[]`
  (`{repository, commitSha, url}` → `GET /api/journeys`).
- `alert`: `{enabled, typeAlertsNow, openedNotifiedAt, resolvedNotifiedAt}`.
- `detectedAt`, `updatedAt`.

### `GET /api/drift/summary`

Open findings for an environment matrix badge:

```json
{
  "evaluatedAt": "…",
  "open": 3,
  "cells": [
    {
      "service": "shop-api",
      "environment": "production",
      "open": 1,
      "maxSeverity": "high",
      "byType": { "manual_override": 1 }
    }
  ],
  "targets": [
    {
      "targetKey": "argocd:argocd/shop-api-production",
      "open": 1,
      "maxSeverity": "high",
      "byType": { "manual_override": 1 }
    }
  ]
}
```

`cells` use the same ids as `GET /api/environments/state` (`_unmapped` for
unmapped); `targets` match its `targets[].key`.

### `GET /api/drift/settings`, `PUT /api/drift/settings`

```json
{
  "types": [
    "manual_override",
    "untracked_deploy",
    "unknown_image",
    "ambiguous_attribution",
    "out_of_band_change"
  ],
  "severityLevels": ["info", "low", "medium", "high", "critical"],
  "defaults": { "manual_override": "high", "...": "…" },
  "alertTypes": ["manual_override", "untracked_deploy"],
  "alertTypesSource": "environment",
  "severityOverrides": {},
  "severities": { "manual_override": "high", "...": "…" },
  "updatedAt": null
}
```

`PUT` (admin) takes `{"alertTypes": [...] | null, "severities": {type: severity}}`
(both optional; `alertTypes: null` returns to `AFE_DRIFT_ALERTS`;
`severities` replaces the overrides). Invalid types or severities answer
`400`. Alerting applies to findings that open after the change; severities
apply at the next evaluation (the next read).
