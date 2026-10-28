# GitHub connector

- Issues: AFE-6 (App and install flow), AFE-7 (event capture, below), AFE-8
  ([reconciliation and backfill](#reconciliation)), AFE-21 ([artifacts](#artifacts)).
- Code: `packages/connector-github` (pure logic) and `apps/server/src/connectors/github.ts`
  (routes, jobs, health hooks).

Afe connects to GitHub as a **GitHub App** with read-only permissions. Each App
installation (one organization or user account) is one Afe connection
(`connections.source = "github"`, `external_id` = installation id, `name` = account login).

The following permissions describe the **observation App**. Opt-in personal
[GitHub delivery operations](../github-actions.md) use separate user credentials,
exact action grants and the source's write/reviewer rules; do not widen the
observation installation to enable them.

## Permissions

All permissions are repository permissions with `read` access. Afe never asks
for write access (docs/security/rules.md R1).

| Permission     | Access | Why Afe needs it                                                                                                                                                                                                                   |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`     | read   | Mandatory for every GitHub App. Repository ids, names and the list of repositories in the installation.                                                                                                                            |
| `actions`      | read   | Workflow runs and jobs: REST `GET /repos/{o}/{r}/actions/runs` and the `workflow_run` / `workflow_job` webhooks. This is how Afe sees who triggered a run and how (push, PR, dispatch, schedule, API, re-run, reusable workflows). |
| `deployments`  | read   | Deployments and deployment statuses: REST `GET /repos/{o}/{r}/deployments[/{id}/statuses]` and the `deployment`, `deployment_status` and `deployment_review` webhooks (environment approvals and rejections).                      |
| `environments` | read   | Environments and their protection rules (required reviewers, branch policies), so Afe can tell what gated a deployment. Part of the R1 baseline; used by AFE-7/AFE-8.                                                              |
| `packages`     | read   | **Optional** (requested by the manifest, not required). `registry_package` webhooks: container images pushed to ghcr.io, for `artifact.published` (AFE-21, [Artifacts](#artifacts)). Afe never pulls images.                       |
| `attestations` | read   | **Optional** (requested by the manifest, not required). `GET /repos/{o}/{r}/attestations/{digest}`: build provenance (commit, run) of a published image.                                                                           |

Not requested, by design:

| Permission      | Why not                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contents`      | Would allow reading source code. Commit SHA, ref, actor and trigger of every run and deployment are already on the `workflow_run` and `deployment` payloads, so `push` webhooks are not needed. An operator **may** grant `contents: read` to also get `push`/`create`/`delete`/`release` events and [commit containment](../containment.md) (compare API); Afe still never downloads file contents. |
| `pull_requests` | Pull requests that triggered runs are listed on `workflow_run.pull_requests`. Optional, for `pull_request` events (`pull_request.merged`).                                                                                                                                                                                                                                                           |
| `checks`        | `workflow_run`/`workflow_job` cover GitHub Actions; third-party CI via checks is out of scope for now.                                                                                                                                                                                                                                                                                               |
| anything write  | The observation App never changes anything in GitHub; opt-in personal action routes are separate (ADR 0011). It is not a deployment protection rule (that would need `deployments: write`).                                                                                                                                                                                                          |

### Permission check

Every time Afe learns an installation's permissions (install, setup callback,
`new_permissions_accepted`), it runs `checkPermissions`:

- **writable**: any permission granted with `write`/`admin` (e.g. the App owner
  widened the App, or an operator registered the App by hand with too much access);
- **missing**: a required permission above that is not granted (the org owner has
  not accepted an update yet);
- **extra**: other read permissions (allowed, reported for review);
- **optionalMissing**: optional read permissions (`attestations`, `contents`, `packages`,
  `pull_requests`) that are not granted, i.e. the optional features that are off. Not a
  problem: the connection stays `active` without a status reason (AFE-21).

The result is stored in the connection's `config.permissionCheck`, a problem is
written to the connection's `status_reason` (e.g.
`write access granted (Afe needs read only): deployments`) and logged as a
warning. The connection stays `active`, because Afe can still observe what it
has access to; AFE-13 health surfaces the reason. Installation tokens are always
requested narrowed to `read` of what the installation granted, so even an
over-privileged installation only ever yields read-only tokens.

## Webhook events

Subscribed (manifest `default_events`): `workflow_run`, `workflow_job`,
`deployment`, `deployment_status`, `deployment_review`, and `registry_package`
(needs the optional `packages` permission; AFE-21).

Always delivered to Apps (not subscribable): `installation`,
`installation_repositories`, `github_app_authorization`.

How AFE-7 triggers map onto these:

| Trigger                            | Seen on                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| push, pull request, merge queue    | `workflow_run.event` (`push`, `pull_request`, `merge_group`), `head_sha`, `head_branch`           |
| manual dispatch                    | `workflow_run.event = workflow_dispatch`, `triggering_actor`                                      |
| schedule                           | `workflow_run.event = schedule`                                                                   |
| API runs, repository dispatch      | `workflow_run.event = workflow_dispatch` / `repository_dispatch`, actor is the token owner or App |
| re-runs                            | `workflow_run.run_attempt > 1`, `triggering_actor`                                                |
| reusable workflows                 | `workflow_run.referenced_workflows`, `workflow_job.workflow_name`                                 |
| deployments and statuses           | `deployment`, `deployment_status`                                                                 |
| environment approvals / rejections | `deployment_review` (approved/rejected), `workflow_job` with status `waiting`                     |

### Receiving

