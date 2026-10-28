# Data inventory

- Status: Binding (AFE-5). New stored fields must be added here in the same PR
  (rule R8 in [`rules.md`](rules.md)).

Afe answers "who deployed what, to where, and when" for the recent past. It
stores what is needed to answer that, deliberately nothing more, and only for
a limited time (see "Retention and deletion").

## What Afe stores

| Data                                     | Examples                                                                                                                                                                                                                             | Table(s)                                              | Sensitivity                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------ |
| Tenants                                  | id, name                                                                                                                                                                                                                             | `tenants`                                             | Low                                  |
| Canonical deployment events              | source, event type, time, target environment/app/project, commit SHA, ref, status, actor                                                                                                                                             | `events`                                              | Confidential (business)              |
| Actor identity as reported by the source | GitHub login and numeric id, Vercel user id/username, ArgoCD username/SSO subject                                                                                                                                                    | `events`                                              | Personal data                        |
| Raw source payloads (debugging)          | webhook bodies and API responses for deployment-related resources                                                                                                                                                                    | `raw_payloads`                                        | Confidential; may hold personal data |
| Connection configuration                 | tool kind, ArgoCD server URL, GitHub installation id, Vercel team id, custom CA certificate; ArgoCD version, account name and read-only check result                                                                                 | connection tables (connectors)                        | Confidential                         |
| Encrypted credentials                    | ciphertext, wrapped data key, nonce, key id, kind, timestamps                                                                                                                                                                        | `credentials`                                         | Secret (encrypted)                   |
| Webhook delivery ids                     | source, delivery id, received time, tenant id                                                                                                                                                                                        | `webhook_deliveries`                                  | Low                                  |
| ArgoCD capture state (AFE-10)            | per app: uid, name, sync/health status, last operation start/phase, history ids, spec hashes, spec summary (repo, path, revision, destination, sync policy, image overrides), images; per connection: baseline time, resourceVersion | `argocd_capture_cursors`, `argocd_application_states` | Confidential                         |
| ArgoCD agent state (AFE-28)              | per agent: last heartbeat and its counters, run id, last batch sequence, dropped count, waiting-for-snapshot state; staged batches (Application objects as the agent sent them, deleted once processed)                              | `argocd_agents`, `argocd_agent_batches`               | Confidential                         |
| Operational state                        | polling cursors, connection health, observation gaps, job queue rows                                                                                                                                                                 | connector / pg-boss tables                            | Low                                  |
| Connection health and alerts (AFE-13)    | health state, timestamps, sanitised last error (no credentials), alert messages, outbox                                                                                                                                              | `connection_health`, `alerts`, `health_outbox`        | Low                                  |
| Drift findings (AFE-26)                  | finding type, severity, target, mapped service/environment, explanation and evidence summaries (may name actors and images), alert delivery state; per-tenant drift settings                                                         | `drift_findings`, `drift_settings`                    | Confidential; may hold personal data |
| Logs (stdout, not the DB)                | request method/path/status, delivery ids, error kinds                                                                                                                                                                                | –                                                     | Low (redacted)                       |

Raw payloads are stored as received, after removing the fields listed in "What
Afe deliberately does not store" when a source includes them; connectors list
the paths they strip and test it.

- GitHub (AFE-7): every non-null `email` member and `pull_request.body` are
  removed from webhook bodies; commit messages, deployment review comments and
  the caller-supplied `deployment.payload` / `repository_dispatch.client_payload`
  are kept in the raw payload only (never in `events.data`). Events hold commit
  SHAs mentioned in commit messages / PR bodies (`correlation.upstreamCommitShas`), not
  the text. See docs/connectors/github.md "Raw payloads".

## What Afe deliberately does not store

| Not stored                                                                 | Why / how it is avoided                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Source code and file contents**                                          | Afe never clones repositories or downloads file contents/archives/diffs. Only commit SHAs, refs and commit metadata.      |
| **Secret values** (repo/org/environment secrets)                           | Afe never calls secret-value endpoints; names of secrets are not needed and are not stored either.                        |
| **Environment variable values** (Vercel env, Actions vars, Kubernetes env) | Stripped from payloads (e.g. Vercel deployment/project `env`, `build.env`); not fetched.                                  |
| Kubernetes manifests, rendered resources, Helm values, `Secret` objects    | ArgoCD connector reads application status/history/operation state only, not manifests or resource trees with values.      |
| Build and job logs                                                         | Logs routinely contain secrets; Afe links to them by URL instead.                                                         |
| Plaintext credentials, tokens, private keys                                | Only envelope ciphertext; keys are outside the DB.                                                                        |
| Webhook signatures and `Authorization`/`Cookie` headers                    | Verified, then dropped; headers stored with raw deliveries go through `redactHeaders`.                                    |
| Webhook secrets in plaintext                                               | Stored like any other credential.                                                                                         |
| End-user passwords                                                         | Authentication is delegated to the `AuthProvider` (admin token or SSO).                                                   |
| Pull request bodies, issue text, review comments                           | Not needed to answer "who deployed what"; only PR number/title/URL where linked to a deployment.                          |
| Email addresses                                                            | Not stored unless the source only identifies the actor by email (git commit author); then stored as the actor identifier. |

