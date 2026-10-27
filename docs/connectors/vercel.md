# Connecting Vercel

Afe reads deployments of the Vercel projects you choose. It never changes
anything in Vercel. For the reasoning behind this design, see
[ADR 0005](../decisions/0005-vercel-connection-model.md).

## Option A: Vercel Integration (recommended)

The integration asks only for read permissions, and Afe stores a token that you
never handle yourself.

### Self-hosters: create the integration once

1. In Vercel, open Integrations Console > Create.
2. Set the **Redirect URL** to `<AFE_PUBLIC_URL>/api/connections/vercel/callback`.
3. Set the **Webhook URL** to `<AFE_PUBLIC_URL>/webhooks/vercel` and select the
   deployment events (`deployment.created`, `deployment.succeeded`,
   `deployment.error`, `deployment.canceled`, `deployment.promoted`) and
   `project.removed`.
4. Under **Permissions**, grant **Read** on User, Team, Projects and
   Deployments, and nothing else.
5. Configure Afe with the integration's values:

   | Variable                                                      | Value                                                          |
   | ------------------------------------------------------------- | -------------------------------------------------------------- |
   | `AFE_PUBLIC_URL`                                              | Public base URL of Afe, e.g. `https://afe.example.com`         |
   | `AFE_VERCEL_CLIENT_ID`                                        | Integration client id (`oac_…`)                                |
   | `AFE_VERCEL_CLIENT_SECRET` or `AFE_VERCEL_CLIENT_SECRET_FILE` | Client secret. It also verifies webhooks and signs OAuth state |
   | `AFE_VERCEL_INTEGRATION_SLUG`                                 | The slug in `https://vercel.com/integrations/<slug>`           |

   The three `AFE_VERCEL_*` values must be set together.

### Connect

1. Open `GET /api/connections/vercel/install`. Afe redirects you to Vercel.
2. In Vercel, choose the team (or personal account). Optionally limit the
   integration to specific projects there as well.
3. Vercel sends you back to Afe, which stores the token encrypted and creates
   the connection. Its id is the team id, or your user id for a personal
   account.
4. Choose the projects to observe (see below). Until you do, Afe observes nothing.

You must start the installation from Afe. An installation started from the
Vercel marketplace is rejected, because it has no signed `state`.

## Option B: Access token (fallback)

> **Warning:** Vercel access tokens cannot be limited to read-only. A token has
> full access to everything in its scope, with the role of the person who
> created it. Afe only sends `GET` requests with it, but anyone who obtains the
> token can do much more.

1. In Vercel, open Account Settings > Tokens > Create. Set **Scope** to the one
   team to connect and set an **expiry**. Create the token as a team member
   with the least-privileged role your plan offers (e.g. Viewer).
2. `POST /api/connections/vercel` with `{"token": "…", "teamId": "team_…"}`.
   Omit `teamId` for a personal account.
3. Optional webhooks (Pro/Enterprise): create a webhook in Team Settings >
   Webhooks for the deployment events, with the URL
   `<AFE_PUBLIC_URL>/webhooks/vercel/<team id>`. Then add its secret by
   reconnecting with `{"token": "…", "teamId": "…", "webhookSecret": "…"}`.
   Without webhooks, Afe relies on polling (AFE-12).

To rotate the token, `POST` again with the new token. The old credential is
destroyed.

## Choosing projects

- `GET /api/connections/vercel/:id/projects` lists the projects the connection
  can see and shows which ones are selected.
- `PUT /api/connections/vercel/:id/projects` takes `{"projectIds": ["prj_…"]}`,
  or `{"projectIds": []}` for none, or `{"projects": "all"}`. Unknown project
  ids are rejected.

Afe never requests deployments of unselected projects, and webhook events for
them are dropped.

## Disconnecting and revocation

