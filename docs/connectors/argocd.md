# Connecting ArgoCD

Afe connects to ArgoCD read-only, in **pull mode**: it calls the ArgoCD API
with an API token of a dedicated account. You can connect any number of ArgoCD
instances. Design and alternatives: [ADR 0004](../decisions/0004-argocd-connection-model.md).

## 1. Create a dedicated read-only account

In `argocd-cm`, add a local account with **only** the `apiKey` capability (no
`login`, so it cannot use the UI or password login):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  accounts.afe: apiKey
```

In `argocd-rbac-cm`, give it a read-only role:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.csv: |
    p, role:afe-readonly, applications, get, */*, allow
    p, role:afe-readonly, projects, get, *, allow
    p, role:afe-readonly, clusters, get, *, allow
    g, afe, role:afe-readonly
```

| Policy line         | Why Afe needs it                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `applications, get` | List and watch applications; read sync status, operation state and history (who synced which revision). Required.          |
| `projects, get`     | Resolve project names/destinations for the audit target. Optional; drop it if you do not want Afe to see project settings. |
| `clusters, get`     | Map destination server URLs to cluster names. Optional; Afe falls back to the destination URL.                             |
| `g, afe, role:...`  | Binds the account to the role.                                                                                             |

The built-in `role:readonly` also works, but grants more reads than needed
(repositories, certificates, GPG keys, accounts, logs on some versions).

**Deliberately not granted** (Afe would reject the token if it had them):

- `applications, sync` / `override` / `action/*` / `update` / `create` /
  `delete`: these deploy, roll back, run resource actions or change apps. Afe
  observes deployments and must never be able to cause one.
- `exec, create`: opens a shell in workloads.
- `logs, get`: pod logs routinely contain secrets; Afe never stores logs
  (data inventory). Afe accepts the token but warns if this is allowed.
- `repositories`, `certificates`, `gpgkeys`, `accounts`: not needed.

Make sure `policy.default` in `argocd-rbac-cm` is empty or `role:readonly` at
most; a broader default role would apply to the Afe account too.

## 2. Generate a token

```sh
argocd login argocd.example.com --sso   # or as admin
argocd account generate-token --account afe --id afe-$(date +%Y%m) --expires-in 8760h
```

Store the token only in Afe. To rotate: generate a new token, reconnect
(Afe replaces and revokes the stored one), then
`argocd account delete-token --account afe <old-id>`.

**SSO (Dex or OIDC):** API tokens of local accounts are independent of SSO,
so this works unchanged when users log in through SSO. You can keep
`admin.enabled: "false"`; generate the token while logged in via SSO as a user
whose role may manage accounts (`accounts, update`).

## 3. Connect in Afe

```sh
curl -X POST http://afe.internal:8080/api/connections/argocd \
  -H 'content-type: application/json' \
  -d '{"url":"https://argocd.example.com","token":"<token>","name":"prod-eu","caPem":"<optional PEM>"}'
```

Afe then:

1. validates the URL (`https` only; private addresses need
   `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true` on a self-hosted Afe),
2. calls `GET /api/version`, `GET /api/v1/session/userinfo`,
   `GET /api/v1/applications` (names only),
3. runs the **read-only check**: `GET /api/v1/account/can-i/<resource>/<action>/<object>`
   for `applications` `sync`/`override`/`update`/`delete`/`create` and `exec create`,
   on `*`, `*/*` and up to five real `project/app` objects, plus `logs get`.
   Any write capability → `422 token_not_read_only` and nothing is stored. If
   `can-i` is unavailable the connection is saved with a warning,
4. stores the token encrypted (credential kind `argocd_api_token`) and the
   connection as `active`.

Other endpoints:

| Method and path                         | Effect                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| `GET /api/connections/argocd`           | List ArgoCD connections (never returns tokens).         |
| `POST /api/connections/argocd/:id/test` | Re-run the checks with the stored token.                |
| `DELETE /api/connections/argocd/:id`    | Revoke (destroy) the stored token, mark `disconnected`. |

Connecting the same URL again updates the connection in place (same id, so
history stays linked) and revokes the previous token.

> The admin API has no authentication yet (ADR 0002 `AuthProvider`). Do not
> expose the Afe API outside a trusted network until it does.

## TLS: private CA or self-signed certificate

Pass the CA certificate (or the self-signed server certificate) as `caPem`.
It is added to the default trust store for this connection only; verification
always stays on. Alternatively set `NODE_EXTRA_CA_CERTS` for the whole
process. `--insecure`-style options do not exist in Afe.

## Network

Afe needs HTTPS reach to the ArgoCD API (the same URL the `argocd` CLI uses;
gRPC-web is not needed). Use the final URL: Afe does not follow redirects.
For instances Afe cannot reach, an outbound in-cluster agent is designed in
ADR 0004 but not yet available.

## What Afe reads and stores

