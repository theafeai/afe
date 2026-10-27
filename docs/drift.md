# Drift and untracked deploy detection

Issue: AFE-26 ([research 0001](research/0001-cross-tool-flow.md), follow-up 9).
Code: `@afe/core/drift` (pure detection, event builders), `@afe/db` `drift.ts`
(migration `0024_drift_findings.sql`), `apps/server/src/drift/` (service, job,
API), web UI page **Drift** (`/drift`, `/drift/:id`). API reference:
[api.md](api.md#drift-findings).

Afe flags what is running that does not trace to Git, with the evidence:
manual ArgoCD image/parameter overrides, deploys without Git metadata,
images no observed build produced, ambiguous builds and changes made outside
the Git flow. Findings are optionally alerted through the `AlertSink`
([connection-health.md](connection-health.md#alerts)) and their transitions
are recorded as `drift.finding.opened` / `drift.finding.resolved` events.

Detection builds on the correlation output ([correlation.md](correlation.md)):
placements with their attribution status, kind and evidence, identifier
conflicts and the window's events. It does not link events itself.

## Finding types

| Type                    | Default severity | Raised when                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual_override`       | high             | An ArgoCD Application's image overrides changed outside Git: `argocd.application.updated` with `data.change.imageOverrides` (kustomize images, Helm image parameters/values), or `argocd.application.created` with `data.spec.imageOverrides`. Changes made by a parent app-of-apps (`trigger.type: upstream`) come from Git and are ignored. Producers that only name the changed field (`data.change: "spec.source.kustomize.images"`, `data.change.fields`) count too. |
| `untracked_deploy`      | medium           | A placement without images whose content traces to no commit: attribution `unknown`, or only a weak time-proximity `guess` (e.g. `vercel deploy` from a laptop, an API deploy without Git metadata).                                                                                                                                                                                                                                                                      |
| `unknown_image`         | medium           | An image runs that no observed build links to a commit (no `artifact.published`/CI run, or a build without provenance), and the tag does not name a commit. Mutable tags (`latest`, `main`, …) are flagged in the details. Not raised while a manual override is active on the target (that is the override's finding).                                                                                                                                                   |
| `ambiguous_attribution` | low              | The placement's attribution is `ambiguous` (a mutable tag rebuilt from several commits), or a `tag_digest_mismatch` / `digest_commit_mismatch` conflict exists for its (tag-only) image or digest at that time.                                                                                                                                                                                                                                                           |
| `out_of_band_change`    | medium           | A manual or rollback placement whose content traces to Git but differs from the target's latest Git-triggered deploy (a `deploy` placement with `attributed` status), e.g. an ArgoCD manual sync to another revision, a Vercel instant rollback.                                                                                                                                                                                                                          |

The type is an open string: `detectDrift(input, { detectors })` accepts more
placement detectors (`PlacementDetector`), so new types need no core change.
Severities are configurable per tenant (`PUT /api/drift/settings`).

## Findings are episodes

A finding is one **episode per target and type**: it opens at the first
placement (for overrides: the Application change) that exhibits the
condition, stays one finding while the following placements of the target
keep exhibiting it (repeated CLI deploys are one finding with several
evidence entries), and is **resolved automatically** by the first later
placement that no longer exhibits it, typically a Git-traced deploy. A
manual override is resolved by the first sync after the override was
removed, or by a sync whose content traces to Git and is not the overridden
image.

- **Deterministic id**: `uuid(sha256("drift", tenant, type, target, opening event id))`,
  so repeated evaluation never duplicates a finding.
- **First / last seen**: `occurredAt` of the opening event and of the latest
  event exhibiting the finding. **Resolved at**: the replacing placement's
  `occurredAt` (`resolvedByEventId`).
- **Service / environment** come from the mapping
  ([environment-mapping.md](environment-mapping.md)) of the finding's latest
  event, re-resolved at every evaluation; unmapped is explicit (`null`,
  filter `_unmapped`).
- **Evidence**: event ids, each with a role (`override`, `placement`,
  `build`, `conflict`, `git_deploy`, `related`, `resolution`), time and a
  self-contained summary; at most 20 per episode in detection (first and
  latest) and 40 stored, with `evidenceOmitted`.

## Decision: persisted findings, evaluated by a job and on read

AFE-20 computes correlation on read. Drift reuses that window (the
correlation service's per-tenant cache) but **persists findings** in
`drift_findings` (migration 0024):

- Alerting and transition events need **state**: "opened" and "resolved"
  must each be noticed once, also across restarts and several server
  processes. Without stored state every evaluation would be the first.
- Findings must **outlive their events** for a while: a finding whose
  opening event was purged still has to render (and not re-open under a new
  id when the window moves past its first event).
- Derivation stays compute-on-read: the stored rows are a projection that is
  reconciled with what `detectDrift` returns; nothing is maintained on
  ingest.

Evaluation (`DriftService.evaluate`): take the tenant's correlation snapshot,
run `detectDrift`, resolve the mapping, then under a per-tenant advisory lock
insert new findings, update changed ones (a fingerprint of the derived fields
skips no-op writes) and purge old ones. It runs:

- in the `drift.evaluate` job, every minute, for every tenant with events;
  the job then delivers pending events and alerts;
- on read (`GET /api/drift/*`), when the correlation graph or the settings
  changed since the last evaluation in this process, or it is older than a
  minute. A failed evaluation on read is logged and the stored findings are
  served.

Late events (reconciliation, backfill) can change an episode: findings are
re-derived, so a resolved finding can re-open (no second "opened" event or
alert: transitions are delivered once per finding and direction).

### Side effects: events and alerts, once per transition

Each finding row records `opened_recorded_at` / `resolved_recorded_at`
(events) and `opened_notified_at` / `resolved_notified_at` (alerts). After
each evaluation pending events are ingested through the `EventSink`
(idempotent `sourceEventId` `drift_finding:<id>:opened|resolved`); the job
also sends pending alerts. A failed notification is retried by the next run,
at most 5 times (`notify_attempts`, `last_notify_error`), like connection
alerts.

- `drift.finding.opened`: `occurredAt` = first seen; `drift.finding.resolved`:
  `occurredAt` = resolved at. Source `afe`, target = the environment target
  (`type: environment`, id = target key), `data.finding` = id, type,
  severity, title, explanation, target, service, environment, opening and
  resolving event ids, evidence event ids. A finding first seen already
  resolved (e.g. a CLI deploy replaced between two evaluations) records both
  events.
- **Alerts** are optional per type: `AFE_DRIFT_ALERTS` (comma-separated
  types, `all`, default none) or per tenant `alertTypes` in the settings API
  (which takes precedence; `null` returns to the server default). A finding
  alerts if its type alerted when it **opened** (`alert` column); it then
  also alerts when resolved. Changing the setting does not alert existing
  findings retroactively. Notifications go through the health module's
  `AlertSink` (log + optional `AFE_ALERT_WEBHOOK_URL`), or
  `createDriftModule({ alertSink })`: `kind` `drift_<type>`, `alertId` = the
  finding id, `connectionId` = the connection of the finding's latest event
  (`""` if unknown), `message` = severity, title, service/environment and
  explanation, and a `drift` object (finding id, type, severity, target,
  service, environment, UI `url` — absolute with `AFE_PUBLIC_URL` — and
  evidence event ids). Never contains credentials.

## Retention

Findings are derived from the retention window (ADR 0008) and kept no
longer than it:

- **Evidence is stored with summaries.** When an evidence event is purged,
  the finding still renders: the API marks it `available: false, url: null`
  and counts `eventsPurged`; the UI says "Event no longer retained".
- **Episodes truncated by the window keep their identity.** If the opening
  event is purged while the episode goes on, detection starts the episode at
  a later event (a new key); the service matches it to the stored open
  finding of the same type and target whose span covers it and keeps the
  original id, first seen and old evidence (`details.continuedAfterPurge`).
- **Purge.** At every evaluation, findings that are not detected anymore and
  whose `resolved_at` (or, while open, `last_seen_at`) is before the
  retention cutoff are deleted. An open finding whose events all left the
  window is therefore deleted one window after it was last seen in Git
  history; Afe no longer observes that target either (it drops out of the
  matrix as well).
- Known limit: when an ArgoCD override's `application.updated` event is
  purged but a later sync with the overridden image is still in the window,
  that sync is reported as `unknown_image` (the stored `manual_override`
  finding remains until it is purged).

## API and UI

- `GET /api/drift/findings` (filters `status`, `type`, `severity`,
  `service`, `environment`, `target`; keyset pagination),
  `GET /api/drift/findings/:id` (evidence with event links and availability,
  journey links for the commits involved, alert state),
  `GET /api/drift/summary` (open findings per matrix cell and per target, for
  a drift badge in the environment matrix), `GET /api/drift/settings`
  (viewer), `PUT /api/drift/settings` (admin). Reference:
  [api.md](api.md#drift-findings).
- Web UI: **Drift** in the navigation. List with filters (status, type,
  severity, service, environment; kept in the URL), severity and status
  badges, and an empty state; the detail page shows the explanation, where,
  first/last seen, resolution, alert state, the evidence with links to the
  events, and links to the journeys of the commits involved
  (`/journeys?repository=&commit=`, the AFE-25 journey page).

## Configuration

| Variable           | Default | Meaning                                                                                                                |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AFE_DRIFT_ALERTS` | unset   | Finding types that alert by default (`manual_override,untracked_deploy`, or `all`). Unknown types are a startup error. |

Module options (`createDriftModule`): `alertSink`, `defaultAlertTypes`,
`schedule` (cron of `drift.evaluate`), `maxNotifyAttempts`, `maxStaleMs`,
`maxEvidence`, `correlation`.

## Known limits and follow-ups

- Severity is per type; it does not yet depend on the environment kind
  (e.g. raise for production).
- `untracked_deploy` relies on the placement's attribution: a Vercel deploy
  whose Git metadata is present but whose commit was never pushed (local
  commit) is attributed and not flagged.
- `out_of_band_change` compares with the latest Git-triggered `deploy`
  placement of the same target; promotions are considered part of the flow.
- ArgoCD drift between live cluster state and the Application (`OutOfSync`
  with self-heal off) is not a finding yet; the connector's
  `argocd.sync_status.changed` could feed one.
- Findings are not acknowledged or muted by users; a follow-up could add
  that (it would be stored per finding id).

## To verify against docs

Nothing new beyond the connectors: drift reads canonical events. It depends
on the ArgoCD connector's `data.change.imageOverrides` /
`removedImageOverrides` / `data.spec.imageOverrides` and on `trigger.type`
`upstream` for app-of-apps changes (docs/connectors/argocd.md), and on
correlation's attribution (research 0001 "To verify against docs").
