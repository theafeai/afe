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
| `projects, get`     | Resolve project names/destinations for the event target. Optional; drop it if you do not want Afe to see project settings. |
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
for the connection (`baseline_at`) are recorded with method `backfill`; history
entries older than the event retention window (`AFE_EVENT_RETENTION_DAYS`) are not
stored (ADR 0008).

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

## In-cluster agent

For ArgoCD instances Afe cannot reach (private cluster, behind a firewall,
hosted Afe), a small read-only agent runs in the cluster and pushes outward
over HTTPS. Nothing needs inbound access, and no ArgoCD token is needed.
Design and protocol: [ADR 0004](../decisions/0004-argocd-connection-model.md)
"Agent protocol". Code: `apps/argocd-agent` (agent),
`apps/server/src/connectors/argocd-agent.ts` (Afe side),
`packages/connector-argocd/src/agent-protocol.ts` (shared wire format).

### How it reads ArgoCD

The agent watches `applications.argoproj.io/v1alpha1` through the
**Kubernetes API** with its ServiceAccount: list (paginated), then watch from
the list's `resourceVersion`, and list again on `410 Gone`. This was chosen
over the ArgoCD API because, in the cluster, it needs no ArgoCD account or
token (nothing to create, rotate or leak), works with SSO-only ArgoCD
installs, does not depend on argocd-server being up, and its RBAC is the
narrowest possible (get/list/watch on one resource). It sees the same objects
argocd-server would return, since both read them from the API server.

It sends **raw Application objects** (watch events and full snapshots), not
canonical events. Afe maps them with the same AFE-10 code as pull mode
(`ArgoCdCapture`, `observeApplication`), so:

- mapping and its versioning live in one place (Afe), and an agent upgrade is
  never needed for a mapping fix;
- agent and pull observations produce identical idempotency keys (the same
  sync seen by both is stored once);
- the per-application state store dedupes watch and snapshot observations;
- the agent stays stateless: a restart simply sends a new full snapshot.

Before sending, the agent drops what the mapping never reads and that is
large or may hold configuration: `metadata.managedFields`, every annotation
except `argocd.argoproj.io/refresh` and `argocd.argoproj.io/tracking-id`
(this removes `last-applied-configuration`), `status.resources`,
`status.conditions` and per-resource sync messages. `spec` is sent unchanged
because the mapping hashes it to notice changes (Helm/Kustomize settings
included) and reads image overrides from it; as in pull mode, Afe stores only
the minimised form as evidence. Accepted batches wait in
`argocd_agent_batches` until a job processes them (seconds) and are then
deleted.

With `AFE_AGENT_ATTRIBUTE_WITH_EVENTS=true` (default) the agent also lists the
core/v1 Events of an Application (`involvedObject.uid`) when something that
may need actor attribution changed (operation, spec generation, deletion,
refresh, history length) and attaches them, so "alice initiated sync" is
attributed as in pull mode. Without `events` RBAC it logs once and continues
without them.

### Install

1. Register the agent (admin):

   ```sh
   curl -sS -X POST "$AFE/api/connections/argocd/agents" \
     -H "Authorization: Bearer $AFE_ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"instanceId":"prod-eu-1","name":"Prod EU"}'
   ```

   The answer contains `agentId` and `secret`. The secret is shown **once**;
   Afe stores it encrypted (credential kind `argocd_agent_secret`).

