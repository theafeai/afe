# GitHub connector

- Issue: AFE-6 (App and install flow). Event mapping is AFE-7, reconciliation and backfill AFE-8.
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

`POST /webhooks/github` (body limit 5 MiB):

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
   **Boundary with AFE-7:** in this issue the job handler is a deliberate no-op;
   AFE-7 passes `processWebhook` to `createGitHubModule` to map and ingest.
   Deliveries for installations not connected to any tenant are recorded (with
   `tenant_id = NULL`) and dropped.

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
