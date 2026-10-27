# Threat model

- Status: Accepted (AFE-5)
- Applies to: the open-source build (self-host) and, through the rules in
  [`rules.md`](rules.md), the hosted multi-tenant service built on it.

Afe is an audit tool. Its job is to tell the truth about who deployed what, to
where and when. The two worst outcomes are therefore:

1. **A false or silently incomplete audit record** (events forged, altered,
   deleted or missed without anyone noticing).
2. **Afe becoming a path into the customer's delivery tools** (leaked or
   over-privileged credentials, SSRF into internal networks).

Everything below is ranked against those two outcomes.

## System overview

```
                 (1) webhook ingress                     (2) outbound API calls
 GitHub  ──HTTPS POST + HMAC──▶ ┌─────────────────────┐ ──HTTPS + token──▶ GitHub API
 Vercel  ──HTTPS POST + HMAC──▶ │  afe server/worker  │ ──HTTPS + token──▶ Vercel API
                                │  (Fastify, pg-boss) │ ──HTTPS + token──▶ ArgoCD API (user-supplied URL)
 Browser ──HTTPS + session────▶ │  (5) UI + API       │
                                └──────────┬──────────┘
                                           │ (4) TLS, DB role
                                    ┌──────▼──────┐
                                    │ PostgreSQL  │ events (append-only, hash-chained),
                                    │             │ raw_payloads, credentials (encrypted),
                                    └─────────────┘ webhook_deliveries, connections …
 (3) optional in-cluster agent for ArgoCD: runs next to ArgoCD, reads its API
     with a read-only token, pushes signed batches outbound to afe.
```

## Assets

| Asset                                                                            | Why it matters                                                       | Where                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| Audit log (`events`, `raw_payloads`)                                             | The product. Integrity and completeness are the core promise.        | PostgreSQL                |
| Connector credentials (GitHub App private key, ArgoCD token, Vercel token)       | Read access to customer delivery tools; abuse reaches customer infra | `credentials` (encrypted) |
| Webhook secrets                                                                  | Whoever has them can forge deliveries                                | `credentials` (encrypted) |
| Key-encryption keys (`AFE_ENCRYPTION_KEY` / KMS key)                             | Decrypts every credential                                            | Env/file (self-host); KMS |
| Hash-chain heads / export proofs                                                 | Allow third parties to detect tampering                              | `events`, exports         |
| Afe admin/session tokens                                                         | Control of Afe configuration                                         | Env / auth provider       |
| Tenant boundary (hosted)                                                         | One customer must never see or affect another                        | Every table (`tenant_id`) |
| Metadata about customer delivery (repo names, environments, commit SHAs, actors) | Confidential business information; personal data (user logins)       | `events`                  |

## Actors

| Actor                                  | Capability assumed                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Anonymous internet attacker            | Can reach the webhook endpoints and the UI login; can send arbitrary HTTP.                   |
| Network attacker                       | Can observe/replay traffic where TLS is absent or misconfigured.                             |
| Malicious or compromised Afe user      | Has a valid Afe login (possibly admin) in one tenant; may supply URLs and tokens.            |
| Other tenant (hosted)                  | A fully authenticated customer of the hosted service trying to reach another tenant.         |
| Insider who deployed and wants to hide | Has write access to a delivery tool, maybe to the Afe database or host; wants an event gone. |
| Compromised upstream tool              | A delivery tool (or its webhook sender) sends malicious or malformed payloads.               |
| Compromised dependency                 | A malicious npm package in the build.                                                        |
| Operator with DB access (self-host)    | Full SQL access to Afe's database. Trusted for availability, **not** for silent edits.       |

Out of scope: an attacker who controls the Afe process and its keys at runtime
(they can do anything Afe can, including writing new events; tamper evidence then
relies on previously exported chain heads), and compromise of GitHub, ArgoCD or
Vercel themselves.

## Trust boundaries

### TB1 – Webhook ingress (internet → Afe)

Unauthenticated network input reaches the process. Deliveries are only trusted
after **HMAC signature verification over the raw body** with a per-connection
secret, and are only processed once (**replay rejection** by delivery id, plus
timestamp freshness where the source signs one). Bodies are size-limited and
parsed only after verification. Handlers store the raw delivery, enqueue and
return 2xx quickly (ADR 0002), so slow processing cannot be used to tie up
request workers.

### TB2 – Outbound API calls (Afe → GitHub/Vercel/ArgoCD)

