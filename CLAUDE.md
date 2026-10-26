# Afe – notes for agents and contributors

Read `docs/decisions/` first (ADRs are binding). Key points:

- TypeScript, Node 22, ESM, pnpm workspaces. Workspace packages export `src/*.ts`
  directly (no build step between packages); import siblings with `.ts` extensions.
- PostgreSQL is the only infrastructure. Plain `pg`, no ORM. Queue: pg-boss.
- Migrations: forward-only SQL in `packages/db/migrations`, named `NNNN_description.sql`.
  Never edit a migration that has been merged; add a new one.
- Every customer-data table has `tenant_id`; every data-access function takes a tenant id.
- The `events` table is append-only. Never UPDATE/DELETE it.
- Never log credentials, tokens, webhook secrets or raw Authorization headers.
- Tests: vitest, files `*.test.ts` under `src/` or `test/`. DB tests use
  `createTestPool()` from `@afe/db/testing` (resets the schema; needs Postgres at
  `TEST_DATABASE_URL`, default `postgres://postgres:postgres@localhost:5432/afe_test`).
  Tests must not call real external APIs; use recorded fixtures or local fakes.
- Before committing: `pnpm lint && pnpm typecheck && pnpm test`. Run `pnpm format` to fix style.
- Commits must be signed off (`git commit -s`).