2. Store the secret in the cluster:
   `kubectl -n afe-argocd-agent create secret generic afe-argocd-agent --from-literal=secret=<secret>`
   (see [the credentials guide](../self-hosting/credentials/argocd.md#in-cluster-agent-secret)).

3. Deploy with the Helm chart (`deploy/argocd-agent/helm/afe-argocd-agent`;
   set `afe.url`, `afe.agentId`, `networkPolicy.apiServerCidrs`,
   `networkPolicy.afeCidrs`) or the plain manifests
   (`deploy/argocd-agent/manifests`; edit the placeholders, then
   `kubectl apply -k deploy/argocd-agent/manifests`). Image:
   `ghcr.io/theafeai/afe-argocd-agent:<version>`.

The manifests contain: a Namespace (`pod-security: restricted`), a
ServiceAccount, a Role and RoleBinding in the ArgoCD namespace (or, optionally,
a ClusterRole for applications in any namespace) with **only**
`get/list/watch applications.argoproj.io` and `get/list events`; a reference to
the Secret (never created by the chart); a Deployment with one replica
(`Recreate`), `runAsNonRoot`, `readOnlyRootFilesystem`, all capabilities
dropped, `seccompProfile: RuntimeDefault` and a memory limit; and a
NetworkPolicy with no ingress and egress only to DNS, the API server and Afe.
NetworkPolicy cannot select the API server or an external host by name, so
their CIDRs must be filled in. A test (`apps/argocd-agent/test/manifests.test.ts`)
fails if any write verb or any other resource appears.

Agent settings (environment):

| Variable                          | Default                             | Meaning                                                  |
| --------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| `AFE_URL`                         | required                            | Afe's public URL (https)                                 |
| `AFE_AGENT_ID`                    | required                            | agent id from registration                               |
| `AFE_AGENT_SECRET_FILE`           | required                            | file with the secret (re-read on every request)          |
| `AFE_AGENT_NAMESPACES`            | `argocd`                            | comma-separated namespaces, or `*` (needs a ClusterRole) |
| `AFE_AGENT_ATTRIBUTE_WITH_EVENTS` | `true`                              | read Events for actor attribution                        |
| `AFE_AGENT_CA_FILE`               | none                                | extra CA (PEM) for Afe's certificate                     |
| `AFE_AGENT_BUFFER_MAX_ITEMS`      | `10000`                             | buffer bound (items)                                     |
| `AFE_AGENT_BUFFER_MAX_BYTES`      | `67108864`                          | buffer bound (bytes)                                     |
| `AFE_AGENT_BATCH_MAX_ITEMS`       | `200`                               | items per batch                                          |
| `AFE_AGENT_HEALTH_PORT`           | `8081`                              | `/healthz` and Prometheus `/metrics`; `0` disables       |
| `AFE_AGENT_LOG_LEVEL`             | `info`                              | JSON logs on stdout                                      |
| `AFE_AGENT_KUBE_URL`              | from `KUBERNETES_SERVICE_HOST/PORT` | API server URL (out-of-cluster testing)                  |
| `AFE_AGENT_KUBE_TOKEN_FILE`       | the ServiceAccount token            | re-read on every request (projected tokens rotate)       |

### Afe side

| Route                                                   | Access       | Purpose                                                              |
| ------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| `POST /api/connections/argocd/agents`                   | admin        | register: connection (`source` argocd, `config.mode` agent) + secret |
| `GET /api/connections/argocd/agents`                    | admin        | agents with last heartbeat, sequence, dropped count, waiting state   |
| `POST /api/connections/argocd/agents/:id/rotate-secret` | admin        | new secret; `{"graceSeconds": n}` keeps the old one valid (max 24 h) |
| `DELETE /api/connections/argocd/:id`                    | admin        | (existing route) disconnect: revokes the secret                      |
| `POST /agent/argocd/v1/batches`                         | agent (HMAC) | watch events and full snapshots                                      |
| `POST /agent/argocd/v1/heartbeat`                       | agent (HMAC) | liveness and counters; the response may ask for a full snapshot      |

The agent endpoints are outside `/api/` and authenticate the agent
themselves: `X-Afe-Agent-Id`, `X-Afe-Timestamp` (unix seconds) and
`X-Afe-Signature: v1=<hex HMAC-SHA256(secret, "v1:<timestamp>:<raw body>")>`;
the secret never travels. Requests more than 5 minutes away from Afe's clock
(header or `sentAt`) are rejected (`401 clock_skew` with `serverTime`). Every
`batchId`/`heartbeatId` is recorded once (`webhook_deliveries`, source
`argocd-agent`); a retried batch gets `200 {"status":"duplicate"}`. Accepted
batches are staged and processed strictly in order per agent
(`argocd-agent.process`, plus `argocd-agent.sweep` every minute); with more
than 500 waiting, the endpoint answers `429` with `Retry-After` and the agent
keeps buffering.

Observation methods: watch items are `stream`, snapshot items are
`reconciliation`, and `observation.detail` starts with `in-cluster agent`. A
full snapshot ends with the list of uids; applications Afe knew that are not
listed, and were last seen before the list started, are recorded as
`argocd.application.deleted` (confidence `certain`: a Kubernetes list is
authoritative for its namespaces). The scheduled pull reconciliation and
watch skip agent connections.

### Gaps (connection health)

An agent's health is what it reports; Afe cannot probe it.

- Heartbeat every 30 s (Afe sets the interval). `argocd-agent.heartbeat-check`
  (every minute) reports a failure (`unreachable`) when none arrived for 90 s,
  which opens an observation gap from the last success.
- Possible loss also opens a gap: dropped observations (`droppedTotal`
  increased), a batch sequence gap, an agent restart (unsent data of the old
  process is lost), or a batch Afe could not process after 10 attempts.
- Such a gap is closed **only by a full snapshot that started after the
  loss** (for drops: `droppedTotalAtStart` at least the reported count, and
  no drops while it ran), not by the next heartbeat. Afe asks for it in the
  heartbeat response (`resync: true`, repeated every 15 minutes while
  waiting); after a restart the agent sends one by itself. The health probe of
  an agent connection fails while heartbeats are missing or a snapshot is
  awaited, and the `backfill` hook asks for a snapshot.
- Backpressure: the agent's buffer is bounded (items and bytes). When it is
  full the agent drops the **oldest** waiting observations, counts them, and
  lists again once there is room. What a snapshot cannot recover (for example
  an operation that started and finished entirely within dropped data and has
  left ArgoCD's history) is lost; the gap records that it may be.

### To verify (agent)

1. Kubernetes watch frames, bookmarks and `410` handling as described in
   https://kubernetes.io/docs/reference/using-api/api-concepts/.
2. Events of an Application can be selected with
   `fieldSelector=involvedObject.kind=Application,involvedObject.uid=<uid>`
   in the Application's namespace, and argocd-server writes its audit events
   there (as `/api/v1/applications/{name}/events` suggests).
3. Kubelet HTTP probes are not blocked by the NetworkPolicy (`ingress: []`) on
   the target CNI.
4. The image runs under `pod-security.kubernetes.io/enforce: restricted` and
   the distroless image tag `gcr.io/distroless/nodejs22-debian12:nonroot`
   (the image was not built here: no Docker daemon was available).
