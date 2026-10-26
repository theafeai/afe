# ADR 0002: Architecture, tech stack and open-core extension points

- Status: Accepted
- Date: 2026-10-26
- Issue: AFE-2

## Context

Afe records every way a deployment can happen across GitHub, ArgoCD and
Vercel, and who caused it, into a tamper-evident audit log. It must be:

1. trivially self-hostable by open-source users (one `docker compose up`), and
2. runnable later as a hosted multi-tenant service, whose extra features live in
   a separate private repository that depends on this one.

## Decision

### Runtime and language

- **TypeScript on Node.js 22 LTS**, ESM only, `strict` mode.
- **pnpm workspaces** monorepo.
- One language across API, workers, connectors and UI so canonical event types
  are shared end to end.

### Datastore

- **PostgreSQL (16+) is the only required infrastructure.**
- The audit log is an **append-only `events` table**:
  - `UPDATE`/`DELETE`/`TRUNCATE` are rejected by triggers;
  - each row carries a hash of its canonical content chained to the previous
    row's hash **per tenant** (tamper evidence; see ADR 0003);
  - a unique key on `(tenant_id, source, source_event_id)` makes ingestion
    idempotent (webhook and polling deliver the same event once).
- Mutable, queryable state (connections, installations, cursors, health) lives
  in ordinary tables next to it.
- Raw source payloads are stored in a separate `raw_payloads` table referenced
  by the event, so the canonical event stays small and the raw evidence is kept.
- Migrations are plain, forward-only SQL files in `packages/db/migrations`,
  applied by a small built-in migrator (no ORM). Database access uses `pg`.

### Jobs and queue

- **pg-boss** (Postgres-backed queue) for webhook processing, polling,
  reconciliation, backfill and health checks. No Redis or broker to run.
- Webhook handlers verify the signature, store the raw delivery, enqueue, and
  return 2xx fast. Workers normalise and ingest.
- Polling/reconciliation jobs are scheduled per connection with pg-boss cron.

### Processes and packaging

- A single container image with one entrypoint and roles:
  `afe server` (HTTP API + webhooks + static UI), `afe worker` (jobs), or
  `afe all` (both, the default for small self-hosted installs).
- HTTP framework: **Fastify**.
- UI: **React + Vite**, built to static files and served by the server.

### Repository layout

```
apps/
  server/               Fastify API, webhook receivers, workers, CLI entrypoint
  web/                  React UI
packages/
  core/                 canonical event model, hashing, interfaces/extension points
  db/                   migrations, migrator, repositories (event store, connections)
  connector-github/     GitHub App, webhooks, reconciliation
  connector-argocd/     ArgoCD connection, watch, reconciliation
  connector-vercel/     Vercel connection, webhooks, polling
docs/
  decisions/            ADRs (this file)
```

Package names: `@afe/core`, `@afe/db`, `@afe/connector-github`,
`@afe/connector-argocd`, `@afe/connector-vercel`, `@afe/server`, `@afe/web`.

### Multi-tenancy from day one

Every table that holds customer data has a `tenant_id` column, and every
repository function takes a tenant id. The open-source build runs with a single
built-in tenant (`default`). The hosted service supplies a different
`TenantResolver` (below); no schema change is needed.

### Open-core extension points

The server is assembled in one composition root, `createAfe(options)` in
`@afe/server`. Every capability that the paid product may replace is an
interface defined in `@afe/core` with an open-source default implementation:

| Extension point | Interface         | OSS default                               | Hosted/paid replacement                         |
| --------------- | ----------------- | ----------------------------------------- | ----------------------------------------------- |
| Authentication  | `AuthProvider`    | single admin token / no-auth on localhost | SSO, SAML, SCIM                                 |
| Multi-tenancy   | `TenantResolver`  | always `default` tenant                   | per-org tenants                                 |
| Secrets / keys  | `KeyProvider`     | key from env (`AFE_ENCRYPTION_KEY`)       | KMS-backed envelope keys                        |
| Retention       | `RetentionPolicy` | keep forever                              | per-plan retention with signed deletion records |
| Audit export    | `AuditExporter`   | CSV/JSON with integrity proof             | signed PDF evidence packs, SIEM streaming       |
| Connectors      | `Connector`       | GitHub, ArgoCD, Vercel                    | additional tools                                |
| Alerts          | `AlertSink`       | log + optional webhook                    | email, Slack, PagerDuty                         |

The private repository depends on the published `@afe/*` packages (or the
image) and calls `createAfe({ tenantResolver, authProvider, ... })`. Nothing in
this repository imports from the private one, and no paid feature is stubbed
here behind a flag.

## Consequences

- Self-hosters run two containers: Postgres and Afe.
- Postgres-as-queue limits throughput to what one database can serve; that is
  far above audit-event volumes for the foreseeable future. The queue sits
  behind pg-boss, so it can be swapped if needed.
- Hash chaining per tenant serialises inserts per tenant; acceptable at audit
  volumes, and it keeps tenants independent.