- `DELETE /api/connections/vercel/:id` destroys Afe's stored token and marks
  the connection `disconnected`.
  - For integrations, Afe also asks Vercel to remove its installation. If that
    fails, the response says so; remove "Afe" in Team Settings > Integrations.
  - For tokens, delete the token in Vercel as well.
- If you uninstall the integration in Vercel, Vercel sends
  `integration-configuration.removed`. Afe then destroys the token and marks the
  connection `revoked`.
- If Vercel answers any call with 401 or 403 (token revoked or expired, access
  to the team lost), the connection becomes `revoked`, with the reason shown.
  Reconnect to resume.

## Permissions requested and why

| Permission  | Access | Used for                                                               |
| ----------- | ------ | ---------------------------------------------------------------------- |
| User        | Read   | `GET /v2/user`: identify the account (personal accounts, actor ids)    |
| Team        | Read   | `GET /v2/teams/{id}`: team name and health check                       |
| Projects    | Read   | `GET /v9/projects`: project selection; mapping deployments to projects |
| Deployments | Read   | `GET /v6/deployments`, `GET /v13/deployments/{id}`: the audited data   |

Afe uses only two non-GET calls, both to manage its own access:

- the OAuth code exchange, `POST /v2/oauth/access_token`;
- removing its own installation on disconnect, `DELETE /v1/integrations/configuration/{id}`.

Afe never stores environment-variable values. `env` and `build.env` fields are
stripped from every API response and webhook payload.

## Event capture

Afe records every way a Vercel deployment can happen, and who caused it, as
canonical audit events ([event model](../event-model.md)). Code:
`packages/connector-vercel/src/mapping.ts` (mapping), `capture.ts` (webhooks,
promotion/rollback state), `polling.ts` (poll, backfill, reconciliation), wired
in `apps/server/src/connectors/vercel.ts`; state in migration
`0011_vercel_capture_state.sql`.

### Sources of events

| Path                     | When                                                                                                                    | `observation.method` |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `vercel.webhook` job     | A signed deployment webhook arrived                                                                                     | `webhook`            |
| `vercel.poll` job        | Every 3 minutes per active connection (`vercel.poll.dispatch` cron, `pollSchedule` option), and after selection changes | `reconciliation`     |
| First poll / new project | History of the last 30 days (`backfillDays` option)                                                                     | `backfill`           |
| Health `backfill` hook   | AFE-13 re-observes `[from, to]` after an observation gap                                                                | `reconciliation`     |

Webhooks are for speed; correctness does not depend on them. With webhooks
disabled every event is still recorded, flagged `reconciliation`.

**Dedupe and "first wins".** Webhook and poll derive the same
`sourceEventId`, so a transition is stored once (ADR 0003). If the webhook was
first, the stored event says `webhook`. If the poll was first (the webhook was
missed or late), it says `reconciliation`, and the later webhook is dropped as
a duplicate. Polls leave transitions younger than 60 s (`settleMs`) to the next
poll, so a webhook on its way normally wins.

**Webhook processing.** The receiver (AFE-11) verifies, records the delivery
and queues `vercel.webhook` only for selected projects. The job re-checks the
selection, re-reads the deployment (`GET /v13/deployments/{id}`, scoped to the
project) for creator, `source` and Git metadata, and ingests. If that read
fails, the event is mapped from the payload alone (`data.enriched: false`,
actor from `payload.user.id`); a 401/403 also revokes the connection.

**Polling.** `GET /v6/deployments?projectId=&since=` (team-wide for "all
projects"), page by page via `until`, from the cursor minus a 10-minute
overlap (`overlapMs`). Deployments not yet finished are kept as "open" and
re-read by id until they finish (dropped after 24 h). The cursor moves only
when a whole pass succeeds. The client retries 429s; after that the pass fails
without moving the cursor. One poll per connection runs at a time (advisory
lock). Then each selected project's production deployment (`GET /v9/projects`,
`targets.production`) is compared with the last one seen.

### What each trigger produces