Afe holds tokens and calls out. Risks: credential leakage (logs, errors,
redirects to other hosts), over-privilege, SSRF through user-supplied URLs (the
ArgoCD server URL, a GitHub Enterprise URL, alert webhook URLs) and TLS
downgrade. Mitigated by read-only scopes, encrypted credentials wrapped in
`Secret`, the outbound URL policy (`validateOutboundUrl` + `createSafeLookup`)
and mandatory TLS verification with optional custom CAs.

### TB3 – In-cluster agent for ArgoCD (optional)

ArgoCD often has no public endpoint. The option is a small agent running inside
the customer's cluster that reads the ArgoCD API with a read-only token (the
token never leaves the cluster) and pushes batches **outbound** to Afe over
HTTPS. Afe treats the agent like a webhook source: each agent has its own
credential, every request is authenticated and signed, batches carry an
agent-assigned sequence number and delivery id (replay and gap detection), and
an agent can only write into the tenant/connection it was registered for. A
compromised agent can therefore lie only about its own ArgoCD instance, and gaps
in its sequence are recorded as observation gaps.

### TB4 – Database

PostgreSQL holds everything. The application connects with a role that should
not own the schema in production (so it cannot drop the append-only triggers).
Credentials are stored only as envelope ciphertext bound to tenant and id; a
database dump alone does not reveal them. The event log is append-only and
hash-chained, so an operator with SQL access can delete or change rows only
detectably (see "Tamper evidence" below).

### TB5 – UI and API (browser → Afe)

Authenticated through the `AuthProvider` extension point
([ADR 0006](../decisions/0006-api-authentication.md)): bearer tokens for API
clients, a signed HttpOnly session cookie with a session-bound CSRF token for
the UI, admin/viewer roles per route, fail-closed route policy (every `/api`
route requires authentication unless explicitly public). The server refuses to
start without an admin token unless bound to loopback. Never returns secret
values (credentials are write-only through the API; only metadata is readable).
In the hosted service every request is bound to exactly one tenant by the
`TenantResolver` before any data access.

## STRIDE analysis

| #   | Threat                                                                          | Boundary | Mitigation                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Spoofing** a webhook to inject fake deployment events                         | TB1      | HMAC-SHA256 (GitHub `X-Hub-Signature-256`) / HMAC-SHA1 (Vercel `x-vercel-signature`) over the raw body, constant-time compare; unsigned or unverifiable deliveries are rejected 401.            |
| S2  | Spoofing the ArgoCD agent                                                       | TB3      | Per-agent credential and signed requests; agent bound to one tenant and connection.                                                                                                             |
| S3  | Spoofing an upstream API via DNS/MITM                                           | TB2      | TLS verification always on; custom CA instead of disabling verification; no redirects to other hosts.                                                                                           |
| S4  | Spoofing a user/tenant in the UI/API                                            | TB5      | `AuthProvider` + `TenantResolver`; tenant derived from the authenticated session, never from a request parameter. Constant-time token compare; HMAC-signed sessions; CSRF token + Origin check. |
| S5  | Claiming someone else's GitHub App installation via an edited `installation_id` | TB5      | Signed, browser-bound install state; admin session of the starting tenant required at the callback; hosted: OAuth installer verification (`GET /user/installations`, ADR 0006).                 |
| T1  | **Tampering** with stored events (update/delete)                                | TB4      | Append-only `events` with triggers rejecting UPDATE/DELETE/TRUNCATE; per-tenant hash chain; exported chain heads (below).                                                                       |
| T2  | Tampering with stored credentials (swap ciphertext between tenants or rows)     | TB4      | AES-256-GCM with AAD = (tenant id, credential id) at both envelope layers; swapped or modified ciphertext fails to decrypt.                                                                     |
| T3  | Tampering with a webhook body in transit                                        | TB1      | Signature covers the exact raw bytes; body is never re-serialised before verification.                                                                                                          |
| R1  | **Repudiation**: a deployer claims "that was not me"/"that never happened"      | all      | Raw source payloads retained with the event; actor recorded as reported by the source; hash chain and integrity proof on export.                                                                |
| R2  | Missed events treated as "nothing happened"                                     | TB1/TB2  | Reconciliation polling; outages and sequence gaps recorded as observation gaps, not silence.                                                                                                    |
| I1  | **Information disclosure**: credentials in logs, errors, API responses          | all      | `Secret` wrapper, pino `redact` paths, `redactDeep`, write-only credential API, errors never include secret values.                                                                             |
| I2  | Credentials from a DB dump/backup                                               | TB4      | Envelope encryption; keys outside the DB (env/file or KMS).                                                                                                                                     |
| I3  | SSRF via user-supplied URL (cloud metadata, internal services)                  | TB2      | `validateOutboundUrl` (https only, no userinfo, resolved addresses checked) and `createSafeLookup` at connect time; link-local/metadata always blocked; private ranges opt-in self-host only.   |
| I4  | Cross-tenant data access (hosted)                                               | TB4/TB5  | `tenant_id` on every customer table, in every key and every query; see tenant isolation rules.                                                                                                  |
| I5  | Storing more customer data than needed (source code, secret values)             | TB2      | Data minimisation, see [`data-inventory.md`](data-inventory.md).                                                                                                                                |
| D1  | **Denial of service** by webhook floods or huge bodies                          | TB1      | Body size limit, signature check before parsing, cheap enqueue, rate limiting at the edge; Postgres queue absorbs bursts.                                                                       |
| D2  | Slow or hostile upstream APIs stalling workers                                  | TB2      | Timeouts on every outbound call, bounded retries with backoff, response size limits.                                                                                                            |
| D3  | Replay flood of a valid captured delivery                                       | TB1      | `webhook_deliveries` dedup returns early; no reprocessing.                                                                                                                                      |
| E1  | **Elevation of privilege** via over-scoped connector tokens                     | TB2      | Read-only scopes only (see rules); Afe never needs write access; documented per connector.                                                                                                      |
| E2  | Afe DB role dropping append-only triggers                                       | TB4      | Production runs the app with a non-owner role; migrations run separately with the owner role.                                                                                                   |
| E3  | Malicious dependency                                                            | build    | Lockfile, Dependabot, minimal dependencies, CI with read-only token.                                                                                                                            |

