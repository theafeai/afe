# ADR 0004: ArgoCD connection model

- Status: Accepted (agent section updated by AFE-28)
- Date: 2026-10-26
- Issue: AFE-9

## Context

Afe must observe any ArgoCD instance read-only: who synced which application to
which revision, auto-syncs, rollbacks and failures. ArgoCD instances are:

- often **private** (cluster-internal service, VPN, or behind a firewall),
- often served with a **private CA or self-signed certificate**,
- often fronted by **SSO** (Dex or a direct OIDC provider) for humans,
- numerous: one tenant may run one ArgoCD per cluster, region or environment.

Security rules R1 (least privilege), R2 (credentials), R6 (outbound safety) and
R7 (TLS) in [`docs/security/rules.md`](../security/rules.md) are binding.

## Options

### A. Pull: Afe calls the ArgoCD API with a read-only token

Afe stores the server URL and an API token of a dedicated local account, then
lists applications, watches `/api/v1/stream/applications` (SSE) and
periodically reconciles.

- Plus: nothing to install in the cluster; works with every ArgoCD 2.x; the
  watch stream gives near real-time updates; reconciliation by re-listing is
  trivial; simplest to operate and to test.
- Minus: Afe needs network reach to the ArgoCD API. Fine for self-hosted Afe
  next to ArgoCD and for public/allow-listed instances; a problem for the
  hosted service and private instances.
- Security: token is read-only by RBAC; Afe stores it encrypted (R2); URLs are
  validated and private networks need an operator opt-in (R6); custom CAs are
  supported per connection without disabling verification (R7).

### B. In-cluster agent pushing outward

A small read-only agent runs next to ArgoCD (in-cluster), reads the same API
(or the `Application` CRDs through a read-only Kubernetes ServiceAccount) and
pushes normalised data outward over HTTPS to Afe.

- Plus: no inbound connectivity; works behind any firewall; the ArgoCD token
  never leaves the cluster; ideal for the hosted service.
- Minus: one more component to build, release, upgrade and secure; agent
  liveness becomes part of observation-gap tracking; more moving parts for
  small self-hosters who could simply use pull.

### C. Both, sharing one data model

Pull is first-class now; the agent is an alternative transport that delivers
the **same** observations (application snapshots and watch events), so
everything after transport (mapping to canonical events, idempotency keys,
gaps) is shared.

### ArgoCD Notifications as an extra signal

ArgoCD Notifications (built into ArgoCD since 2.3) can send webhooks on
triggers such as `on-sync-succeeded`, `on-sync-failed`, `on-deployed`.

- Plus: push, no polling; per-trigger templates.
- Minus: configured **by the ArgoCD admin** in `argocd-notifications-cm`
  (Afe cannot set it up read-only); templates are free-form, so payload shape
  and completeness depend on each installation; webhooks are **not signed**
  by default (only optional static headers/basic auth), so they fail R3.1
  unless an HMAC is added by a proxy; delivery is best-effort with no replay or
  catch-up; and it still needs inbound reach from ArgoCD to Afe.
- Conclusion: not a primary source. Possibly later as an optional low-latency
  "nudge" that only triggers a reconciliation of the named application (Afe
  then reads the truth from the API), so an unsigned or forged notification
  cannot inject data. Not implemented in AFE-9.

## Decision

1. **Pull mode is the MVP and first-class** (option C, pull first). It is
   implemented in `@afe/connector-argocd` and `apps/server/src/connectors/argocd.ts`.
2. **Many instances per tenant**: each ArgoCD instance is one row in
   `connections` with `source = "argocd"` and `externalId` = the normalised
   server URL (lower-cased scheme/host, default port and trailing slash
   removed, root path kept). Display name is optional (defaults to the host).
   Non-secret config (`serverUrl`, `caPem`, detected version, account name,
   read-only check result) lives in `connections.config`; the token lives only
   in `credentials` (kind `argocd_api_token`), attached with role `api_token`.
   No new table or migration is needed.
3. **Credentials**: a dedicated local account with only the `apiKey`
   capability and a custom read-only role (exact policy in
   [`docs/connectors/argocd.md`](../connectors/argocd.md)). Tokens are
   independent of SSO, so SSO setups work unchanged.
4. **Read-only verification**: on connect and on test, Afe asks ArgoCD
   `GET /api/v1/account/can-i/...` for write actions (`applications`
   `sync`/`override`/`update`/`delete`/`create`, `exec create`) on `*`, `*/*`
   and up to five real `project/application` objects. A token that can do any
   of these is **rejected** (HTTP 422 `token_not_read_only`). `logs get` only
   produces a warning. If `can-i` is unavailable the connection is accepted
   with a warning (`readOnlyCheck: "unavailable"`). This is a guard against
   obviously over-privileged tokens, not a proof; RBAC is the control.