`POST /webhooks/github` (body limit 25 MiB, GitHub's maximum payload size):

1. Verify `X-Hub-Signature-256` over the raw body with the App's webhook secret
   (`verifyGitHubSignature`). Missing/invalid → `401` with no detail; the legacy
   SHA-1 header is never accepted.
2. Replay guard: `recordDelivery(source "github", X-GitHub-Delivery)`. A replay is
   answered `200 {duplicate: true}` and not processed.
3. `installation` / `installation_repositories` are applied inline, in the same
   transaction as the delivery record (database work only, no outbound calls):

   | Delivery                                     | Connection                                 | Event (source `afe`)                                  |
   | -------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
   | `installation.created`                       | upsert, `active` (or `suspended`)          | `connection.created`                                  |
   | `installation.deleted`                       | `revoked`, reason "GitHub App uninstalled" | `connection.revoked`                                  |
   | `installation.suspend`                       | `suspended`                                | `connection.suspended`                                |
   | `installation.unsuspend`                     | `active`                                   | `connection.resumed`                                  |
   | `installation.new_permissions_accepted`      | config permissions + check updated         | `connection.updated` (`data.change = "permissions"`)  |
   | `installation_repositories.added`/`.removed` | `config.repositories` updated (or `"all"`) | `connection.updated` (`data.change = "repositories"`) |

   Events carry the GitHub `sender` as actor and the delivery as raw payload.
   Their `sourceEventId` is derived from the connection id, the change and the
   installation's `updated_at`/`suspended_at` (never the delivery id alone), so the
   `connection.created` from the webhook and from the setup callback are the same
   event. The cached installation tokens are dropped on every lifecycle change.

4. `github_app_authorization` is acknowledged and ignored (Afe uses no user tokens).
5. Every other event is enqueued as a **`github.webhook` job** per active connection
   of the installation (`GitHubWebhookJob`: tenant, connection, installation id,
   delivery id, event, action, parsed payload and exact raw body; no credentials).
   The job runs `processGitHubWebhook` (see [Event capture](#event-capture));
   `createGitHubModule({ processWebhook })` can replace it (tests).
   Deliveries for installations not connected to any tenant are recorded (with
   `tenant_id = NULL`) and dropped.

## Event capture

- Issue: AFE-7. Code: `packages/connector-github/src/mapping.ts` (pure mapping),
  `event-ids.ts` (idempotency keys, shared with AFE-8 polling), `raw-payload.ts`
  (raw payload redaction), and `processGitHubWebhook` in `apps/server/src/connectors/github.ts`.
- Fixtures: `packages/connector-github/test/fixtures/webhooks/*.json`, one per trigger.

### Processing a `github.webhook` job

1. Load the job's connection (tenant-scoped). Gone → ignored.
2. Repository selection: if the delivery's `repository.id` is not in the connection's
   `config.repositories` (and the selection is not `"all"`), the delivery is ignored and
   logged. A connection without a repository list is treated as selecting nothing.
3. `mapWebhookDelivery` maps it (or returns `ignored` for events/actions Afe does not
   record), then every event is ingested through `ctx.sink` (idempotent).
4. Success, including "ignored", calls `ctx.health?.reportSuccess(tenant, connection,
receivedAt, { via: "webhook" })` for an active connection.
5. Permanent errors are logged with the delivery id, event and failing field path only
   (never payload content) and the job completes, so it is **not retried** and does not
   block the queue: `GitHubPayloadError` (a required field is missing or has the wrong
   type) and `EventValidationError` (the mapped event is invalid, e.g. a NUL in a string).
   Fix and use GitHub's "Redeliver" to process the delivery again. Every other error
   (database) propagates and pg-boss retries the job; ingestion is idempotent.

### What is recorded

| Webhook (action)                                            | Canonical action                                                              | Actor                                                                   | `trigger.type`                                                  | `outcome`                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `workflow_run` (`requested`/`in_progress`/`completed`)      | `workflow_run.requested` / `.in_progress` / `.completed`                      | `actor`; `triggeredBy` = `triggering_actor` when different (re-runs)    | from `workflow_run.event` (table below); `rerun` if attempt > 1 | `pending` / `in_progress` / from `conclusion`                                                                |
| `workflow_job` (`completed` only)                           | `workflow_job.completed`                                                      | `sender`                                                                | `upstream` (`rerun` if attempt > 1)                             | from `conclusion`                                                                                            |
| `deployment` (`created`)                                    | `deployment.created`                                                          | `creator`; `triggeredBy` = linked run's triggering actor when different | `upstream` if `workflow_run` is linked, else `api`              | `pending`                                                                                                    |
| `deployment_status` (`created`)                             | `deployment.status_updated`                                                   | status `creator`; `triggeredBy` as above                                | as the deployment                                               | `state`: success→succeeded, failure/error→failed, pending/queued/waiting→pending, in_progress, inactive→none |
| `deployment_review` (`approved`/`rejected`/`requested`)     | `deployment.review_approved` / `.review_rejected` / `.review_requested`       | `approver` (approve/reject), `requestor` (requested)                    | `manual` (`deployment_review.<action>`)                         | `none`                                                                                                       |
| `deployment_protection_rule` (`requested`)                  | `deployment.protection_rule_requested`                                        | `sender`                                                                | from `event`                                                    | `pending`                                                                                                    |
| `push`                                                      | `ref.pushed`, `ref.created`, `ref.deleted`                                    | `sender` (fallback `pusher.name`)                                       | `push` (`tag` for a created tag)                                | `none`                                                                                                       |
| `pull_request` (`opened`/`reopened`/`synchronize`/`closed`) | `pull_request.opened` / `.reopened` / `.synchronized` / `.closed` / `.merged` | `sender`; `merged_by` for merges                                        | `pull_request`                                                  | `none`                                                                                                       |
| `repository_dispatch`                                       | `repository_dispatch.received`                                                | `sender` (usually an App or token owner)                                | `api`                                                           | `none`                                                                                                       |

`workflow_run.event` → `trigger.type` (`sourceValue` keeps the GitHub value):
`push`→`push`; `pull_request`, `pull_request_target`, `pull_request_review[_comment]`→`pull_request`;
`merge_group`→`merge_queue`; `workflow_dispatch`→`manual`, or `api` when the dispatching
actor is a bot/App; `schedule`→`schedule`; `repository_dispatch`→`api`; `workflow_run`
(chained), `deployment`, `deployment_status`→`upstream`; `release`→`release`;
`dynamic`→`system`; anything else→`unknown`. A run with `run_attempt > 1` is `rerun`
with the original trigger in `detail`.

Honest limits:

- **API vs UI dispatch.** GitHub's payloads do not say whether a `workflow_dispatch` came
  from the UI or from a user's token calling the REST API; both are `manual` with a
  `detail` saying so. Only a dispatch by a bot/App (`[bot]`, `type: Bot`) is `api`.
- **Reusable (called) workflows** (`workflow_call`) have no run or event of their own:
  they are listed in `data.referencedWorkflows` (`path`, `sha`, `ref`) of the caller's run,
  and their jobs arrive as `workflow_job` events of the caller ("caller job / called job").
- **`schedule` actor** is whoever last changed the cron, as GitHub reports it.
- `push`, `pull_request`, `repository_dispatch` and `deployment_protection_rule` webhooks
  arrive only if the operator grants the optional permissions (`contents`,
  `pull_requests`) or registers the App as a protection rule (needs `deployments: write`,
  which Afe never asks for). Without them, the same triggers are still captured via
  `workflow_run.event`.

Not recorded, by design: `workflow_job` queued/in_progress/waiting (no new facts;
approvals come from `deployment_review`, deployments from `deployment`), the
`workflow_dispatch` webhook (needs `contents`; the run carries the dispatcher; its
`inputs` may be sensitive), `create`/`delete` (the `push` event already reports
`created`/`deleted`), `check_suite`/`check_run` (third-party CI is out of scope; Actions
is covered by `workflow_run`), `release`, and any other
event. These are acknowledged and ignored.

### Correlation (AFE-15)

Per [research 0001](../research/0001-cross-tool-flow.md#what-the-connectors-must-capture):

- every event: `repositories` (`github.com/owner/name`, plus a fork's head repository);
- `workflow_run`/`workflow_job`/reviews: `commitShas` = `head_sha`, `refs` = `head_branch`,
  `runIds` = `github:<run id>`, `pullRequests` from `pull_requests[]`; jobs add
  `environments` when the payload carries one;
- deployments and statuses: `commitShas` = `sha`, `refs` = `ref` (unless it is a SHA),
  `environments`, `deploymentIds` = `github:<id>`, `runIds` from the linked run;
  statuses: `deploymentUrls` = hosts of `environment_url`/`target_url`;
- `push`: `commitShas` = `commits[].id` + `after`, `refs` = `ref`, `data.headCommit`;
- `pull_request`: `commitShas` = `head.sha` (+ `merge_commit_sha` when merged),
  `refs` = base (and head, same repository only), `pullRequests`;
- `push` and `pull_request`: `upstreamCommitShas` = full SHAs found in commit
  messages / the PR body. The text itself is never put in the event. (Before AFE-18
  these keys were written to `data.correlationHints`.)

`refs` are fully qualified where GitHub says what they are (`push.ref`, PR base/head,
`repository_dispatch.branch`). `workflow_run.head_branch` and `deployment.ref` can be a
branch or a tag, so they are stored as given (e.g. `main`); match those by commit SHA.

### Idempotency keys (shared with AFE-8)

Built by `event-ids.ts`; polling must use the same builders on REST objects
(`workflowRunTransition(run.status)` maps REST states to transitions).

| Object                  | `sourceEventId`                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| workflow run transition | `workflow_run:<run id>:<run_attempt>:requested\|in_progress\|completed`                                           |
| workflow job            | `workflow_job:<job id>:completed`                                                                                 |
| deployment              | `deployment:<deployment id>:created`                                                                              |
| deployment status       | `deployment_status:<status id>`                                                                                   |
| deployment review       | `deployment_review:<run id>:<run_attempt>:<envs sorted, comma-joined>:<reviewer id>:approved\|rejected`           |
| review requested        | `deployment_review:<run id>:<run_attempt>:<envs>:requested` (webhook only)                                        |
| protection rule         | `deployment_protection_rule:<deployment id>:<environment>:requested` (webhook only)                               |
| push                    | `push:<repository id>:<ref>:<before>:<after>`                                                                     |
| pull request            | `pull_request:<id>:opened\|merged`, `…:synchronize:<head sha>`, `…:closed:<closed_at>`, `…:reopened:<updated_at>` |
| repository dispatch     | `repository_dispatch:<repository id>:<delivery id>`                                                               |

Two refinements of docs/event-model.md: the review key includes `run_attempt` (a re-run
needing approval again by the same reviewer is a new event), and `repository_dispatch`
is keyed by the delivery id, the only exception to that rule: a dispatch has no id, time
or REST representation, so polling can never see it, and GitHub keeps the delivery GUID
on redelivery (which the replay guard drops anyway).

### Raw payloads (R8)

The delivery body is stored in `raw_payloads` as received, except: every non-null
`email` member (commit author/committer, pusher, user objects) and `pull_request.body`
are removed. Then the stored body is the re-serialised JSON and `observation.detail`
lists the removed paths; otherwise it is the exact signed bytes. Kept: commit messages
and run display titles (commit metadata), deployment review comments (the reviewer's
reason), and the caller-supplied `deployment.payload` and
`repository_dispatch.client_payload`. Those two are arbitrary data and may contain
personal data; they are never copied into `data`.

### To verify against docs / a test org

Written without access to GitHub docs or a real org
(https://docs.github.com/en/webhooks/webhook-events-and-payloads,
https://docs.github.com/en/rest/actions/workflow-runs,
https://docs.github.com/en/rest/deployments). Check:

- `deployment_review` payload: `approver`, `workflow_job_runs[].environment`,
  `workflow_job_run` / `environment` / `requestor` / `reviewers` on `requested`, whether
  `workflow_run.run_attempt` is present, and which timestamp best marks the review
  (Afe uses the job runs' `updated_at`).
- Whether REST `GET /actions/runs/{id}/approvals` lists approvals of earlier attempts
  (AFE-8 must attach the right `run_attempt`).
- `deployment.creator` for Actions-created deployments (the triggering user or
  `github-actions[bot]`), and that `deployment`/`deployment_status` include `workflow_run`.
- `workflow_job` payloads: whether any field names the job's `environment`.
- `deployment_protection_rule` payload fields (`event`, `deployment_callback_url`).
- `push.repository.pushed_at` is epoch seconds and is the push time.
- `workflow_run.head_branch` for tag-triggered runs (tag name?).
- **Manual "done when" check:** in a test org, trigger each row of the table above
  (push, PR, UI dispatch, `gh workflow run` with a PAT and with an App token, schedule,
  re-run by another user, a reusable workflow, `repository_dispatch`, a workflow chained
  by `workflow_run`, an environment with required reviewers approved once and rejected
  once, a REST-created deployment) and compare the events with the fixtures.

## Artifacts

- Issue: AFE-21. Code: `packages/connector-github/src/artifact.ts` (attestation and
  label parsing, `lookupProvenance`, `artifactProvenanceEvent`), `packagePublication` /
  `artifactPublishedEvent` in `mapping.ts`, `packageVersionEventId` /
  `artifactProvenanceEventId` in `event-ids.ts`, and the package branch of
  `processGitHubWebhook` plus `runArtifactProvenanceJob` in
  `apps/server/src/connectors/github.ts`.
- Fixtures: `test/fixtures/webhooks/registry_package.published.json`,
  `test/fixtures/attestations.ts`.

Goal: link each image Afe sees deployed (ArgoCD, by digest) to the commit and the
workflow run that built it.

### What is recorded

`registry_package` (and the newer `package` event, mapped identically) with action
`published` or `updated`, for **container** packages linked to a selected repository:

| Field                      | Value                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `action`                   | `artifact.published`                                                                                        |
| `actor`                    | `sender` (usually `github-actions[bot]`)                                                                    |
| `target`                   | `{type: other, id: ghcr.io/<namespace>/<name>@sha256:…, name: ghcr.io/<namespace>/<name>, repository, url}` |
| `trigger`                  | `upstream` when pushed by `github-actions[bot]` or attested (detail names the run), else `unknown`          |
| `outcome`                  | `none`                                                                                                      |
| `occurredAt`               | `package_version.created_at` (`published`) / `updated_at` (`updated`)                                       |
| `correlation.imageRefs`    | `ghcr.io/<namespace>/<name>:<tag>@sha256:<hex>` per tag (`…@sha256:<hex>` when untagged)                    |
| `correlation.imageDigests` | the version digest (`package_version.name`, else `container_metadata.tag.digest` / `.manifest.digest`)      |
| `correlation.repositories` | the package's repository, plus the provenance repository                                                    |
| `correlation.commitShas`   | provenance commit (attestation, else OCI label `org.opencontainers.image.revision`; full SHAs only)         |
| `correlation.runIds`       | `github:<run id>` from the attestation's `runDetails.metadata.invocationId`                                 |
| `correlation.refs`         | the attested workflow ref (`refs/heads/main`)                                                               |
| `data.provenance`          | `source` (`attestation`/`oci_labels`), `verification: "unverified"`, commit, run id/attempt, workflow, …    |
| `data.provenanceLookup`    | outcome of the attestation lookup: `resolved`, `not_found`, `failed` or `not_attempted`, with a detail      |

Tags come from `container_metadata.tag.name` and, when present, `metadata.container.tags`
(the REST package version shape), so a delivery that lists several tags keeps all of them.
Not recorded: other actions, non-container ecosystems (npm, Maven, …), versions without a
`sha256:` digest, packages not linked to a repository (no repository to select or to read
attestations from). They are acknowledged and ignored.

### Provenance: design

Stored events are immutable, so provenance is never added to an event afterwards:

1. **Inline, bounded.** While processing the delivery, Afe calls
   `GET /repos/{owner}/{repo}/attestations/{digest}` once (timeout 5 s, no retries), takes
   the first DSSE envelope whose in-toto statement has predicate
   `https://slsa.dev/provenance/v1` and lists the digest as a subject, and reads
   `buildDefinition.resolvedDependencies[].digest.gitCommit`,
   `runDetails.metadata.invocationId` (`https://github.com/<o>/<r>/actions/runs/<id>/attempts/<n>`),
   `externalParameters.workflow` and `internalParameters.github.event_name`. SBOM and other
   attestations are skipped. Whatever happens, `artifact.published` is then ingested with the
   base facts; a failed or empty lookup never blocks or fails ingestion.
2. **Fallback.** Without an attested provenance, the OCI labels GitHub copies into the
   payload (`container_metadata.labels.revision` / `.source`, or `all_labels`) are used,
   marked `source: "oci_labels"`.
3. **Late attestation.** `actions/attest-build-provenance` usually runs _after_ the push,
   so the first lookup often finds nothing. Then a `github.artifact-provenance` job is
   enqueued (delays 1 min, 5 min, 30 min; one job at a time; lookup errors do not throw,
   so the schedule is the retry policy). When it finds the attestation it ingests a
   separate **`artifact.provenance_resolved`** event (`sourceEventId`
   `artifact_provenance:<repository id>:<digest>`, `observation.method = poll`, actor
   `unknown`, same `imageRefs`/`imageDigests` plus `commitShas`/`runIds`/`refs`, raw
   payload = the attestation). It links to the artifact by digest and to the run by run id
   and commit. After the last attempt Afe gives up (logged).

This was chosen over delaying ingestion until the attestation exists (which would hold back
or lose base facts) and over mutating the stored event (forbidden). The artifact event's
raw payload is the webhook delivery; `data.provenance.statementSha256` is the SHA-256 of the
decoded statement, so it can be matched against GitHub's copy.

**Attestation signatures are not verified** (follow-up). `data.provenance.verification` is
always `"unverified"` and `note` says "unverified attestation"; treat the commit/run as the
attestation's claim. OCI labels are a claim of whoever built the image.

`triggeredBy` is not set on `artifact.published`: the person behind a CI build is on the
linked `workflow_run` events (same `runIds`); Afe does not fetch the run again.

Configuration (`createGitHubModule({ artifacts })`): `provenance` (env
`AFE_GITHUB_ARTIFACT_PROVENANCE=false` disables lookups), `lookupTimeoutMs`,
`followUpTimeoutMs`, `retryDelaysMs` (`[]` disables follow-ups).

### Permissions

`packages: read` (the `registry_package` webhook) and `attestations: read` (the lookup) are
**optional**: the manifest requests both, but `checkPermissions` does not require them.
Without `packages` the delivery is ignored (logged "artifact capture disabled"; GitHub does
not send it anyway); without `attestations` no lookup is made (`provenanceLookup.status =
not_attempted`) and only labels are used. Both show up in
`config.permissionCheck.optionalMissing` while not granted. Installations created before
AFE-21 must accept the App's new permissions (`new_permissions_accepted` refreshes the
check).

### Idempotency

| Object          | `sourceEventId`                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------ |
| package version | `package_version:<version id>:published\|updated:<tags sorted, comma-joined, "-" when untagged>` |
| late provenance | `artifact_provenance:<repository id>:<digest>`                                                   |

The tags are part of the version key because GitHub may report one version (digest) more
than once as tags are added; a redelivery carries the same tags and dedupes. `registry_package`
and `package` deliveries of the same publication produce the same key. A long tag list is
replaced by `sha256-<hex>` of it.

### Not done (follow-ups)

- **Reconciliation of package versions.** It would need `GET /orgs/{org}/packages?package_type=container`
  (filtered to packages linked to selected repositories) and
  `GET /orgs/{org}/packages/container/{name}/versions` per package each pass (users:
  `/users/{user}/packages/…`), plus attestation lookups for new versions. Not cheap per
  pass, and REST lists the version's _current_ tags (a different key from webhooks), so it is
  left for a follow-up; missed deliveries can be redelivered from GitHub.
- **Reading OCI labels from the registry** (image index → manifest → config blob on
  ghcr.io) when the webhook has none: GHCR documents only personal access tokens (classic)
  and `GITHUB_TOKEN` for registry access, not GitHub App installation tokens, so this is not
  possible with read-only App permissions. Labels are only taken from the webhook payload.
- **Verifying attestations** (Sigstore bundle: certificate chain to GitHub's / Sigstore's
  root, transparency log or timestamp, certificate identity = the expected workflow).
- Add `artifact.provenance_resolved` to core `ACTIONS` and docs/event-model.md (the
  validator already accepts it).

### To verify against docs / a test org (AFE-21)

Written without access to GitHub docs
(https://docs.github.com/en/webhooks/webhook-events-and-payloads#registry_package,
https://docs.github.com/en/webhooks/webhook-events-and-payloads#package,
https://docs.github.com/en/rest/repos/attestations,
https://docs.github.com/en/rest/packages/packages):

- That `attestations` is the GitHub App permission name (manifest key) for the attestations
  API, and that registering a manifest with it works; otherwise remove it from
  `REQUESTED_OPTIONAL_PERMISSIONS`.
- That `registry_package` needs `packages: read` and is subscribable by an App; whether the
  newer `package` event carries `container_metadata` (Afe subscribes to `registry_package`).
- `registry_package` payload: `registry_package.package_type`/`ecosystem` value for containers
  (`CONTAINER`), `namespace`, `package_version.name` = digest, `container_metadata.tag`,
  `container_metadata.labels` (incl. `all_labels`), and whether one delivery is sent per tag
  (as `published` or `updated`) when several tags are pushed.
- Attestations response: `attestations[].bundle.dsseEnvelope.{payload,payloadType}`; whether
  `bundle` can be null with only `bundle_url` (then Afe finds nothing; fetching `bundle_url`
  is not implemented), 404 vs empty list when there are none, the digest in the path unencoded.
- SLSA predicate written by `actions/attest-build-provenance`: field names above, and
  `invocationId` format.
- **Manual "done when" check:** in a test org, push an image with
  `docker/build-push-action` + `actions/attest-build-provenance` and check that
  `artifact.published` (labels only) is followed by `artifact.provenance_resolved` with the
  run id and commit; push a second tag for the same digest.

## Reconciliation

- Issue: AFE-8. Code: `packages/connector-github/src/reconcile.ts` (pure pass over one
  repository, budget maths), the `github.reconcile`, `github.reconcile-repo` and
  `github.backfill` jobs and the `backfill` health hook in
  `apps/server/src/connectors/github.ts`, migration `0013_github_poll_state.sql`.
- Tests: `packages/connector-github/test/reconcile.test.ts` and
  `apps/server/test/github-reconcile.test.ts`, against a local fake of the REST API
  (`packages/connector-github/test/fake-repo-api.ts`) serving the same objects as the
  AFE-7 webhook fixtures.

Webhooks can be missed (failed deliveries, Afe down, webhooks switched off on the App),
so every selected repository is also re-read through the REST API and compared with
what Afe already stored. Whatever is missing is ingested, built by the **same AFE-7
builders** (`workflowRunEvent`, `deploymentEvent`, `deploymentStatusEvent`, the
review/push/pull request builders) from the REST objects, so it gets exactly the
`sourceEventId` the webhook would have produced ([keys](#idempotency-keys-shared-with-afe-8)).
Ingestion is first-stored-wins (docs/event-model.md): a webhook arriving after the poll
is a duplicate, and a poll after the webhook adds nothing for that transition.

| `observation.method` | When                                                                           | `observation.detail` starts with                                    |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `reconciliation`     | routine passes, and the re-read of an observation gap (health `backfill` hook) | `discovered by reconciliation (not recorded from a webhook): GET …` |
| `backfill`           | history imported when an installation is connected (first install)             | `history imported by backfill: GET …`                               |

The detail also names the endpoint, any reconstructed transition, approximations (see
below), the gap or window it belongs to, and fields removed from the raw payload. The
raw payload is the REST object the event was built from, re-serialised with the same
R8 redaction as webhooks (`email` members, pull request bodies); deployment status
events store `{ deployment_status, deployment }`.

### What one pass reads

For a repository and a window `[from, to]` (routine: `now − AFE_GITHUB_RECONCILE_LOOKBACK`
to now, so consecutive passes overlap):

| Object                                   | Endpoint                                                   | Notes                                                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workflow runs                            | `GET /repos/{o}/{r}/actions/runs?created=…&per_page=100`   | Routine passes use `created=>=<day of from>` (a stable URL for the day, so ETags can match). GitHub returns at most 1000 runs per `created`-filtered query: when `total_count` exceeds it, the window is halved until it fits.    |
| earlier attempts of a re-run             | `GET …/actions/runs/{id}/attempts/{n}`                     | Only for attempts whose `completed` event is not recorded yet (up to 10).                                                                                                                                                         |
| runs still open after leaving the window | `GET …/actions/runs/{id}` (conditional)                    | Runs seen queued/waiting/in progress are remembered (35 days at most) and re-read until completed, so long runs and runs waiting for approval still get `completed`.                                                              |
| environment approvals                    | `GET …/actions/runs/{id}/approvals`                        | Only for runs found missing (a webhook gap) on their first attempt, see limits.                                                                                                                                                   |
| deployments                              | `GET /repos/{o}/{r}/deployments?per_page=100`              | Newest first, until older than `from`.                                                                                                                                                                                            |
| deployment statuses                      | `GET …/deployments/{id}/statuses` (conditional)            | For deployments created in the window and deployments whose latest status was not final (`success`, `failure`, `error`, `inactive`). The linked run is found from the status `log_url`/`target_url` (`/actions/runs/<id>/job/…`). |
| pushes, pull requests                    | `GET /repos/{o}/{r}/events` (conditional, at most 3 pages) | Only if the installation granted `contents` (pushes) / `pull_requests` (pull requests): the same permissions the push / pull_request webhooks need. Without them Afe does not record those events from any feed.                  |

Workflow jobs (`workflow_job.completed`) are **not** reconciled: the REST job has no
`sender`, and jobs add detail, not new deployments (the run and its deployments are
reconciled). `repository_dispatch`, `deployment_review.requested` and
`deployment_protection_rule` have no REST representation and stay webhook-only.

### Which run transitions are reconstructed

REST shows a run's current state, not its history. Afe records only what it can state
honestly:

| REST `status`                               | Events recorded                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `queued`, `requested`, `waiting`, `pending` | `workflow_run.requested` (`occurredAt` = `created_at`)                                          |
| `in_progress`                               | `requested` + `workflow_run.in_progress` (`run_started_at`)                                     |
| `completed`                                 | `requested` (`created_at`) + `workflow_run.completed` (`updated_at`, outcome from `conclusion`) |

`in_progress` is **not** reconstructed for a run first seen completed: Afe cannot tell
when (or whether) it started, because `run_started_at` is set for runs that never left
the queue. A reconstructed `requested` says so in `observation.detail`; its `data.status`
/ `data.conclusion` are the run's state when Afe read it. These are the same timestamp
rules the webhook builder applies, so a later webhook for the same transition would have
recorded the same time.

### Poll state, ETags and rate limits

- `github_poll_state` (migration 0013) holds, per (connection, repository, endpoint and
  page): the `ETag` of the last response that was **fully processed**, the next-page URL,
  the ids on a deployments page, and per repository the open runs / deployments and the
  events API's `X-Poll-Interval`. Only ids, URLs and timestamps — never bodies or
  credentials. Rows untouched for 40 days are pruned by the scheduler.
- Routine passes send `If-None-Match`. A `304 Not Modified` does not count against the
  primary rate limit; it means the page is identical to one already processed, so it is
  skipped. A repository where nothing changed costs zero counted requests.
- `GitHubHttp` tracks `x-ratelimit-limit/remaining/reset` per installation and refuses
  to call an exhausted bucket before its reset; `403`/`429` rate-limit answers (primary,
  or secondary with `retry-after`, else one minute) raise `GitHubRateLimitError`.
- On a rate limit a pass calls `ctx.health.reportFailure(…, "rate_limited", …, retryAfter)`
  and re-enqueues itself with `startAfter = retryAfter` (it does not throw, so the queue
  does not retry early). Network errors report `unreachable`, `401/403` `unauthorized`,
  other API errors `error`; a `404` for the repository (removed from the installation)
  skips it. Every successful pass reports `reportSuccess(…, { via: "poll" })`
  (`"backfill"` for install history). Connections for which `canAttempt` is false
  (backing off) are not polled.

### Scheduling and budget

`github.reconcile` runs every 5 minutes (cron). For each active GitHub connection it
reads the selected repositories (the connection's list, or `GET /installation/repositories`
for "all", conditionally) — the same selection rule as webhooks (`isRepositorySelected`);
unselected repositories are never read. It computes the connection's interval and
enqueues a `github.reconcile-repo` job for every repository whose last scheduling is
older than the interval, spread evenly over the interval (`startAfter`), with a
`singletonKey` per repository.

```
interval = max(AFE_GITHUB_RECONCILE_INTERVAL,
               repos × 4 / (limit × 0.5) hours,
               repos × 4 / (remaining × 0.5 / time until reset))      capped at 6 h
```

- `limit` is the installation's `x-ratelimit-limit` (baseline **5,000 requests/hour per
  installation**; GitHub raises it for organisations with many repositories and users,
  up to 12,500, and 15,000 on Enterprise Cloud), `remaining`/reset the last seen values.
- `4` is the worst-case counted requests of a pass where everything changed (runs,
  deployments, one statuses page, events). Unchanged endpoints are 304s and cost nothing,
  so real use is far below the plan.
- `0.5` keeps half of the budget for webhooks' follow-up reads, health probes and backfills.
- Example: 5-minute base, 5,000/h: up to 5000 × 0.5 / (12 × 4) ≈ 52 repositories are
  polled every 5 minutes; 1,000 repositories every 1.6 h; with a 12,500 limit, every 38 min.
  When only 100 requests remain for the next 30 minutes, 40 repositories are spaced 96 min apart.

### First-install backfill and gaps

- When an installation is connected (`installation.created` webhook or the setup
  callback), `github.backfill` is enqueued **once** per connection (row in
  `github_backfills`), for `AFE_GITHUB_BACKFILL_DAYS` (default 30) up to now. It reads
  every selected repository in turn (unconditionally, without touching the routine poll
  state), with `observation.method = backfill`. On a rate limit it re-enqueues itself
  after the reset, remembering the repositories already done. The scheduler also enqueues
  it for any active connection that never had one (e.g. connected before AFE-8).
- `health().backfill(connection, from, to)` (called by `health.backfill` after an
  observation gap closes, AFE-13) re-reads `[from − AFE_GITHUB_RECONCILE_LOOKBACK, to]` for
  every selected repository with `method = reconciliation`; the extra lookback catches runs
  created before the gap that changed state during it. On a rate limit it reports it and
  throws, so the health job retries.

### Configuration

| Variable                        | Default | Meaning                                                                              |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `AFE_GITHUB_RECONCILE`          | `true`  | `false` disables polling, install backfill and the gap hook                          |
| `AFE_GITHUB_RECONCILE_INTERVAL` | `5m`    | Shortest interval between passes of one repository (scaled up by the budget formula) |
| `AFE_GITHUB_RECONCILE_LOOKBACK` | `24h`   | Window of a routine pass (overlap between passes), and extra lookback before a gap   |
| `AFE_GITHUB_BACKFILL_DAYS`      | `30`    | History imported on first install (`0` disables)                                     |

`createGitHubModule({ reconcile: { … } })` overrides them (also `budgetShare`, `schedule`).

`AFE_GITHUB_BACKFILL_DAYS` and `AFE_GITHUB_RECONCILE_LOOKBACK` never exceed the event
retention window (`AFE_EVENT_RETENTION_DAYS`, ADR 0008): a longer value is clamped to it
with a log line, and every pass starts no earlier than the retention cutoff. Events older
than the window would be dropped at ingestion anyway.

### Honest limits

- **Approvals.** `GET …/runs/{id}/approvals` has no timestamp and no run attempt. Afe reads
  it only for runs found missing on their first attempt (for a re-run it cannot tell which
  attempt an approval belongs to, and the key includes it), and uses the run's `updated_at`
  as `occurredAt`, saying so in the detail. Webhook-recorded reviews keep their exact time.
- **Deployment ↔ run link.** REST deployments do not name their run. Afe links it from
  the status job URL; for a re-run whose deployment predates the current attempt the link
  is left out (trigger `api` with a detail saying the attempt is unknown). Deployments
  created through the API with no Actions status are `api`, as for webhooks.
- **Statuses on old deployments.** `inactive` statuses that GitHub adds to a deployment
  created before the window, after its last final status, are only found by webhook.
- **Events API (pushes, pull requests)** is eventually consistent (events appear seconds
  to minutes late), keeps at most 300 events and 90 days, lists at most 20 commits per
  push and does not report forced pushes (`data.forced` is `null`, `commitCount` is the
  push `size`). A busy repository can push more than 300 events between two passes:
  **those pushes / pull request transitions are lost to reconciliation**, and older history
  cannot be backfilled. A 403/404 from it (permission not granted) is noted and the API is
  not tried again for 24 h. Pushes are keyed by `before`/`head` exactly as the webhook keys
  `before`/`after`.
- **1000-run cap.** If more than 1000 runs are created within one minute the window cannot
  be split further; the pass notes that some may be missed.
- **Long-open runs** are tracked only from when Afe first saw them open; a run that started
  more than one lookback before a gap and finished during it is found by the open-run
  tracking only if a pass saw it open. Increase `AFE_GITHUB_RECONCILE_LOOKBACK` if runs
  regularly wait longer than a day.

### To verify against docs / a test org (AFE-8)

Written without access to GitHub docs or a real org
(https://docs.github.com/en/rest/actions/workflow-runs,
https://docs.github.com/en/rest/deployments/deployments,
https://docs.github.com/en/rest/deployments/statuses,
https://docs.github.com/en/rest/activity/events,
https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api,
https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). Check:

- `created` accepts `>=YYYY-MM-DD` and `YYYY-MM-DDTHH:MM:SSZ..YYYY-MM-DDTHH:MM:SSZ`, and
  `total_count` reports the full match count when over the 1000-result cap.
- Conditional requests with installation tokens return `304` and do not decrement
  `x-ratelimit-remaining`; whether `Link` is present on a 304 (Afe stores the next URL).
- `GET /deployments` is sorted newest first; statuses newest first.
- Actions deployment statuses carry `log_url`/`target_url` `…/actions/runs/<id>/job/<id>`.
- The approvals response shape (`state`, `user`, `environments[].name`, `comment`), that
  it lists approvals of all attempts, and whether a later API version adds a timestamp.
- Whether `run_started_at` is set for runs cancelled while queued (why `in_progress` is
  not reconstructed for completed runs).
- Events API: the permission an App installation needs for `GET /repos/{o}/{r}/events` on
  private repositories; whether the 2025 payload trimming removed `commits` from `PushEvent`
  and fields (`updated_at`, `closed_at`, `merged`, `merged_by`, `head.sha`) from
  `PullRequestEvent.payload.pull_request` (missing fields make Afe skip that event, noted);
  that `before` of a branch-creating push is all zeros as in the webhook; whether
  `synchronize` appears as a `PullRequestEvent` action.
- `x-ratelimit-limit` for installations on large organisations (the formula uses it).
- **Manual "done when" check:** in a test org, deactivate the App's webhook (App settings →
  uncheck "Active"), trigger a push run, a PR run, a manual dispatch, a re-run, a REST
  deployment with statuses and an approved environment deployment; after the next
  scheduler tick (≤ 5 min plus spread) every run and deployment must be in `/api/events`
  with `observation.method = reconciliation`. Then re-enable the webhook, redeliver one
  delivery from GitHub's "Recent deliveries" and check it is a duplicate.

## Install flows

### Connecting an organization (hosted and self-host)

1. `GET /api/connections/github/install` sets a short-lived HttpOnly cookie with a
   random nonce and redirects to `https://github.com/apps/<slug>/installations/new?state=…`.
   The `state` is HMAC-signed, expires after 15 minutes and contains the tenant and
   the nonce hash.
2. On GitHub the org owner chooses **All repositories** or **Only select repositories**.
3. GitHub redirects to the App's setup URL, `GET /api/connections/github/setup?installation_id=…&setup_action=install&state=…`.
   Afe verifies the state against the cookie, reads the installation with the App
   JWT (it must belong to this App), lists the selected repositories with an
   installation token, upserts the connection and records `connection.created`.
   - `setup_action=request` (a member asked an owner to approve) → `202 pending_approval`;
     the `installation.created` webhook completes it later.
   - A bad/expired/forged state or a missing cookie → `400`.
   - An installation already connected to another tenant → `409`. A new claim
     must come from a flow that started before the installation was created.
4. The `installation.created` webhook arrives independently and is idempotent with step 3.

Because `setup_on_update` is on, changing the repository selection on GitHub
also redirects to the setup URL; the `installation_repositories` webhook carries
the change either way.

**Single-tenant self-host:** installations of your own App that were not started
from Afe (no `state`, e.g. installed from the App's GitHub page) are adopted into
the `default` tenant. Disable with `AFE_GITHUB_ADOPT_INSTALLATIONS=false`; the
hosted service always disables it (`adoptInstallationsInto: null`).

**Authentication (ADR 0006):** the install start, setup callback and manifest
routes need an admin session; the setup callback must come from the tenant
that started the flow. A browser without a session is sent to the login page
and back.

**Installer verification (hosted, AFE-27).** `installation_id` in the setup
redirect can be edited, so on a multi-tenant instance a user could try to
claim an installation they do not own. Set `AFE_GITHUB_VERIFY_INSTALLER=true`
with the App's `AFE_GITHUB_APP_CLIENT_ID` / `AFE_GITHUB_APP_CLIENT_SECRET`, and
enable **Request user authorization (OAuth) during installation** on the App.
GitHub then adds a `code` to the setup redirect; Afe exchanges it
(`POST https://github.com/login/oauth/access_token`), checks the installation
is in `GET /user/installations`, revokes the user token and only then connects
(otherwise `403`). Self-host default: off. The risk there is small (single
tenant, admin session, signed browser-bound state, installation must not
predate the flow), but enable it if several people administer installations.

### Registering the App (self-host)

**Option A — one click (App Manifest flow).** Set `AFE_PUBLIC_URL` to the
address GitHub can reach (e.g. `https://afe.example.com`), make sure
`AFE_ENCRYPTION_KEY` is set, and open
`/api/connections/github/manifest` (or `?org=<org>` to create the App owned by an
organization). The page posts the manifest (`packages/connector-github/app-manifest.json`
shows its shape) to GitHub; after you confirm, GitHub redirects to
`/api/connections/github/manifest/callback`, where Afe exchanges the code
(`POST /app-manifests/{code}/conversions`) and stores the private key, webhook
secret and client secret encrypted in `credentials` (table `github_apps` holds
the App id and slug). The flow is only available while no App is configured and
is closed afterwards. The App is private (installable only on the owning account).

**Option B — by hand / from the environment.** Create a GitHub App with the
permissions and events above, webhook URL `<public url>/webhooks/github`,
setup URL `<public url>/api/connections/github/setup` ("Redirect on update" on), and
set:

| Variable                                                          | Meaning                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `AFE_GITHUB_APP_ID`                                               | Numeric App id                                                                    |
| `AFE_GITHUB_APP_PRIVATE_KEY` or `AFE_GITHUB_APP_PRIVATE_KEY_FILE` | PEM private key (literal `\n` allowed), or a path to it (Docker/K8s secrets)      |
| `AFE_GITHUB_WEBHOOK_SECRET` (or `_FILE`)                          | Webhook secret                                                                    |
| `AFE_GITHUB_APP_SLUG`                                             | App slug from `https://github.com/apps/<slug>`                                    |
| `AFE_GITHUB_APP_CLIENT_ID`                                        | Optional                                                                          |
| `AFE_GITHUB_STATE_SECRET`                                         | Optional key for signing redirect state; defaults to one derived from the App key |
| `AFE_PUBLIC_URL`                                                  | Needed for the manifest flow                                                      |
| `AFE_GITHUB_ADOPT_INSTALLATIONS`                                  | `false` to require the Afe install flow for every installation                    |
| `AFE_GITHUB_VERIFY_INSTALLER`                                     | `true` to verify the installing user via OAuth (below)                            |
| `AFE_GITHUB_APP_CLIENT_SECRET` (or `_FILE`)                       | OAuth client secret; needed with `AFE_GITHUB_VERIFY_INSTALLER`                    |

Environment config wins over a manifest-registered App. A partly set
environment fails at startup.

The hosted service registers one public App the same way (Option B) and passes it
to `createGitHubModule({ app, adoptInstallationsInto: null, resolveTenant })`.

## Token handling

- **App JWT** (RS256, `iss` = App id, `iat` = now − 60 s, `exp` = now + 9 min,
  signed with `node:crypto`), cached until one minute before expiry. Used only for
  `GET /app/installations/{id}` and to mint installation tokens.
- **Installation tokens** (`POST /app/installations/{id}/access_tokens`) are fetched
  on demand, requested narrowed to `read` of the granted permissions, cached
  **in memory only** (keyed by tenant, installation and permissions) and refreshed
  5 minutes before GitHub's one-hour expiry. Concurrent callers share one mint.
  They are never persisted, logged or put in job payloads, and are dropped on
  uninstall, suspend and permission changes.
- The App private key and webhook secret come from the environment or from the
  encrypted `credentials` store (re-read every minute), and travel as `Secret`.

## REST client

`GitHubAppClient` / `InstallationClient` (fetch-based, `fetch` injectable):
`getInstallation`, `listRepositories`, `listWorkflowRuns`, `getWorkflowRun`,
`listDeployments`, `listDeploymentStatuses`, `getWorkflowRunAttempt`,
`listWorkflowRunApprovals`, `getDeployment`, a `paginate` helper following
`Link: rel="next"` (same host only, page cap), and `getPage` (one page, optionally
conditional with `If-None-Match`; a `304` is returned, not raised, AFE-8). Every request sends `User-Agent`,
`Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`.
Rate limits: `x-ratelimit-remaining/reset` are tracked per bucket (App JWT, each
installation) and an exhausted bucket is not called again before its reset;
`403`/`429` rate-limit responses (primary and secondary, `retry-after`) raise
`GitHubRateLimitError` with `retryAfter`. 15 s timeout, two retries with backoff
on 5xx/network errors, 10 MiB response cap, no automatic redirects. The only
non-GET calls are minting installation tokens and the one-time manifest
conversion; tests assert this.

## Health

`health().probe(connection)`: `GET /app/installations/{id}` with the App JWT,
then mint (or reuse) an installation token. `404` → `revoked`, suspended →
`unauthorized`, `401/403` → `unauthorized`, rate limit → `rate_limited` with
`retryAfter`, network → `unreachable`.

`health().backfill(connection, from, to)`: re-reads an observation gap, see
[Reconciliation](#first-install-backfill-and-gaps). Polling reports `reportSuccess`
(`via: "poll"` / `"backfill"`) and `reportFailure` as described there.

## References

- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
- https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
- https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
- https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-the-setup-url
- https://docs.github.com/en/webhooks/webhook-events-and-payloads (installation, installation_repositories, workflow_run, workflow_job, deployment, deployment_status, deployment_review)
- https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
- https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation

## To verify against docs / manually

Written without access to GitHub docs or a real org; check these:

- Which permission `deployment_review` requires for Apps (assumed covered by
  `deployments`/`actions` read), and that it is subscribable by an App.
- That the manifest conversion always returns `webhook_secret` when
  `hook_attributes` is set (Afe refuses the App otherwise).
- That the `installation.created` payload lists `repositories` for selected installs,
  and that `installation.updated_at` changes on suspend/unsuspend/permission acceptance
  (used in event ids).
- Setup URL query parameters (`installation_id`, `setup_action` values `install`,
  `update`, `request`) and that `state` is passed through for installs and updates.
- **Manual "done when" check:** register the App (manifest flow), install it on a
  test org with selected repositories, confirm the connection shows those repos, and
  use `InstallationClient.listWorkflowRuns` / `listDeployments` against them.

## Follow-ups

- Hosted multi-tenant: also verify the installing user can access the installation
  (enable "Request user authorization (OAuth) during installation", exchange the code
  and check `GET /user/installations`) before claiming it for a tenant. The
  nonce-bound state, cross-tenant `409` and "installation must be newer than the
  flow" checks reduce but do not remove the risk of claiming a guessed installation id.
- The install/manifest routes take the tenant from `resolveTenant` (default tenant)
  until the `AuthProvider`/`TenantResolver` exist; the manifest route must be admin-only then.
- GitHub Enterprise Server base URLs (would need `validateOutboundUrl`/`createSafeLookup`).
