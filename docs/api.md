# Audit query API

HTTP API for asking the audit log questions and taking evidence out of it
(AFE-14). Code: `apps/server/src/api/events.ts` (routes),
`packages/db/src/event-query.ts` (SQL), `packages/core/src/event-filter.ts`
(filter semantics), `packages/core/src/export/` (export and verifier). Export
format and verification: [export-verification.md](export-verification.md).

> **No authentication yet.** The `AuthProvider` extension point (ADR 0002) is
> not implemented. Until it is, do not expose `/api/*` beyond a trusted
> network (bind to localhost or put it behind an authenticating proxy). The
> tenant is chosen by the `TenantResolver` (OSS default: always `default`),
> never by a request parameter.

## Endpoints

| Method and path              | Purpose                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/events`            | Filtered, paginated event list, each with provenance                          |
| `GET /api/events/:id`        | One event: full canonical event, provenance, raw payload status, chain status |
| `GET /api/events/:id/raw`    | The raw source payload bytes (download)                                       |
| `GET /api/deployments`       | "Who deployed what to where, and when" view across tools                      |
| `GET /api/export`            | Streaming CSV or JSON Lines export with an integrity manifest                 |
| `GET /api/export/public-key` | The manifest signing key (404 when exports are unsigned)                      |
| `GET /api/audit/verify`      | Verifies the tenant's whole hash chain; optionally checks a recorded head     |

Errors: `400 {"error":"bad_request","message":...}` for invalid parameters
(including unknown parameters: a typo never silently widens a query or an
export), `404 {"error":"not_found"}`.

## Filters

Shared by `/api/events`, `/api/deployments` and `/api/export`. List
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
| `seqFrom`, `seqTo`                                                | chain position, inclusive                                                                                             |

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

Stability: the first page pins the traversal to the chain head at that moment
(`snapshotSeq`). Later pages only show events with `seq <= snapshotSeq`, so
events appended while you page — including late arrivals with an older
`occurredAt` found by reconciliation — never shift, duplicate or skip rows.
Start a new traversal (no cursor) to see them.

## Items and provenance

Each list item is `{ "event": <canonical event>, "provenance": {...} }`. The
`event` is exactly the stored canonical event (see
[event-model.md](event-model.md)) and can be re-hashed by the client.

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
    "receivedAt": "…", "verified": true, "url": "/api/events/<id>/raw"
  },
  "chain": {
    "seq": 42, "prevHash": "…", "hash": "…",
    "hashVerified": true, "prevLinkVerified": true,
    "head": { "seq": 1234, "hash": "…" }
  }
}
```

`rawPayload.verified`: the stored bytes still hash to `rawPayload.sha256`,
which is covered by the event hash. `hashVerified`: the event re-hashes to
its `hash`. `prevLinkVerified`: `prevHash` equals the stored hash at
`seq - 1`. Use `/api/audit/verify` for the whole chain.

## `GET /api/events/:id/raw`

Returns the raw payload bytes exactly as stored. Connectors strip secrets and
everything listed in [data-inventory.md](security/data-inventory.md) before
storing, so nothing secret is held here; the API cannot redact further
without breaking the hash. The response is always a download that a browser
will not render: `Content-Type` is the stored type only for
`application/json` / `text/plain` (otherwise `application/octet-stream`),
with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`
and a sandboxing CSP. Headers `X-Afe-Raw-Sha256`, `X-Afe-Raw-Verified` and
`X-Afe-Original-Content-Type` carry the evidence metadata.

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
# Everything that reached production last week, oldest first
curl "$AFE/api/deployments?environment=production&from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z&order=asc"

# Successful deployments by alice (as actor, on-behalf-of or triggering user)
curl "$AFE/api/deployments?actor=alice&outcome=succeeded"

# Where did commit 4f2c9b8 go?
curl "$AFE/api/deployments?commitSha=4f2c9b8"

# ArgoCD syncs of the payments application that were not automated
curl "$AFE/api/deployments?source=argocd&application=payments&trigger=manual,api,cli"

# Deployments Afe only learned about through reconciliation (missed webhooks)
curl "$AFE/api/events?action=deployment.*&method=reconciliation"

# ...and take the answer out as signed, verifiable evidence
curl -OJ "$AFE/api/export?format=csv&view=deployments&environment=production&from=2026-10-19T00:00:00Z"
afe verify-export afe-export-default-*.afe.csv --public-key <operator public key>
```

## `GET /api/export`

Parameters: the filters above, plus `format=json|csv` (default `json`),
`view=events|deployments` (`deployments` applies the deployment action set
when no `action` is given) and `raw=true|false` (JSON only: embed raw payload
bytes). The response streams; the integrity manifest is the last record, so a
truncated download fails verification. Events are always in ascending `seq`
order and come from one consistent database snapshot together with the chain
head. Headers: `Content-Disposition: attachment; filename="afe-export-<tenant>-<time>.afe.jsonl|.afe.csv"`,
`X-Afe-Export-Id`.

Manifests are signed with Ed25519 when `AFE_EXPORT_SIGNING_KEY` is set
(generate one with `afe export-keygen`, publish the public key). The
`AuditExporter` extension point (`@afe/core`) replaces the whole exporter;
`ExportSigner` replaces only the signing (e.g. a KMS key).

## `GET /api/audit/verify`

Runs `verifyTenantChain` (every hash, link and raw payload, plus the stored
head) and returns:

```json
{
  "ok": true,
  "verification": { "ok": true, "count": 1234, "lastSeq": 1234, "lastHash": "…" },
  "head": { "seq": 1234, "hash": "…" },
  "anchor": null
}
```

With `anchorSeq=<n>&anchorHash=<hash>` (for example the `chainHead` of an
old export, or a head you wrote down) it also checks that the live chain still
has that hash at that position: `anchor: {seq, hash, found, matches}`, and
`ok` is false if it does not. That is how an auditor confirms that an export's
events are still part of an untampered chain. This reads the whole chain; it
is meant for audits, not for frequent polling.
