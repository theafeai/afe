# Security rules for integrations

- Status: Binding (AFE-5). A pull request that adds or changes an integration
  must satisfy every rule below or document an approved exception in the PR.
- The checklist in [`.github/pull_request_template.md`](../../.github/pull_request_template.md)
  mirrors these rules.

"Integration" means any code that receives data from, or sends requests to, a
system outside Afe: connectors (GitHub, ArgoCD, Vercel, future ones), the ArgoCD
agent, alert sinks.

Helpers referenced below live in `@afe/core/security` and `@afe/db`.

## R1 – Least privilege: read-only everywhere

1. Request **read-only** access in every connected tool, wherever the tool
   allows it. Afe never needs to write to a delivery tool.
2. Each connector documents the exact scopes/permissions it requests and why,
   in its package README. Adding a scope is a reviewed change.
3. Current baseline:
   - **GitHub App**: `Metadata: read` (mandatory), `Deployments: read`,
     `Actions: read`, `Environments: read`; other permissions only `read`, and
     only with a written justification. Do not request `Contents` unless commit
     metadata is unobtainable otherwise; if it is requested, Afe still never
     downloads file contents (see data inventory). Subscribe only to the webhook
     events the connector uses.
   - **ArgoCD**: a dedicated local account with only the `apiKey` capability and
     an RBAC role limited to `get` on `applications`, `projects` and `clusters`
     (e.g. `p, role:afe-readonly, applications, get, */*, allow`), or the
     built-in `role:readonly`. Never `admin`, never `sync`/`override`/`action`.
   - **Vercel**: a token scoped to a single team, with an expiry, created by a
     member with the least-privileged role the plan offers (e.g. Viewer). Vercel
     tokens cannot be restricted to read-only; this is a documented exception
     and the connector only ever issues `GET` requests.
4. Connectors only call read endpoints (`GET`, or read-only GraphQL queries).
   A test asserts that the connector's HTTP client issues no other method.

## R2 – Credentials

1. Credentials (API tokens, private keys, webhook secrets, client secrets) are
   stored **only** through the `@afe/db` credentials repository
   (`storeCredential` / `getCredential` / `rotateCredential` /
   `revokeCredential`). Never in another table, a config column, a job payload,
   a raw payload, or a file.
2. They are encrypted at rest with envelope AES-256-GCM, with the tenant id and
   credential id bound as associated data (see
   [`key-management.md`](key-management.md)). There is no plaintext column.
3. In memory they travel as `Secret<string>`; call `.reveal()` only at the point
   of use (building the `Authorization` header, signing a JWT).
4. **Never logged.** Not in logs, error messages, exceptions, metrics labels,
   traces, job payloads or UI responses. Errors from upstream APIs are
   logged with status and request id, not with request headers.
5. **Scoped per tenant.** Every credential belongs to exactly one tenant; every
   access passes the tenant id. A connection may only reference credentials of
   its own tenant.
6. **Rotatable and revocable.** Connectors read the credential at use time (no
   long-lived copies), so `rotateCredential` takes effect on the next call.
   `revokeCredential` destroys the ciphertext; a connection whose credential is
   revoked stops and reports unhealthy.
7. The API treats credentials as **write-only**: they can be set and replaced,
   never read back. Responses show only metadata (kind, created/rotated dates).
8. Webhook secrets that Afe generates are 32 random bytes from a CSPRNG.

## R3 – Webhook authenticity and replay rejection

1. **Verify a signature on every inbound hook** before parsing or storing it:
   - GitHub: `X-Hub-Signature-256` with `verifyGitHubSignature`. The legacy
     SHA-1 `X-Hub-Signature` is not accepted.
   - Vercel: `x-vercel-signature` with `verifyVercelSignature`.
   - Other sources: `verifyHmacSignature` with the provider's algorithm and
     prefix, or a stronger scheme. A source that cannot sign requests must
     not be accepted as a webhook; poll it instead, or use the agent model.
2. Verify against the **raw request body bytes**, never a re-serialised object.
   Register the route with a raw-body content parser.
3. Comparison is constant-time (`crypto.timingSafeEqual`, done by the helpers).
   Do not write custom comparisons.
4. Missing, duplicated or malformed signature headers fail closed (401) without
   detail in the response. Do not log the signature or the body of rejected
   requests; log source, delivery id and reason.
5. **Reject replays.** After verification, call `recordDelivery(db, tenantId,
source, deliveryId)` (or a `ReplayGuard`) in the same transaction that stores
   the raw delivery. `false` means replay: respond 2xx (so the sender stops
   retrying) and do not process again. Delivery ids: GitHub `X-GitHub-Delivery`;
   Vercel payload `id`.
