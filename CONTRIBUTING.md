# Contributing to Afe

Thanks for helping. Afe is licensed under [Apache-2.0](LICENSE) and uses the
[Developer Certificate of Origin](DCO) (see
[ADR 0001](docs/decisions/0001-license-and-contributor-policy.md)).

## Sign off every commit

```sh
git commit -s -m "Describe the change"
```

This adds `Signed-off-by: Your Name <you@example.com>`, certifying you wrote the
change or otherwise have the right to submit it under the project license. CI
rejects pull requests with unsigned commits. To fix an existing branch:
`git rebase --signoff main` and force-push.

## Development environment

Everything runs in a plain Linux container (Claude Code on the web, Codespaces,
or any machine) with Node.js 22, pnpm and PostgreSQL 16:

```sh
corepack enable          # provides pnpm
pnpm install
# Tests use TEST_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/afe_test)
pnpm lint && pnpm typecheck && pnpm test
pnpm build
```

No Docker is needed for development; any reachable Postgres works.

## Pull requests

- Keep each PR focused on one issue; reference it (e.g. `AFE-12`) in the description.
- CI (lint, typecheck, tests, build, DCO, CodeQL, dependency review, secret scan)
  must pass before merge.
- Architecture changes need an ADR in `docs/decisions`.
- New or changed integrations must complete the security checklist in the PR template.

## Repository settings (maintainers)

`main` is protected: pull requests required, required status checks
(`Lint, typecheck, test, build`, `DCO sign-off`), up-to-date branch, no force
pushes. Secret scanning with push protection and Dependabot alerts are enabled in
the repository security settings.