Reads: application metadata, spec source/destination/project, sync and health
status, operation state and history. Never manifests, resource trees, logs or
Secrets. Stored config: server URL, CA bundle, ArgoCD version, account name,
read-only check result. Event capture keeps per-application state (ids,
statuses, hashes, spec summary, image references): see [Event capture](#event-capture).

## Event capture

Code: `packages/connector-argocd/src/capture/` (pure mapping, state, watch and
reconciliation runtime), `apps/server/src/connectors/argocd.ts` (jobs and
health hooks), `apps/server/src/connectors/argocd-state.ts` and migration
`0010_argocd_capture_state.sql` (state store). Tests:
`packages/connector-argocd/test/capture.test.ts` (one per action, outage,
dedupe, deletions while down, against the fake server) and
`apps/server/test/argocd-capture.test.ts` (jobs, Postgres state, backfill).

### Signals

| Signal                                                                   | Used for                                                                                                                               | Method           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `GET /api/v1/stream/applications` (ADDED/MODIFIED/DELETED)               | Near real-time changes of every application.                                                                                           | `stream`         |
| `GET /api/v1/applications` (every 5 min and on every stream (re)connect) | Diff against the stored state: whatever the stream missed.                                                                             | `reconciliation` |
| `GET /api/v1/applications/{name}`                                        | Confirms that an application missing from the list is gone (404/403, or a different uid = recreated).                                  | `reconciliation` |
| `GET /api/v1/applications/{name}/events` (Kubernetes Events)             | Actor attribution for create/update/delete/rollback/terminate/refresh ("alice updated application spec"). Best effort; ~1 h retention. | –                |

All are covered by `applications, get`. Nothing is written to ArgoCD.

Both paths call the same `observeApplication(prev, app)`, serialised per
application (Postgres advisory lock), and emit only what changed relative to
the stored per-application state. Events that occurred before capture started
for the connection (`baseline_at`) are recorded with method `backfill`.

### What is recorded

| Action in ArgoCD                  | Event(s)                                                                                                            | How it is detected; certainty                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual sync (UI/CLI/API)          | `argocd.sync.started`, then `argocd.sync.succeeded` / `.failed` / `.terminated`                                     | `status.operationState`, `operation.initiatedBy.username`. Trigger `manual` (ArgoCD does not tell UI, CLI and API apart). Certain.                                                                                                                                                                                                                                                                                                                   |
| Auto-sync after a Git change      | same; actor `{type: system, id: argocd-application-controller}`, trigger `auto_sync`                                | `initiatedBy.automated: true` (certain). `data.autoSync.reason` = `git_change` / `self_heal_or_retry` / `first_sync` is inferred from history (`medium`). The Git commit author is only reachable through `correlation.commitShas` (AFE-15).                                                                                                                                                                                                         |
| Sync with prune / force / replace | `data.prune`, `force` (`syncStrategy.*.force` or `Force=true`), `replace`, `dryRun`, `syncOptions`, `selectiveSync` | `operation.sync`. Certain; not available for syncs recovered from history.                                                                                                                                                                                                                                                                                                                                                                           |
| Rollback                          | sync events with trigger `rollback`, plus `deployment.rolled_back` when it finishes                                 | ArgoCD records a rollback as a sync of an older history entry's revision. Evidence, strongest first: Kubernetes event "initiated rollback to <id>" (`high`), `operation.info` mentioning rollback (`high`), revision equals an earlier history entry and differs from the last deployed one (`medium`). An "initiated sync" event downgrades it to `low` and it is not called a rollback. `data.rollback` = `toHistoryId`, `confidence`, `evidence`. |
| Refresh (normal/hard)             | `argocd.application.refreshed`                                                                                      | The `argocd.argoproj.io/refresh` annotation appearing (certain when seen). It is removed within seconds, so a refresh between two observations is **not** recorded, and reconciliation almost never sees one. Actor only via a Kubernetes event, else `unknown`.                                                                                                                                                                                     |
| Application create                | `argocd.application.created`                                                                                        | First sight of a uid. Actor from the "created application" event (`high`); app-of-apps children (tracking label/annotation) → controller, trigger `upstream` (`medium`); else `unknown`.                                                                                                                                                                                                                                                             |
| Application update                | `argocd.application.updated`                                                                                        | SHA-256 of the spec changed (certain). `data.change.fields` names changed paths (tool setting values are never stored), `data.change.summary` gives from/to of repo/path/revision/destination/sync policy, `data.change.imageOverrides` lists kustomize images and Helm image parameters/values. Actor from an "updated application" event since the last observation.                                                                               |
| Application delete                | `argocd.application.deleted`: outcome `in_progress` (deletionTimestamp set), then `succeeded`                       | Watch DELETED (certain), or absence from the list confirmed by GET (404: certain, 403: `high`). Who deleted is known only from the event at deletion-request time.                                                                                                                                                                                                                                                                                   |
| Health and sync status changes    | `argocd.health.changed`, `argocd.sync_status.changed`                                                               | Transitions only. Reconciliation sees only the net change; `data.note` says so.                                                                                                                                                                                                                                                                                                                                                                      |
| Sync operation result             | `argocd.sync.succeeded` / `.failed` / `.terminated` (`data.phase`, `message`, `retryCount`, `terminatedBy`)         | `operationState.phase`, `finishedAt`; message "Operation terminated" → terminated.                                                                                                                                                                                                                                                                                                                                                                   |
| Syncs missed during an outage     | `argocd.sync.started` + `.succeeded` with `data.recoveredFrom: "status.history"`                                    | New `status.history[]` entries. History holds successful syncs only (default 10): **failed syncs other than the latest operation cannot be recovered**.                                                                                                                                                                                                                                                                                              |

### Mapping

- `target`: `{type: application, id: <app namespace>/<name>, project,
repository (repoURL), ref (targetRevision), cluster (destination name or
server), namespace (destination namespace)}`.
- `correlation` (per the AFE-15 research): `commitShas` =
  `syncResult.revision(s)` of all sources, `repositories` = `repositoryKey()`
  of every source, `deploymentIds` = `argocd:<ns>/<app>:<history id>` on
  finished successful syncs, `imageRefs` = `status.summary.images` (kept with
  `@sha256:` when present) and `imageDigests` from those; image overrides on
  `argocd.application.updated`; health and sync-status events carry the
  current sync's keys. `environments` only from a label (`afe.dev/environment`,
  `environment`, `env`) or the `environmentOf` option: ArgoCD has no native
  environment. Multi-source revisions are paired with their repository in
  `data.sources`. Helm: `data.chart` and `data.chartVersion`.