## Tamper evidence of the audit log

The event store (AFE-4, ADR 0002/0003) provides:

- **Append-only at the database level.** Triggers reject `UPDATE`, `DELETE` and
  `TRUNCATE` on `events`. An operator who owns the schema can still disable the
  triggers; that is why the following matters.
- **Per-tenant hash chain.** Each event stores `hash = H(prev_hash ‖ canonical
content)`. Changing, removing or reordering any event breaks every later hash.
  Verification recomputes the chain.
- **Anchoring outside the database.** A chain can be rewritten entirely by
  someone with full DB access and the code. Detection therefore depends on chain
  heads that left the database earlier: exports carry the head hash and count
  as an integrity proof, and operators are advised to record heads periodically
  somewhere the DB operator cannot edit (a ticket, a signed commit, object
  storage with retention lock). The hosted service anchors heads automatically.
  Afe publishes signed checkpoints itself when configured (AFE-29, ADR 0007:
  append-only file, webhook, RFC 3161 TSA), and `/api/audit/verify` and
  `afe verify-export --anchors` check the chain against them.
- **Raw evidence.** Raw payloads are stored next to the canonical event, so a
  disputed event can be checked against what the source actually sent.

What tamper evidence does **not** give: prevention. A sufficiently privileged
insider can still destroy the database; Afe makes that visible, not impossible.

## Residual risks and assumptions

- A compromised Afe host with keys loaded can decrypt credentials and forge new
  events. Mitigation is operational (least-privilege tokens limit blast radius;
  anchored chain heads limit rewriting history).
- GitHub webhooks carry no signed timestamp; replay protection relies on the
  delivery id store (kept longer than GitHub's redelivery window) plus
  idempotent ingestion by source event id.
- Self-hosters who enable `AFE_ALLOW_PRIVATE_NETWORK_TARGETS` accept that Afe
  users with connection-management rights can make Afe call internal
  addresses (still https-only unless also opted in, and never link-local).
- Web UI sessions are stateless: a stolen session cookie is valid until it
  expires (default 12 h); revoke all by rotating `AFE_SESSION_SECRET` or the
  token. Self-host GitHub installer verification is off by default (see
  ADR 0006).
- Vercel signs with HMAC-SHA1; this is the provider's choice. HMAC-SHA1 remains
  secure as a MAC; we accept it.

## References

- GitHub, validating webhook deliveries:
  https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- GitHub, webhook delivery headers (`X-GitHub-Delivery`, redelivery):
  https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers
- Vercel, securing webhooks (`x-vercel-signature`):
  https://vercel.com/docs/webhooks/webhooks-api#securing-webhooks
- ArgoCD RBAC (read-only roles): https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/
- OWASP SSRF prevention cheat sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
