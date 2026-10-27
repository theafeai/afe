# Afe – notes for agents and contributors

Read `docs/decisions/` first (ADRs are binding). Key points:

- TypeScript, Node 22, ESM, pnpm workspaces. Workspace packages export `src/*.ts`
  directly (no build step between packages); import siblings with `.ts` extensions.
- PostgreSQL is the only infrastructure. Plain `pg`, no ORM. Queue: pg-boss.
- Migrations: forward-only SQL in `packages/db/migrations`, named `NNNN_description.sql`.
  Never edit a migration that has been merged; add a new one.
- Every customer-data table has `tenant_id`; every data-access function takes a tenant id.
- Events are immutable once written: never UPDATE them. The only DELETE is the
  retention purge (`purgeEventsBefore` in `@afe/db`, job `retention.purge`, ADR 0008).
- There is no audit log, hash chain or export in this repository (ADR 0008); do not
  add tamper-evidence or "paid feature" placeholders. Extension seams: `EventSink`,
  `RetentionPolicy` (`createAfe({ sink, retentionPolicy })`).
- Never log credentials, tokens, webhook secrets or raw Authorization headers.
- Tests: vitest, files `*.test.ts` under `src/` or `test/`. DB tests use
  `createTestPool()` from `@afe/db/testing` (resets the schema; needs Postgres at
  `TEST_DATABASE_URL`, default `postgres://postgres:postgres@localhost:5432/afe_test`).
  Tests must not call real external APIs; use recorded fixtures or local fakes.
- Before committing: `pnpm lint && pnpm typecheck && pnpm test`. Run `pnpm format` to fix style.
- Commits must be signed off (`git commit -s`).

## Server and connector wiring

- Connections: every connector registers its connections in the shared `connections`
  table (`upsertConnection` etc. in `@afe/db`, model in `@afe/core` `connection.ts`).
  Secrets go in `credentials` and are linked with `attachConnectionCredential`.
- Connector packages hold pure logic (API clients, payload mapping, signature checks).
  Server wiring lives in `apps/server/src/connectors/<source>.ts` as a `ConnectorModule`
  (routes, jobs, health hooks), registered in `apps/server/src/connectors/index.ts`.
- Webhook routes: `POST /webhooks/<source>`; `req.rawBody` holds the exact bytes for
  signature verification. Verify, record the delivery (replay guard), enqueue a job,
  return 2xx fast. Workers map and ingest via `ctx.sink`.
- Jobs: `JobDefinition` (name prefixed by owner, optional cron `schedule`). Tests use
  `InlineJobQueue` (`register` + `drain`); production uses pg-boss.