## Terraform CLI metadata

Terraform connection configuration stores workspace, optional environment and
repository identifiers plus a random reporter identity (`connections`). Its
scoped HMAC reporter secret is generated once and stored encrypted via
`credentials`/`connection_credentials`, never in config or staged reports.

Strictly validated reports store version, run UUID, operation, phase, send/event
timestamps, numeric exit code, optional actor handle, full commit SHA,
repository, GitHub run ID and trigger in `terraform_reports` until ingestion.
Canonical `events` retain the lifecycle, configured workspace/environment,
correlation and explicit runner-reported attribution. This metadata may contain
personal actor handles and confidential business identifiers. No raw Terraform
payload is stored. State, plan contents, resource values/addresses, outputs,
diagnostics, log text and arbitrary extra fields are rejected, not redacted
after storage. Signatures are verified then discarded.

Staged reports are deleted after event-sink commit, on disconnect, or through
connection deletion. Scheduled processing drops events already outside normal
retention. The pending queue is capped at 1,000 reports per connection; runners
must retry 429 responses. Event retention and replay-id retention below apply.

## Retention and deletion

Afe keeps events for a fixed window and then deletes them (ADR 0008). This
bounds how much personal data Afe holds and for how long, which is a privacy
improvement over keeping an indefinite history.

| Data                                           | Kept for                                                          | Deleted by                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Events (incl. actor identities, `data`)        | `AFE_EVENT_RETENTION_DAYS` after `occurredAt`: default 30, max 60 | `retention.purge` job, hourly; events already older are never stored                                                             |
| Raw payloads                                   | as long as their event                                            | the same purge, in the same transaction as the event; unreferenced payloads older than the window too                            |
| Observation gaps and alerts recorded as events | as events                                                         | the same purge (current health state stays in `connection_health`)                                                               |
| Drift findings (summaries of their events)     | until resolved (or last seen) longer ago than the window          | the `drift.evaluate` job, every minute ([drift.md](../drift.md#retention))                                                       |
| Webhook delivery ids                           | replay window (may be pruned after 30 days)                       | `pruneWebhookDeliveries`                                                                                                         |
| Credentials                                    | until revoked or rotated                                          | revocation destroys the ciphertext; the metadata row (kind, timestamps, no secret) stays so the connection shows when it changed |
| Connection configuration and capture state     | while the connection exists                                       | not purged by retention (contains no event history)                                                                              |

- The window is measured on the event's `occurredAt` (when it happened in the
  source).
- 60 days is the maximum of the open-source build; a larger value stops Afe
  from starting.
- Deleted rows remain in database backups until those expire; size backup
  retention accordingly.
- `RetentionPolicy` is an extension point: another build can supply its own.

## Personal data

Actor identifiers (logins, user ids, names, emails where the source only
identifies the actor by email) are personal data. Afe needs them to show who
deployed what, and keeps them only for the retention window. Self-hosters are
the controller. An erasure request for a person can be met by waiting for the
window to pass, or by deleting that person's events earlier with SQL; events
have no hash chain, so nothing else needs to change.

## Local account email

User records may include an administrator-provided email address, normalized to
lowercase and unique within the tenant. It is used only for invitations and
credential recovery. SMTP is an optional outbound account-notification channel;
sending these requested account messages requires SMTP writes, independently of
read-only delivery-tool connectors (R1). There are no inbound mail webhooks.

Email-action records contain tenant/user IDs, purpose, email address, credential
version, timestamps, and a SHA-256 digest of a random 256-bit single-use token.
Outbox records contain state, attempts, timestamps and a credential reference.
The recipient, subject, body and link token are encrypted only through the
credentials repository, never stored in plaintext job/config payloads. The
ciphertext is destroyed after acceptance, expiry/invalidation or five failed
attempts. Metadata and link records are purged seven days after expiry while
the worker is running. User email stays until cleared/replaced by an admin.
SMTP relay delivery can put these emails in provider/recipient mailboxes;
provider retention and bounce reporting are outside Afe.

## Personal ArgoCD OIDC

A connection's non-secret configuration can include its trusted OIDC issuer,
client ID, scope names, authentication method, optional public CA bundle and a
random revision. Client secrets, PKCE verifiers/nonces and user ID tokens are
stored only through the tenant-bound encrypted credentials repository. Temporary
state metadata stores tenant/user/connection IDs, a state digest, hashed browser
session binding, credential reference, expiry and consumption time. Flow payloads
are destroyed on callback/unlink/replacement or expiry cleanup; state metadata
is removed by the hourly worker cleanup (or the next login in that tenant).
Personal account context adds the selected connection, configuration revision
and ID-token expiry. Group/email claims are not separately copied into tables;
the encrypted ID token inherently contains the provider's identity claims.

OIDC authorization-code exchange is an authentication-lifecycle POST to the
validated issuer's token endpoint. Application access continues to use read-only
ArgoCD API calls. There are no inbound webhooks in this flow. Callback state is
single-use and bound to the tenant, user, session and connection. No client
secrets, token/code/state values, upstream response bodies or PKCE material are
logged. Settings API responses contain no secret values.
