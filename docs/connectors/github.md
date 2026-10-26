# GitHub connector

- Issues: AFE-6 (App and install flow), AFE-7 (event capture, below). Reconciliation and backfill: AFE-8.
- Code: `packages/connector-github` (pure logic) and `apps/server/src/connectors/github.ts`
  (routes, jobs, health hooks).

Afe connects to GitHub as a **GitHub App** with read-only permissions. Each App
installation (one organization or user account) is one Afe connection
(`connections.source = "github"`, `external_id` = installation id, `name` = account login).

## Permissions

All permissions are repository permissions with `read` access. Afe never asks
for write access (docs/security/rules.md R1).

| Permission     | Access | Why Afe needs it                                                                                                                                                                                                                   |
| -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`     | read   | Mandatory for every GitHub App. Repository ids, names and the list of repositories in the installation.                                                                                                                            |
| `actions`      | read   | Workflow runs and jobs: REST `GET /repos/{o}/{r}/actions/runs` and the `workflow_run` / `workflow_job` webhooks. This is how Afe sees who triggered a run and how (push, PR, dispatch, schedule, API, re-run, reusable workflows). |
| `deployments`  | read   | Deployments and deployment statuses: REST `GET /repos/{o}/{r}/deployments[/{id}/statuses]` and the `deployment`, `deployment_status` and `deployment_review` webhooks (environment approvals and rejections).                      |
| `environments` | read   | Environments and their protection rules (required reviewers, branch policies), so Afe can tell what gated a deployment. Part of the R1 baseline; used by AFE-7/AFE-8.                                                              |

Not requested, by design:

| Permission      | Why not                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contents`      | Would allow reading source code. Commit SHA, ref, actor and trigger of every run and deployment are already on the `workflow_run` and `deployment` payloads, so `push` webhooks are not needed. An operator **may** grant `contents: read` to also get `push`/`create`/`delete`/`release` events; Afe still never downloads file contents. |
| `pull_requests` | Pull requests that triggered runs are listed on `workflow_run.pull_requests`. Optional, for `pull_request` events (`pull_request.merged`).                                                                                                                                                                                                 |
| `checks`        | `workflow_run`/`workflow_job` cover GitHub Actions; third-party CI via checks is out of scope for now.                                                                                                                                                                                                                                     |
| anything write  | Afe never changes anything in GitHub. It is not a deployment protection rule (that would need `deployments: write`).                                                                                                                                                                                                                       |

### Permission check

Every time Afe learns an installation's permissions (install, setup callback,
`new_permissions_accepted`), it runs `checkPermissions`:

- **writable**: any permission granted with `write`/`admin` (e.g. the App owner
  widened the App, or an operator registered the App by hand with too much access);
- **missing**: a required permission above that is not granted (the org owner has
  not accepted an update yet);
- **extra**: other read permissions (allowed, reported for review).

The result is stored in the connection's `config.permissionCheck`, a problem is
written to the connection's `status_reason` (e.g.
`write access granted (Afe needs read only): deployments`) and logged as a
warning. The connection stays `active`, because Afe can still observe what it
has access to; AFE-13 health surfaces the reason. Installation tokens are always
requested narrowed to `read` of what the installation granted, so even an
over-privileged installation only ever yields read-only tokens.

## Webhook events

Subscribed (manifest `default_events`): `workflow_run`, `workflow_job`,
`deployment`, `deployment_status`, `deployment_review`.

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

   | Delivery                                     | Connection                                 | Audit event (source `afe`)                            |
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
  (evidence redaction), and `processGitHubWebhook` in `apps/server/src/connectors/github.ts`.
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
is covered by `workflow_run`), `release`, `registry_package` (follow-up), and any other
event. These are acknowledged and ignored.

### Correlation (AFE-15)

Per [research 0001](../research/0001-cross-tool-flow.md#what-the-connectors-must-capture):

- every event: `repositories` (`github.com/owner/name`, plus a fork's head repository);
- `workflow_run`/`workflow_job`/reviews: `commitShas` = `head_sha`, `refs` = `head_branch`,
  `runIds` = `github:<run id>`, `pullRequests` from `pull_requests[]`; jobs add
  `environments` when the payload carries one;
- deployments and statuses: `commitShas` = `sha`, `refs` = `ref` (unless it is a SHA),
  `environments`, `deploymentIds` = `github:<id>`, `runIds` from the linked run;
  `data.correlationHints.deploymentUrls` = hosts of `environment_url`/`target_url`;
- `push`: `commitShas` = `commits[].id` + `after`, `refs` = `ref`, `data.headCommit`;
- `pull_request`: `commitShas` = `head.sha` (+ `merge_commit_sha` when merged),
  `refs` = base (and head, same repository only), `pullRequests`;
- `push` and `pull_request`: `data.correlationHints.mentionedCommitShas` = full SHAs
  found in commit messages / the PR body. The text itself is never put in the event.

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
`listDeployments`, `listDeploymentStatuses`, and a `paginate` helper following
`Link: rel="next"` (same host only, page cap). Every request sends `User-Agent`,
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