6. Where the source signs a timestamp (e.g. Vercel's `createdAt` inside the
   signed body), also reject deliveries outside a tolerance window with
   `isTimestampFresh` (default 5 minutes for push-style hooks; adjust per
   provider's documented retry behaviour).
7. Keep delivery records for at least 30 days (longer than any supported
   provider's redelivery window); `pruneWebhookDeliveries` removes older ones.
   Ingestion stays idempotent by `(tenant_id, source, source_event_id)` as a
   second line of defence.
8. Webhook endpoints enforce a body size limit and do no outbound calls or
   heavy work inline (verify, store, enqueue, 2xx).

## R4 – Logging and redaction

1. The server logger is configured with `LOG_REDACT_OPTIONS` (pino `redact`).
   Do not create other loggers without it.
2. Never log: credentials, tokens, private keys, webhook secrets, signatures,
   `Authorization`/`Cookie` headers, raw webhook bodies, full upstream request
   or response objects, environment variables, or `AfeConfig` as a whole.
3. When logging structured data of unknown shape, pass it through `redactDeep`.
4. Headers stored with raw deliveries go through `redactHeaders` first.

## R5 – Tenant isolation (hosted version)

The open-source build has one tenant, but every integration must be written so
the hosted service can rely on these rules without changes:

1. Every table holding customer data has a non-null `tenant_id` (exception:
   pre-tenant ingress records such as `webhook_deliveries`, where it is
   nullable until resolved) and its primary/unique keys start with `tenant_id`.
   Foreign keys between customer tables include `tenant_id`.
2. Every data-access function takes `tenantId` as an explicit argument and puts
   it in the `WHERE` clause of every statement, including updates and deletes.
   No query reads across tenants except explicit operator maintenance
   functions, which are named as such.
3. The tenant id comes from the authenticated context (`TenantResolver` applied
   to the `AuthProvider` principal; route handlers use `requestTenant(req)`,
   ADR 0006), or for
   webhooks from the verified installation/connection lookup, never from an
   unauthenticated request field.
4. Connector state (cursors, installation ids, connection config) is keyed by
   tenant. A webhook is mapped to a tenant only via a stored, tenant-owned
   mapping (e.g. GitHub installation id → connection → tenant); unknown
   installations are recorded with `tenant_id = NULL` and not ingested.
5. Credentials are bound to their tenant cryptographically (AAD), so even a
   query bug cannot make tenant B's connector use tenant A's token.
6. Jobs carry the tenant id; workers load all state through tenant-scoped
   functions.
7. Caches, rate-limit buckets and in-memory maps are keyed by tenant id.
8. Sequences and retention are per tenant: one tenant's events never affect
   another tenant's ordering or purge (`event_sequences`, `retention.purge`).
9. The hosted service may additionally enable PostgreSQL row-level security
   keyed on a per-transaction `app.tenant_id` setting; schema in this repository
   must not prevent that (no cross-tenant views or functions).
10. Tests for new data-access functions include a "wrong tenant returns
    nothing / changes nothing" case.

## R6 – Outbound request safety

1. Every user-supplied URL (ArgoCD server URL, GitHub Enterprise URL, alert
   webhook URL) is checked with `validateOutboundUrl` when it is saved
   **and** the HTTP client uses `createSafeLookup` so the resolved address is
   checked again at connect time (DNS rebinding).
2. Policy: `https:` only; no `user:pass@`; link-local, cloud-metadata,
   multicast and unspecified addresses always refused. Private, loopback,
   CGNAT and ULA addresses are refused unless the self-host operator sets
   `AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true` (ArgoCD is often internal). Plain
   `http:` additionally requires `AFE_ALLOW_INSECURE_HTTP_TARGETS=true` and is
   only meant for lab setups. The hosted service never enables either.
3. Do not follow redirects automatically. If a redirect must be followed, the
   target must pass the same policy and credentials are dropped when the host
   changes.
4. Every outbound call has a connect and total timeout, bounded retries with
   backoff, and a response size limit.
5. Error messages shown to users about a URL must not echo response bodies from
   internal hosts (avoid SSRF-as-oracle).

## R7 – TLS

1. TLS certificate verification is **never disabled**. `rejectUnauthorized:
false` and `NODE_TLS_REJECT_UNAUTHORIZED` are banned by lint.
2. Internal endpoints with a private CA (common for ArgoCD) are supported by
   configuring that CA: per connection (a PEM bundle stored with the connection
   config and passed as the `ca` option to the HTTP agent, in addition to the
   default roots), or process-wide with `NODE_EXTRA_CA_CERTS`. CA certificates
   are public data, not credentials.
3. Optional certificate pinning (SPKI hash) per connection is allowed in
   addition to, never instead of, chain verification.
4. The database connection should use TLS (`sslmode=verify-full`) whenever it
   leaves the host.

## R8 – Data minimisation

Store only what [`data-inventory.md`](data-inventory.md) allows. New stored
fields from an upstream tool are added to the inventory in the same PR.
Specifically: no source code, no file contents, no secret or environment
variable values, no build logs.

The GitHub workflow viewer may proxy already source-masked completed job logs
on demand, bounded in memory, without persistence or application logging
(AFE-52). This does not permit storing build logs in events, raw payloads,
credentials, job queues or any other table. See the transient-read section of
the data inventory for limits and access controls.

## R9 – Tests

Every integration ships tests (with recorded fixtures or local fakes, never real
services) for: valid signature accepted; invalid/missing/duplicated signature
rejected; replayed delivery not reprocessed; wrong-tenant access returns
nothing; no secrets in captured logs; only read-only HTTP methods used.

API routes need no per-route auth test: `apps/server/test/auth.test.ts`
enumerates every registered `/api` route and checks 401 without credentials,
403 for the viewer on admin routes and 404 for another tenant's `:id`. A new
route whose `:id` is not a connection or event id must be added to that test's
id mapping. Routes are authenticated by default; `config: { access: "public" }`
needs a security review.
