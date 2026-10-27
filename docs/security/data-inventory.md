# Data inventory

- Status: Binding (AFE-5). New stored fields must be added here in the same PR
  (rule R8 in [`rules.md`](rules.md)).

Afe answers "who deployed what, to where, and when". It stores what is needed to
answer that with evidence, and deliberately nothing more.

## What Afe stores

| Data                                     | Examples                                                                                                                                                                                                                             | Table(s)                                              | Sensitivity                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------ |
| Tenants                                  | id, name                                                                                                                                                                                                                             | `tenants`                                             | Low                                  |
| Canonical deployment events              | source, event type, time, target environment/app/project, commit SHA, ref, status, actor                                                                                                                                             | `events`                                              | Confidential (business)              |
| Actor identity as reported by the source | GitHub login and numeric id, Vercel user id/username, ArgoCD username/SSO subject                                                                                                                                                    | `events`                                              | Personal data                        |
| Raw source payloads (evidence)           | webhook bodies and API responses for deployment-related resources                                                                                                                                                                    | `raw_payloads`                                        | Confidential; may hold personal data |
| Hash chain values                        | per-event hash, previous hash                                                                                                                                                                                                        | `events`                                              | Low                                  |
| Connection configuration                 | tool kind, ArgoCD server URL, GitHub installation id, Vercel team id, custom CA certificate; ArgoCD version, account name and read-only check result                                                                                 | connection tables (connectors)                        | Confidential                         |
| Encrypted credentials                    | ciphertext, wrapped data key, nonce, key id, kind, timestamps                                                                                                                                                                        | `credentials`                                         | Secret (encrypted)                   |
| Webhook delivery ids                     | source, delivery id, received time, tenant id                                                                                                                                                                                        | `webhook_deliveries`                                  | Low                                  |
| ArgoCD capture state (AFE-10)            | per app: uid, name, sync/health status, last operation start/phase, history ids, spec hashes, spec summary (repo, path, revision, destination, sync policy, image overrides), images; per connection: baseline time, resourceVersion | `argocd_capture_cursors`, `argocd_application_states` | Confidential                         |
| Operational state                        | polling cursors, connection health, observation gaps, job queue rows                                                                                                                                                                 | connector / pg-boss tables                            | Low                                  |
| Connection health and alerts (AFE-13)    | health state, timestamps, sanitised last error (no credentials), alert messages, outbox                                                                                                                                              | `connection_health`, `alerts`, `health_outbox`        | Low                                  |
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

## Retention and deletion

- Open-source default: keep forever (`RetentionPolicy` extension point).
- Credentials: deleted logically by revocation, which destroys the ciphertext;
  the metadata row stays for the audit trail.
- Webhook delivery ids: may be pruned after 30 days.
- Hosted: per-plan retention with signed deletion records (paid repository).

## Personal data

Actor identifiers are personal data. They are the point of an audit log, so
they are kept for the retention period. Self-hosters are the controller; the
hosted service acts as processor. Erasure requests are handled by the
`RetentionPolicy` with a signed deletion record so the chain stays verifiable.