- Raw payload: a minimised Application (`minimiseApplication`): no Helm
  values/parameters, Kustomize/plugin/directory settings, managed fields,
  resource lists or annotations other than the refresh one.
- New actions (not yet in core `ACTIONS`): `argocd.application.refreshed`,
  `argocd.sync_status.changed`.

### Idempotency keys (refines docs/event-model.md for argocd)

| Object                   | `sourceEventId` parts                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sync started / finished  | `sync`, uid, `operationState.startedAt` (= `history.deployStartedAt`), `started` / `finished`                                                                                             |
| sync from legacy history | `history`, uid, history id (ArgoCD without `deployStartedAt`; matched to a watched operation by revision and time so it is not duplicated)                                                |
| rollback                 | `rollback`, uid, startedAt                                                                                                                                                                |
| created / deleted        | `application`, uid, `created` / `deletion_requested` / `deleted`                                                                                                                          |
| updated                  | `application`, uid, `updated`, n-th spec change, first 12 hex of the spec hash. Not `metadata.generation`: the Application CRD has no status subresource, so every status write bumps it. |
| refresh                  | `refresh`, uid, resourceVersion where the annotation was first seen                                                                                                                       |
| health / sync status     | `health` / `sync_status`, uid, from, to, `health.lastTransitionTime` or `status.reconciledAt`                                                                                             |

### Jobs and health

- `argocd.reconcile` (cron `*/5 * * * *`): without data it fans out one job
  per active connection (singleton per connection) and queues `argocd.watch`;
  with `{tenantId, connectionId}` it reconciles that connection.
- `argocd.watch` `{tenantId, connectionId}`: watches for a 10-minute slice
  (below pg-boss' job expiry), reconnecting with backoff (1 s doubling to
  60 s) and resuming from the last `resourceVersion`. Each (re)connect starts
  a catch-up reconciliation, because ArgoCD does not replay missed changes.
  At the end of the slice the job re-enqueues itself. One watch per
  connection per process; a duplicate in another worker is harmless (per-app
  lock and idempotent keys).
- Health: every stream or reconciliation success/failure goes to the
  module's `onObservation` hook (default: `ctx.health.reportSuccess` /
  `reportFailure` of AFE-13 when present; `via` is `stream` or `poll`). The
  `backfill(connection, from, to)` hook runs a reconciliation.

### Limitations and to verify against the ArgoCD docs

Sources: https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/,
https://argo-cd.readthedocs.io/en/stable/user-guide/application-specification/,
https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/,
https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_rollback/.
They were not reachable while writing this; verify against a real instance:

1. Watch without `resourceVersion` sends ADDED for every app first; with it,
   only new changes (no replay). No heartbeats on idle streams.
2. `history[].deployStartedAt` equals `operationState.startedAt`;
   `history[].initiatedBy` exists in recent versions; history is written in
   the same or an earlier update than phase `Succeeded`.
3. A rollback leaves no explicit marker in `operation` (`operation.info` is
   checked defensively) and argocd-server logs "initiated rollback to <id>".
4. Exact argocd-server audit messages (`created application`, `updated
application spec`, `patched application`, `deleted application`,
   `initiated sync to`, `terminated running operation`; whether a refresh is
   logged at all) and that `/applications/{name}/events` returns the
   Application's own events with `applications, get`.
5. `GET /api/v1/applications/{name}` answers 403 rather than 404 for missing apps.
6. `status.health.lastTransitionTime` availability.
7. Terminated operations end with phase `Failed` and message "Operation terminated".
8. Not covered: resource actions (`action/*`); `argocd app set` overrides are
   seen only as spec updates; pod image digests via the resource tree
   (optional, out of scope).