| Trigger                  | Recognised by                                                | `trigger.type` | `data.triggerKind` | Actor                                                                   |
| ------------------------ | ------------------------------------------------------------ | -------------- | ------------------ | ----------------------------------------------------------------------- |
| Git push                 | `source: "git"`                                              | `push`         | `git_push`         | Vercel `creator`; Git commit author as `triggeredBy`                    |
| Git pull request preview | `source: "git"` and `meta.githubPrId` (GitLab/Bitbucket ids) | `pull_request` | `git_pull_request` | as above                                                                |
| CLI (`vercel deploy`)    | `source: "cli"`                                              | `cli`          | `cli`              | `creator` (token owner)                                                 |
| API                      | `source: "api"` or `"api-trigger-git-deploy"`                | `api`          | `api`              | `creator` (token owner)                                                 |
| Deploy hook              | `meta.deployHookId` or `source: "deploy-hook"`               | `api`          | `deploy_hook`      | `token` `deploy_hook:<id>`, login = hook name; `onBehalfOf` = `creator` |
| Redeploy                 | `source: "redeploy"`                                         | `redeploy`     | `redeploy`         | `creator`                                                               |
| Dashboard import/clone   | `source: "import"`, `"import/repo"`, `"clone/repo"`          | `manual`       | `dashboard`        | `creator`                                                               |
| Anything else            | other or no `source`                                         | `unknown`      | `unknown`          | `creator`, else `unknown`                                               |

Each deployment produces `deployment.created` (outcome `pending`) and one
final event: `deployment.status_updated` with outcome `succeeded` (READY) or
`failed` (ERROR), or `deployment.cancelled` (CANCELED). Lifecycle events use
the creator as actor. The API does not report who cancelled, so the webhook's
`payload.user.id` is kept in `data.webhookUserId` only.

**Promotions and rollbacks** (`deployment.promoted`, `deployment.rolled_back`,
trigger `promotion`/`rollback`, outcome `succeeded`, target = the deployment
made live). Afe keeps the last production deployment per project. A change is:

1. what `project.lastAliasRequest` says (`type` promote/rollback naming the new
   deployment): `data.confidence: "reported"`, `occurredAt = requestedAt`;
2. a rollback if the new deployment is older than the previous one (instant
   rollback): `confidence: "inferred"`;
3. a promotion if a `deployment.promoted` webhook reported it (`reported`,
   actor `payload.user.id`);
4. a promotion if the new deployment was built for another target (preview
   promoted without a rebuild) or was already READY while the previous one was
   still live (staged production build): `inferred`;
5. otherwise a new production build went live by itself: no alias event.

The first observation of a project is a baseline (no event). Inferred events
without a source time have `occurredAt` = when Afe noticed, and
`data.occurredAtApproximate: true`.

### Idempotency keys

| Event                | `sourceEventId`                                                   |
| -------------------- | ----------------------------------------------------------------- |
| lifecycle            | `deployment:<dpl_id>:created\|succeeded\|failed\|cancelled`       |
| promotion / rollback | `production_alias:<project id>:<from dpl_id or none>:<to dpl_id>` |

The alias key names the transition, not its interpretation, so a webhook and
a poll that see the same change dedupe even if one calls it a promotion and
the other a rollback. A webhook for a change the poll already recorded reuses
the stored previous deployment. Limitation: the same from→to change repeated
(A→B, B→A, A→B) is stored once, as the first A→B event.

### Captured fields (AFE-15 correlation)

- `correlation`: `commitShas` (full SHA from `meta.githubCommitSha`, the GitLab
  and Bitbucket equivalents, or `gitSource.sha`), `refs` (`refs/heads/<branch>`),
  `repositories` (`github.com/<org>/<repo>`, falling back to the project's Git
  link, e.g. for CLI deploys), `pullRequests` (`<repo>#<id>`), `environments`
  (`production`, `preview`, `staging` or the custom environment slug),
  `deploymentIds` (`vercel:<dpl_id>`; alias events also list the previous
  one). Alias events read the live deployment to carry its commit.