5. **TLS**: a per-connection CA bundle (PEM, public data) is added to the
   default roots (including `NODE_EXTRA_CA_CERTS`) on an undici `Agent`.
   Verification is never disabled.
6. **Network**: the URL is checked with `validateOutboundUrl` when saved and
   before every request; the agent uses `createSafeLookup` for DNS-time checks.
   Private targets need `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true` (self-host
   only). Redirects are never followed. Timeouts, bounded retries and a
   response size limit apply.
7. **Agent (option B) was deferred** to a follow-up issue and built in
   AFE-28; see "Agent protocol" below for the protocol as built and the
   changes from the original design.

## Agent protocol (implemented in AFE-28)

The agent was built in AFE-28 (`apps/argocd-agent`, Afe side
`apps/server/src/connectors/argocd-agent.ts`, wire format
`packages/connector-argocd/src/agent-protocol.ts`, migration
`0018_argocd_agents.sql`; operator docs in
[docs/connectors/argocd.md](../connectors/argocd.md#in-cluster-agent)). The
original design (kept below for the record) was followed with the changes
listed under "Changes from the original design".

### As built (protocol v1)

- **Registration** (admin, `POST /api/connections/argocd/agents`
  `{instanceId, name?}`): creates a `connections` row with `source = "argocd"`,
  `externalId = agent:<instanceId>`, `config.mode = "agent"` (and
  `config.transport = "agent"`), and a per-agent secret (32 random bytes,
  `afeag_` prefix) stored as a credential (kind `argocd_agent_secret`, role
  `agent_secret`), returned once. The agent id is the connection id.
  Rotation: `POST /api/connections/argocd/agents/:id/rotate-secret`
  (optional grace period: the previous secret stays valid, role
  `agent_secret_previous`). Disconnecting uses the existing
  `DELETE /api/connections/argocd/:id`.
- **Reading**: the agent lists and watches `applications.argoproj.io` through
  the Kubernetes API with a ServiceAccount bound to `get/list/watch
applications` (+ `get/list events` for attribution), in the ArgoCD namespace
  (Role) or all namespaces (ClusterRole). No ArgoCD token. Reading through the
  ArgoCD API from inside the cluster remains possible later (`mode:
"argocd-api"` is reserved in the protocol) but is not built.
- **What is sent**: raw Application objects (minus managed fields, unused
  annotations, `status.resources/conditions`), never canonical events. Afe
  runs the AFE-10 capture on them (`ArgoCdCapture` without an API client:
  `handleWatchEvent` for watch items with method `stream`, `observe(...,
"reconciliation")` for snapshot items, `reconcileFromSnapshot` for the end
  of a snapshot). Mapping and its versioning stay in Afe; keys equal pull
  mode's, so observations of the same application by pull and agent dedupe.
- **Transport**: `POST /agent/argocd/v1/batches` and
  `POST /agent/argocd/v1/heartbeat` with headers `X-Afe-Agent-Id`,
  `X-Afe-Timestamp` (unix seconds) and `X-Afe-Signature: v1=<hex
HMAC-SHA256(secret, "v1:" + timestamp + ":" + raw body)>`. Afe rejects a
  timestamp or body `sentAt` more than 5 minutes from its clock, and records
  every `batchId` / `heartbeatId` with `recordDelivery(source
"argocd-agent")`. Batch body: `{protocol: 1, agentId, runId, batchId,
sequence, sentAt, agentVersion, mode, droppedTotal, items}`; items are
  `watch {type, observedAt, application, events?}`, `snapshot {snapshotId,
observedAt, application, events?}` and `snapshot_end {snapshotId, listedAt,
droppedTotalAtStart, uids}`.
- **Processing**: the endpoint verifies, stages the body
  (`argocd_agent_batches`, same transaction as the replay record), enqueues
  `argocd-agent.process` and answers 202. The job processes a connection's
  batches strictly in arrival order under an advisory lock and deletes each
  when done. More than 500 waiting batches → 429 with `Retry-After`.
- **Heartbeats** every 30 s (interval set by Afe in the response). Missing
  for 90 s → `reportFailure(unreachable)` (gap opened by AFE-13 rules).
  Dropped observations, a sequence gap, an agent restart, or a batch that
  cannot be processed also report a failure. Such a gap is closed only when a
  full snapshot that started after the loss has been processed; the
  heartbeat response asks the agent for one (`resync: true`).
- **Backpressure in the agent**: bounded buffer (items and bytes); when full,
  the oldest waiting observations are dropped and counted in
  `droppedTotal`, and the agent lists again once there is room.

### Changes from the original design, and why

1. **Endpoints are outside `/api/`** (`/agent/argocd/v1/...` instead of
   `/api/agents/argocd/v1/...`): since ADR 0006 every `/api/*` route
   requires a user principal; agents are not users and authenticate each
   request themselves, like webhooks.
2. **No bearer token; HMAC only, with a timestamp in the signed input.** The
   original design sent the token as `Authorization: Bearer` and signed with
   a key derived from it. Sending it adds nothing (the HMAC already proves
   possession) and exposes it to every TLS-terminating proxy; signing the
   timestamp bounds replay even after delivery records are pruned.
3. **Explicit `snapshot_end` with all uids, plus `runId`, `sequence` and
   `droppedTotal`.** Afe cannot ask the cluster whether an application is
   gone (pull mode uses a GET), so the end of a full list carries the uids;
   the counters let Afe detect lost data honestly.
4. **Gaps close on a covering full snapshot, not on the next heartbeat.** A
   resumed heartbeat proves liveness, not that nothing was missed.
5. **Heartbeat 30 s** instead of 60 s, so a silent agent is noticed within
   about two minutes; still cheap (one small request).
6. **Kubernetes API as the primary read path** (the design allowed either):
   no ArgoCD credential exists at all, it works with SSO-only ArgoCD and
   without argocd-server, and the RBAC is the narrowest available.
7. **`config.mode = "agent"`** is the discriminator used in code (the
   original `config.transport = "agent"` is also set).

### Original design (AFE-9, superseded by the above)

- Registration: an admin creates an "agent" ArgoCD connection in Afe; Afe
  returns a one-time **agent token** (32 random bytes, stored as a credential,
  shown once). The connection's `externalId` is `agent:<instance-id>` where
  the agent reports a stable instance id (ArgoCD URL inside the cluster or a
  configured name). `config.transport = "agent"`.
- The agent runs in the ArgoCD namespace with the same read-only ArgoCD token
  (or a ServiceAccount with `get/list/watch` on `applications.argoproj.io`
  only). It never needs a Kubernetes write permission and never reads Secrets.
- Transport: HTTPS POST from agent to Afe (`POST /api/agents/argocd/v1/batches`),
  `Authorization: Bearer <agent token>`, JSON body:
  `{ "agentVersion", "instanceId", "argocdVersion", "batchId", "sentAt",
"items": [ { "kind": "snapshot" | "watch", "observedAt", "type"?,
"application": <ArgoCD Application JSON, same field subset as pull> } ] }`.
  `batchId` is a UUID and goes through `recordDelivery` (replay guard);
  `sentAt` is checked with `isTimestampFresh`. Batches are additionally
  HMAC-signed with a key derived from the agent token
  (`X-Afe-Signature: sha256=...` over the raw body) so a TLS-terminating proxy
  cannot alter them.
- Heartbeat: `POST /api/agents/argocd/v1/heartbeat` every 60 s; missing
  heartbeats open an observation gap (AFE-13); after reconnecting, the agent
  sends a full `snapshot` so Afe reconciles.
- Afe processes agent items with exactly the same mapping code as pull-mode
  watch events and list snapshots (AFE-10), with `observation.method` =
  `stream` or `reconciliation`.

## Consequences

- Self-hosters next to ArgoCD connect with a URL and a token; nothing to
  install in the cluster.
- The hosted service reaches private ArgoCD instances through the in-cluster
  agent (AFE-28); pull mode remains the simplest option for self-hosters next
  to ArgoCD.
- The admin API (`/api/connections/argocd`) has no authentication yet; it
  depends on the `AuthProvider` (ADR 0002) and acts on the default tenant
  until then. Do not expose Afe's API publicly before auth lands.

## To verify against the ArgoCD docs

The development environment had no access to the ArgoCD docs; these are based
on knowledge of ArgoCD 2.x and must be checked against a real instance:

1. `/api/v1/stream/applications` returns `text/event-stream` with
   `data: {"result": {"type", "application"}}` frames when asked with
   `Accept: text/event-stream` (the client also accepts newline-delimited
   JSON), and error frames of the form `{"error": {"http_code", "message"}}`.
2. `/api/v1/account/can-i/{resource}/{action}/{subresource}` accepts a
   subresource containing `/` (e.g. `default/guestbook`) and answers
   `{"value": "yes"|"no"}`; any authenticated account may call it.
3. `/api/v1/session/userinfo` with an invalid token answers 401 (or
   `loggedIn: false`; both are handled).
4. `/api/v1/applications` query parameter names: `projects` (repeated),
   `selector`, `fields`, `appNamespace`, `repo`, `resourceVersion`.
5. `exec, create` and `logs, get` RBAC resources (ArgoCD >= 2.4 / 2.5).
6. Whether ArgoCD sends SSE heartbeats on idle watch streams (affects the
   AFE-10 watchdog).

References: https://argo-cd.readthedocs.io/en/stable/operator-manual/user-management/,
https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/,
https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/,
https://argo-cd.readthedocs.io/en/stable/operator-manual/notifications/,
https://argo-cd.readthedocs.io/en/stable/operator-manual/tls/.
