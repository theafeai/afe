# Event model

This is the reference for the canonical event that every Afe integration maps
into, the ingestion contract for connector authors, and how long events are
kept. The design rationale is in
[ADR 0003](decisions/0003-event-model-and-audit-log.md) (event model) and
[ADR 0008](decisions/0008-open-source-scope-without-audit-log.md) (no audit
log; retention).

Code: `packages/core/src/` (`event.ts`, `actions.ts`, `observation-gap.ts`,
`ingestion.ts`, `retention.ts`) and `packages/db/src/event-store.ts`,
`packages/db/src/retention.ts`, `packages/db/migrations/0002_events.sql`,
`0021_remove_audit_chain.sql`.

## Contents

- [Event fields](#event-fields)
- [Action vocabulary](#action-vocabulary)
- [Trigger types](#trigger-types)
- [Correlation keys](#correlation-keys)
- [Observation gaps](#observation-gaps)
- [Ingestion contract](#ingestion-contract)
- [Idempotency keys](#idempotency-keys)
- [Retention](#retention)
- [Storage](#storage)

## Event fields

A connector submits a `CanonicalEventInputLike`; Afe validates and normalises
it (`parseEventInput`) and stores a `CanonicalEvent`, which adds the fields
marked _stored_. Optional fields that are `null` or absent are omitted from
the stored event.

| Field                 | Type                     | Description                                                                                                                |
| --------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`       | `1` (stored)             | Version of this shape.                                                                                                     |
| `id`                  | UUID (stored)            | Assigned by Afe.                                                                                                           |
| `tenantId`            | string (stored)          | Owning tenant (`default` in self-hosted installs).                                                                         |
| `seq`                 | integer (stored)         | Per-tenant ordering key, increasing in the order events were stored. Not gap-free: purged events leave gaps.               |
| `source`              | string                   | Tool: `github`, `argocd`, `vercel`, or `afe` (Afe itself). Pattern `^[a-z][a-z0-9_-]{0,31}$`.                              |
| `sourceEventId`       | string, 1..512           | Idempotency key within (tenant, source). See [Idempotency keys](#idempotency-keys).                                        |
| `connectionId`        | string or null           | Afe connection that observed the event.                                                                                    |
| `action`              | string                   | What happened, `<object>.<verb>`. See [Action vocabulary](#action-vocabulary).                                             |
| `actor`               | object                   | Who caused it (below).                                                                                                     |
| `target`              | object                   | What it acted on (below).                                                                                                  |
| `trigger`             | object                   | How it was initiated: `{ type, sourceValue?, detail? }`.                                                                   |
| `outcome`             | enum                     | `succeeded`, `failed`, `cancelled`, `in_progress`, `pending`, `skipped`, `none` (no outcome applies), `unknown` (default). |
| `occurredAt`          | timestamp                | When it happened in the source tool.                                                                                       |
| `observedAt`          | timestamp                | When Afe received or read it.                                                                                              |
| `recordedAt`          | timestamp (stored)       | When Afe stored it.                                                                                                        |
| `observation`         | object                   | Provenance: `{ method, deliveryId?, jobId?, detail? }`.                                                                    |
| `correlation`         | object                   | Cross-tool keys. See [Correlation keys](#correlation-keys).                                                                |
| `data`                | JSON object              | Small, action-specific details. The full source object belongs in the raw payload.                                         |
| `rawPayload` (input)  | `{ contentType, body }`  | Raw payload exactly as received; `body` is a string (stored as UTF-8) or bytes.                                            |
| `rawPayload` (stored) | `{ id, sha256 }` or null | Reference to the `raw_payloads` row and the SHA-256 of its body.                                                           |

Timestamps are accepted as ISO 8601 strings with an offset (`Z` or `+02:00`)
or `Date` objects and are stored as UTC with millisecond precision
(`2026-10-01T10:00:00.123Z`).

Strings anywhere in the event must not contain NUL (`\u0000`) or unpaired
UTF-16 surrogates; such data can only be kept in the raw payload.

### Actor

| Field         | Description                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`        | `user` (a person), `bot` (bot/app account, e.g. `github-actions[bot]`), `token` (an API token or deploy key not tied to a known person), `system` (the tool or Afe itself, e.g. ArgoCD automated sync), `unknown`. |
| `id`          | Stable id in the source (GitHub numeric user id as a string, Vercel user id). Prefer this for identity.                                                                                                            |
| `login`       | Handle / username / token name.                                                                                                                                                                                    |
| `name`        | Display name.                                                                                                                                                                                                      |
| `email`       | When the source provides it.                                                                                                                                                                                       |
| `onBehalfOf`  | Principal the actor acted for, e.g. a GitHub App acting for a user, or a CI token deploying for the person who triggered CI.                                                                                       |
| `triggeredBy` | Principal that triggered this specific run when it differs from the actor, e.g. GitHub `triggering_actor` of a re-run.                                                                                             |

`user`, `bot` and `token` actors require `id` or `login`. `onBehalfOf` and
`triggeredBy` have the same fields except the two nested ones.

### Target

| Field                                                                                | Description                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                                                                               | `repository`, `ref`, `workflow`, `workflow_run`, `environment`, `deployment`, `application` (ArgoCD), `project` (Vercel project, ArgoCD AppProject), `cluster`, `namespace`, `organization`, `connection`, `other`. |
| `id`                                                                                 | Stable identifier within the source, required (e.g. `acme/api`, `argocd/guestbook`, `prj_123`).                                                                                                                     |
| `name`, `url`                                                                        | Display name and link.                                                                                                                                                                                              |
| `repository`, `project`, `application`, `environment`, `cluster`, `namespace`, `ref` | Context fields; set every one that is known so events can be filtered without parsing `id`.                                                                                                                         |

### Observation (provenance)

| `method`         | Meaning                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `webhook`        | Pushed by the source.                                                                                          |
| `poll`           | Read by routine polling (the primary feed for sources or resources without webhooks).                          |
| `reconciliation` | Found by a reconciliation pass that checks for events missed by webhook/poll ("discovered by reconciliation"). |
| `backfill`       | Historical import when a connection is added.                                                                  |
| `stream`         | A long-lived watch (e.g. ArgoCD application watch).                                                            |
| `internal`       | Produced by Afe (observation gaps, connection changes).                                                        |

`deliveryId` holds the webhook delivery id (e.g. `X-GitHub-Delivery`) and
`jobId` the job that produced the event. They are for tracing only and must
never be used as the idempotency key.

## Action vocabulary

Format: lower snake case segments joined by dots, 2 to 4 segments
(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$`). Concepts shared by several tools
use a tool-neutral object (`deployment.*`); concepts specific to one tool are
prefixed with the tool (`argocd.sync.*`). The state of a run is carried in
`outcome` rather than multiplied into action names. The list lives in
`ACTIONS` (`packages/core/src/actions.ts`); to add an action, add it there and
here. Never rename or remove one: stored events keep their names.

| Action                                                 | Sources        | Meaning                                                                                                                               |
| ------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.created`                                   | github, vercel | A deployment record was created.                                                                                                      |
| `deployment.status_updated`                            | github, vercel | A deployment changed state; new state in `outcome`.                                                                                   |
| `deployment.promoted`                                  | vercel         | An existing build was promoted (e.g. to production).                                                                                  |
| `deployment.rolled_back`                               | vercel, argocd | A previous deployment/revision was made live again.                                                                                   |
| `deployment.cancelled`                                 | github, vercel | Cancelled before completing.                                                                                                          |
| `deployment.deleted`                                   | github, vercel | Deployment record deleted in the source.                                                                                              |
| `deployment.review_approved`                           | github         | Required reviewer approved a deployment to a protected environment.                                                                   |
| `deployment.review_rejected`                           | github         | Required reviewer rejected it.                                                                                                        |
| `deployment.protection_rule_requested`                 | github         | A custom deployment protection rule was asked to decide.                                                                              |
| `deployment.review_requested`                          | github         | A deployment to a protected environment is waiting for a required reviewer.                                                           |
| `workflow_run.requested`                               | github         | Workflow run queued.                                                                                                                  |
| `workflow_run.in_progress`                             | github         | Workflow run started.                                                                                                                 |
| `workflow_run.completed`                               | github         | Workflow run finished; conclusion in `outcome`.                                                                                       |
| `workflow_job.completed`                               | github         | A job finished (e.g. the job that deployed to an environment).                                                                        |
| `ref.pushed`                                           | github         | Commits pushed to an existing branch or tag.                                                                                          |
| `ref.created` / `ref.deleted`                          | github         | Branch or tag created / deleted.                                                                                                      |
| `pull_request.merged`                                  | github         | Pull request merged.                                                                                                                  |
| `pull_request.opened` / `.reopened` / `.closed`        | github         | Pull request opened, reopened, or closed without merging.                                                                             |
| `pull_request.synchronized`                            | github         | New commits pushed to a pull request's head branch.                                                                                   |
| `repository_dispatch.received`                         | github         | A `repository_dispatch` was sent to a repository (API only).                                                                          |
| `release.published`                                    | github         | Release published.                                                                                                                    |
| `artifact.published`                                   | github         | A build artifact (container image) was published; `imageRefs`/`imageDigests`.                                                         |
| `artifact.provenance_resolved`                         | github         | Provenance (commit, run) for an earlier `artifact.published` was found later (unverified attestation); never edits the earlier event. |
| `argocd.sync.started`                                  | argocd         | Sync operation started (`operationState.phase` Running).                                                                              |
| `argocd.sync.succeeded`                                | argocd         | Sync operation finished with phase Succeeded.                                                                                         |
| `argocd.sync.failed`                                   | argocd         | Sync operation finished with phase Failed or Error.                                                                                   |
| `argocd.sync.terminated`                               | argocd         | Sync operation was terminated.                                                                                                        |
| `argocd.application.created` / `.updated` / `.deleted` | argocd         | Application spec created, changed (target revision, source, sync policy), deleted.                                                    |
| `argocd.health.changed`                                | argocd         | Application health status changed; new status in `data`.                                                                              |
| `argocd.application.refreshed`                         | argocd         | A refresh (normal/hard) was requested; best-effort, the annotation is short-lived.                                                    |
| `argocd.sync_status.changed`                           | argocd         | Application sync status changed (Synced/OutOfSync/Unknown); new status in `data`.                                                     |
| `configuration.changed`                                | any            | A deployment-relevant setting changed (environment protection, env vars, ...).                                                        |
| `observation_gap.opened` / `.closed`                   | afe            | See [Observation gaps](#observation-gaps).                                                                                            |
| `connection.created` / `.updated` / `.deleted`         | afe            | An Afe connection was added, changed or removed.                                                                                      |
| `connection.alert.opened` / `.resolved`                | afe            | Afe raised / resolved an alert about a connection (see connection-health.md).                                                         |
| `connection.revoked`                                   | afe            | Access was revoked at the source (e.g. GitHub App uninstalled).                                                                       |
| `connection.suspended` / `.resumed`                    | afe            | Access was suspended / resumed at the source (e.g. GitHub App suspend).                                                               |
| `config.mapping.changed`                               | afe            | Environment/service mapping changed; who, and before/after ([mapping](environment-mapping.md)).                                       |
| `drift.finding.opened` / `.resolved`                   | afe            | Afe found / resolved drift: content that does not trace to Git, `data.finding` ([drift](drift.md)).                                   |

The validator accepts any action that matches the pattern, so connectors can
ship a new action before the shared list is updated; `isKnownAction()` tells
them apart.

## Trigger types

| `trigger.type` | Use for (examples, `sourceValue` in brackets)                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `push`         | Commits pushed (GitHub `push`, Vercel git deployments).                                                                     |
| `pull_request` | Pull request events (GitHub `pull_request`, `pull_request_target`; Vercel preview deployments).                             |
| `merge_queue`  | GitHub `merge_group`.                                                                                                       |
| `tag`          | Tag created.                                                                                                                |
| `release`      | GitHub `release`.                                                                                                           |
| `manual`       | A person explicitly started it (GitHub `workflow_dispatch`, ArgoCD UI/CLI sync, Vercel dashboard redeploy without changes). |
| `schedule`     | Cron (GitHub `schedule`).                                                                                                   |
| `api`          | An API call by a token or app (GitHub `repository_dispatch`, REST-created deployment, Vercel API).                          |
| `cli`          | A CLI (`vercel deploy`, `argocd app sync`) where it can be told apart from `manual`/`api`.                                  |
| `rerun`        | Re-run of an earlier run (GitHub `run_attempt > 1`).                                                                        |
| `auto_sync`    | ArgoCD automated sync or self-heal (`automated`).                                                                           |
| `rollback`     | Explicit rollback (ArgoCD rollback, Vercel instant rollback).                                                               |
| `promotion`    | Promoting an existing build (Vercel promote).                                                                               |
| `redeploy`     | Rebuild/redeploy of an existing deployment.                                                                                 |
| `upstream`     | Chained from another run (GitHub `workflow_run` trigger, a deployment created by a workflow).                               |
| `system`       | The tool or Afe acting on its own.                                                                                          |
| `unknown`      | Cannot be determined. Prefer this over guessing.                                                                            |

## Correlation keys

`correlation` is how AFE-15 links a push to the workflow run, deployment, sync
and Vercel deployment it caused. Each key is a list of strings; lists are
de-duplicated and sorted, and lower-cased where noted. Set every key you know.

| Key                  | Format                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `commitShas`         | Full 40 (SHA-1) or 64 (SHA-256) hex, lower-cased. Short SHAs are rejected: resolve them first.                          |
| `refs`               | Fully qualified when known: `refs/heads/main`, `refs/tags/v1.2.3`.                                                      |
| `repositories`       | `host/owner/name`, lower-cased. Build with `repositoryKey(urlOrName)`.                                                  |
| `environments`       | Environment names, lower-cased (GitHub environment, Vercel `production`/`preview`, Argo label).                         |
| `imageRefs`          | `registry/repo:tag`, or digest-pinned `registry/repo@sha256:<hex>` / `registry/repo:tag@sha256:<hex>`.                  |
| `imageDigests`       | `sha256:<hex>`, lower-cased.                                                                                            |
| `deploymentIds`      | Source-qualified: `github:<deployment id>`, `vercel:<dpl_ id>`, `argocd:<namespace>/<app>:<history id>`.                |
| `runIds`             | Source-qualified CI run ids: `github:<run id>`.                                                                         |
| `pullRequests`       | `host/owner/name#<number>`, lower-cased.                                                                                |
| `upstreamCommitShas` | Full SHAs a change refers to in _another_ repository (GitOps bump message, PR body). As `commitShas`.                   |
| `deploymentUrls`     | Lower-case **hosts** of deployment URLs (Vercel `url`, GitHub status `target_url`). Build with `deploymentUrlKey(url)`. |

Query: `WHERE tenant_id = $1 AND correlation @> '{"commitShas":["<sha>"]}'`
(GIN-indexed).

Notes on individual keys:

- `imageRefs`: the digest-pinned form keeps a digest paired with its image
  when an event carries several images (`imageRefs` and `imageDigests` are
  otherwise unpaired lists). The digest part is lower-cased; the name and tag
  are kept as given. A bare name without tag (implicit `latest`) is still
  accepted so that events recorded before it was validated stay valid.
  Connectors that know the digest also put it in `imageDigests`.
- `upstreamCommitShas`: only the SHAs are stored, never the message or body
  text they were found in (R8). Same validation as `commitShas` (full length,
  lower-cased).
- `deploymentUrls`: only the host is kept, never scheme, port, path, query or
  fragment. Preview and share URLs can carry tokens in their query string
  (e.g. Vercel `?_vercel_share=…`, protection bypass links) and stored events
  are never edited, so a token stored there would stay until the event is
  purged. The schema
  rejects anything that is not a bare host; `deploymentUrlKey()` reduces a URL
  to its host.
- Empty lists are dropped (absent and `[]` are the same), so adding a key does
  not change the stored form of an event that does not use it.
- Events recorded before AFE-18 carried `upstreamCommitShas`/`deploymentUrls`
  as `data.correlationHints.{mentionedCommitShas,deploymentUrls}`. Stored
  events are immutable, so readers (the correlation prototype) read the
  `correlation` keys first and fall back to those hints.

## Observation gaps

An observation gap is a period during which a connection could not observe
its source, so Afe may be missing events for it. Gaps are recorded as events
next to the events they qualify, so the timeline shows them in place.

- `observation_gap.opened`: `occurredAt` = gap start.
- `observation_gap.closed`: `occurredAt` = gap end.
- `source` `afe`, `actor` `{type: system, id: afe}`, `target`
  `{type: connection, id: <connectionId>}`, `trigger.type` `system`,
  `observation.method` `internal`, `outcome` `none`.
- `sourceEventId` `observation_gap:<gapId>:opened|closed`.
- `data.gap` (validated by `observationGapSchema`):

| Field          | Description                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gapId`        | Stable id shared by the opened and closed events.                                                                                                                                                  |
| `connectionId` | The connection.                                                                                                                                                                                    |
| `source`       | Source that could not be observed.                                                                                                                                                                 |
| `startedAt`    | Start of the possibly-incomplete period (inclusive).                                                                                                                                               |
| `endedAt`      | End (exclusive); required and `>= startedAt` on `closed`.                                                                                                                                          |
| `reason`       | `connection_error`, `auth_failed`, `permission_denied`, `rate_limited`, `source_unavailable`, `webhook_delivery_failed`, `history_unavailable`, `afe_unavailable`, `connection_paused`, `unknown`. |
| `detail`       | Human-readable detail. Never include credentials.                                                                                                                                                  |

Use `observationGapOpened(params)` and `observationGapClosed(params)` to build
them. A gap found after the fact (e.g. Afe was down) is recorded by emitting
both events with past `startedAt`/`endedAt`; `observedAt` stays the time Afe
noticed. Reconciliation that later recovers events from the gap period ingests
them with `observation.method = reconciliation`; the gap events stay.

## Ingestion contract

Connectors depend on `EventSink` from `@afe/core`, never on the database:

```ts
interface EventSink {
  ingest(tenantId: string, input: CanonicalEventInputLike): Promise<IngestResult>;
}
type IngestResult =
  | { status: "inserted"; inserted: true; event: CanonicalEvent }
  | { status: "duplicate"; inserted: false; event: CanonicalEvent } // the stored one
  | { status: "expired"; inserted: false; event: null }; // outside the retention window
```

The server passes `createPgEventSink(pool, { retention })` (`@afe/db`); tests
use `createMemoryEventSink({ retention? })` (`@afe/core`). `EventSink` is also
the seam a different build can replace or wrap (`createAfe({ sink })`, ADR
0008).

Rules for connector authors:

1. **Map, don't invent.** Use `unknown` for actor/trigger/outcome you cannot
   determine. Never guess a person from a commit author when the source says
   a bot deployed; use `onBehalfOf`/`triggeredBy` for the second principal.
2. **Derive `sourceEventId` from the source object**, identically for webhook,
   poll, reconciliation and backfill (next section). Use
   `sourceEventId(...parts)` to join parts safely.
3. **Always attach the raw payload** you mapped from (the exact webhook body,
   or the API response object for polling). Do not include request headers;
   never include credentials or signatures.
4. **Set `observation.method` truthfully.** A webhook handler uses `webhook`;
   a reconciliation pass uses `reconciliation`, which marks events that were
   missed by the primary feed.
5. **Errors:** `EventValidationError` is a bug in the mapping; log it (without
   payload secrets) and do not retry. Any other error is transient: let the
   job retry. Retrying is always safe.
6. **Ordering:** events may be ingested in any order; `seq` is storage order,
   not source order. Use `occurredAt` for source time.
7. **First arrival wins.** If the same key arrives again (webhook after poll,
   or a retry), nothing is written and the stored event is returned. A later
   observation with more information (e.g. a final status) must be a
   _different_ event with its own key (e.g. `...:completed`), not an update.
8. **Old events are dropped.** An event whose `occurredAt` is already outside
   the retention window is not stored (`status: "expired"`); this is not an
   error. Keep backfill and lookback windows inside the window
   (`ctx.retention`, see [Retention](#retention)).

## Idempotency keys

The unique key is `(tenant_id, source, source_event_id)`. A key identifies one
state transition of one source object. Keys below are written as
`sourceEventId(...)` parts. Sources' docs:
[GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
[GitHub deployments REST](https://docs.github.com/en/rest/deployments/deployments),
[GitHub workflow runs REST](https://docs.github.com/en/rest/actions/workflow-runs),
[Argo CD API](https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/),
[Vercel webhooks](https://vercel.com/docs/webhooks/webhooks-api),
[Vercel deployments REST](https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments).

| Source | Object / action                     | `sourceEventId` parts                                                                                                    |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| github | deployment created                  | `deployment`, `<deployment.id>`, `created`                                                                               |
| github | deployment status                   | `deployment_status`, `<deployment_status.id>`                                                                            |
| github | workflow run transition             | `workflow_run`, `<run.id>`, `<run_attempt>`, `requested\|in_progress\|completed`                                         |
| github | workflow job completed              | `workflow_job`, `<job.id>`, `completed`                                                                                  |
| github | push                                | `push`, `<repository.id>`, `<ref>`, `<before>`, `<after>`                                                                |
| github | pull request merged                 | `pull_request`, `<pull_request.id>`, `merged`                                                                            |
| github | release published                   | `release`, `<release.id>`, `published`                                                                                   |
| github | deployment review                   | `deployment_review`, `<run.id>`, `<environment names, sorted, comma-joined>`, `<reviewer user id>`, `approved\|rejected` |
| argocd | sync started / finished             | `sync`, `<application metadata.uid>`, `<operationState.startedAt>`, `started\|finished`                                  |
| argocd | application created/updated/deleted | `application`, `<metadata.uid>`, `<metadata.generation>` (or `deleted`)                                                  |
| argocd | health changed                      | `health`, `<metadata.uid>`, `<status>`, `<observed transition time>`                                                     |
| vercel | deployment transition               | `deployment`, `<dpl_ id>`, `created\|succeeded\|failed\|cancelled\|promoted`                                             |
| vercel | production promotion / rollback     | `production_alias`, `<project id>`, `<previous dpl_ id or none>`, `<new dpl_ id>`, `<occurrence ms>` (AFE-30)            |
| afe    | observation gap                     | `observation_gap`, `<gapId>`, `opened\|closed`                                                                           |
| afe    | connection alert                    | `connection_alert`, `<alertId>`, `opened\|resolved`                                                                      |
| afe    | mapping change                      | `config_mapping`, `<mapping revision>`                                                                                   |
| afe    | drift finding                       | `drift_finding`, `<finding id>`, `opened\|resolved`                                                                      |

GitHub keys are built by `packages/connector-github/src/event-ids.ts` and listed,
with AFE-7's refinements (run attempt in review keys, `repository_dispatch`), in
[docs/connectors/github.md](connectors/github.md#idempotency-keys-shared-with-afe-8).

Rules: never use webhook delivery ids, poll timestamps or Afe-generated ids;
use the source's immutable numeric/opaque id rather than names (names can be
reused after deletion); keep each key under 512 characters. Connector issues
(AFE-5+) may refine the table for their source, additively.

## Retention

Afe keeps recent events only (ADR 0008). `RetentionPolicy` (`@afe/core`)
gives each tenant a cutoff; the open-source default `FixedWindowRetention`
uses `AFE_EVENT_RETENTION_DAYS` (default 30, 1..60; 60 days is the maximum of
the open-source build and larger values stop Afe from starting).

- Retention is measured on **`occurredAt`**, the time shown in the timeline.
- **At ingestion**, an event whose `occurredAt` is before the cutoff is
  dropped (`status: "expired"`). A poll, backfill or reconciliation pass that
  re-reads an old object therefore cannot store it again, and a duplicate of
  a purged event cannot reappear.
- **The `retention.purge` job** (hourly) deletes, per tenant, events with
  `occurredAt` before the cutoff and their raw payloads, in batches of 1000
  rows per transaction, then raw payloads that no event references.
- **Connector windows** (GitHub backfill days and reconcile lookback, Vercel
  first-connect backfill, gap backfills) are clamped to the window, with a
  log line when a configured value is longer.
- `seq` numbers are never reused: purged events leave gaps.

Stored events are otherwise immutable: Afe never updates an event, and the
purge is the only deletion.

## Storage

Migration `0002_events.sql`:

- `events` — one row per event. Structured fields are `jsonb`; unique
  `(tenant_id, seq)` and `(tenant_id, source, source_event_id)`; indexes on
  occurred/recorded time, source+action, action, connection, actor id and
  login, target type+id, target repository and environment, and a GIN index
  on `correlation`.
- `raw_payloads` — `bytea` body, content type, sha256, size; referenced by
  `(tenant_id, raw_payload_id)`.
- `event_sequences` — the last `seq` per tenant (migration 0021). An insert
  increments it and holds the row lock until commit, so a tenant's seq order is
  its commit order (query snapshots rely on this); tenants do not block each
  other.
- Migration 0021 removed the append-only triggers, the hash-chain columns and
  `event_chain_heads` (ADR 0008).

Read APIs in `@afe/db`: `getEvent`, `findEventBySourceId`, `listEvents`
(tenant, `occurredAt` range, keyset cursor in `seq` order). The filtered query
API (AFE-14) is in `event-query.ts`; see [api.md](api.md). Purge:
`purgeEventsBefore` in `retention.ts`.