- `data`: `projectId`, `projectName`, `deploymentUrl`, `target` (`preview` when
  Vercel's is null), `state` (as observed), `triggerKind`, `vercelSource`,
  `creator`, `deployHook`, `git` (provider, sha, branch, repo, author login and
  name, PR, `dirty` from `meta.gitDirty`), `aliasAssigned` (on `succeeded` and
  alias events; `false` for READY builds that did not get the domains). The
  deployment URL's lower-case host is in `correlation.deploymentUrls` (AFE-18;
  events recorded earlier have it in `data.correlationHints.deploymentUrls`).
- Commit messages are not copied into events (the raw payload keeps them).
- Raw payload: the API object for polls. For webhooks,
  `{ webhook: {id, type, createdAt, payload}, deployment }`, re-serialised
  after env values were stripped (jobs do not carry the exact bytes).

### Environment variables and domains

Not captured. Vercel offers no read-only feed of env var or domain changes
that Afe could use without broader access: the project env endpoints return
values (forbidden by the data inventory), and those changes are not part of
the deployment webhook events. Their effect is still recorded: a domain moving
to another deployment shows up as a production change, and an env var change
takes effect only with a new deployment.

### Health (AFE-13)

This module tracks no health itself. `createVercelModule({ onObservation })`
receives `{ ok: true }` after each webhook job, poll and reconciliation, or
`{ ok: false, reason, detail, retryAfter? }` with an observation-gap reason
(`auth_failed`, `permission_denied`, `rate_limited`, `source_unavailable`,
`connection_error`, `unknown`). The health hooks are `probe` and
`backfill(connection, from, to)`.

### To verify against the docs

References: [webhooks](https://vercel.com/docs/webhooks/webhooks-api),
[list deployments](https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments),
[get a deployment](https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-a-deployment-by-id-or-url),
[find a project](https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name),
[instant rollback](https://vercel.com/docs/instant-rollback),
[deploy hooks](https://vercel.com/docs/deploy-hooks).

1. Deployment `source` values (`git`, `cli`, `redeploy`, `import`,
   `import/repo`, `clone/repo`, `api-trigger-git-deploy`, `deploy-hook`?), and
   what plain API deploys report.
2. `meta.deployHookId`/`deployHookName`/`deployHookRef`, and who `creator` is
   for deploy-hook deployments.
3. Git meta keys for GitLab (`gitlabProjectPath`, `gitlabMergeRequestIid`, ...)
   and Bitbucket; `meta.gitDirty`; the `gitSource` shape.
4. That `/v6/deployments` items carry `source`, `meta`, `ready`, `canceledAt`,
   `aliasAssigned` and `creator`, and whether `ready` is set for ERROR.
5. `aliasAssigned` semantics (timestamp or boolean) and whether it is already
   set when `deployment.succeeded` fires.
6. That `/v9/projects` items include `targets.production` (if not, Afe reads
   `/v9/projects/{id}`) and `link`; the `lastAliasRequest` field names and
   `type` values.
7. Whether `deployment.promoted` fires for instant rollbacks and for automatic
   production aliasing; whether a separate rollback event exists; whether
   `payload.user` is the person who promoted or cancelled.
8. Event names: `deployment.ready` vs `deployment.succeeded`, the `canceled`
   spelling, legacy names (`deployment-ready`, ...).
9. Pagination `next` is a creation timestamp, so deployments sharing one
   millisecond across a page boundary could be skipped.
10. Custom environments: `customEnvironment.slug` on deployments.

### Still to verify manually (real Vercel team)

In a test project, with and without webhooks: a Git push, a PR preview,
`vercel deploy` and `vercel deploy --prod`, an API deploy, a deploy hook, a
redeploy, a promote, an instant rollback, a cancellation and a failed build.
Check that each produces the event above and that both paths dedupe.
