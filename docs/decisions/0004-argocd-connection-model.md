# ADR 0004: ArgoCD connection model

- Status: Accepted
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
7. **Agent (option B) is deferred** to a follow-up issue; its protocol is
   fixed below so the server side can accept it without changing the model.

## Agent protocol (design, not implemented)

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
- The hosted service can only reach public or allow-listed ArgoCD instances
  until the agent exists; that is the trigger to build it.
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
