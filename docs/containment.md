# Commit containment

"Is commit X included in what is live in environment Y?" (AFE-22, research
[follow-up 10](research/0001-cross-tool-flow.md#proposed-follow-up-issues)).

Without it, a pull request's head commit stops at "merged as M": Afe sees M
deployed, but not that the PR's commits went with it, or that an older commit
is already in production because a later deployment included it.

Code: `packages/connector-github/src/compare.ts` (`compareCommits` on the
installation client), `apps/server/src/containment/` (live state, cache,
service, `GET /api/containment`), `apps/web/src/pages/ContainmentPanel.tsx`.

## The rule

GitHub's compare API, `GET /repos/{owner}/{repo}/compare/{base}...{head}`,
reports how `head` relates to `base`:

| compare(X, L).status | X contained in live commit L? | `reasonCode`   |
| -------------------- | ----------------------------- | -------------- |
| `identical`          | yes                           | `same_commit`  |
| `ahead`              | yes (X is an ancestor of L)   | `ancestor`     |
| `behind`             | no (L is older than X)        | `not_yet_live` |
| `diverged`           | no (different history)        | `diverged`     |

When X equals L (either side may be abbreviated) Afe answers `same_commit`
without calling GitHub.

## What is live where

For the requested repository Afe reads the newest placement events within the
retention window (at most 1000): `deployment.status_updated` with outcome
`succeeded` (not a Vercel build that did not get the domains),
`deployment.promoted`, `deployment.rolled_back` and `argocd.sync.succeeded`.
Per environment the newest one is live:

- The environment is the tenant's mapped environment
  ([environment mapping](environment-mapping.md), AFE-19) when a rule applies,
  else the tool's own name. Preview environments are per branch.
- The live commit is the event's commit only when the event is about this
  repository alone and names exactly one commit. Otherwise `liveCommit` is
  null and the answer is `unknown` (`live_commit_unknown`): an ArgoCD
  multi-source app, or a deployment without Git metadata.
- `liveSince` is the earliest of the consecutive newest placements of the same
  commit (a redeploy does not reset it); `evidence` lists those event ids.

For ArgoCD this is the revision of the repository the application syncs: ask
about the config (GitOps) repository's commits there. Following images back
to the application repository's commits is the correlation service's job
(AFE-20), which will replace this small live-state function.

## GitHub permission (optional)

The compare endpoint needs the repository permission **`contents: read`**
for GitHub Apps. It is optional for Afe (`OPTIONAL_READ_PERMISSIONS`) and not
requested by the App manifest, because it also allows reading source code;
Afe never does. Without it every comparison is `unknown` with
`missing_permission`, and nothing else changes.

To enable containment: in the App's settings, set Repository permissions →
Contents → Read-only, then accept the updated permissions on each
installation. The connection's stored permissions update from the
`installation` webhook (`new_permissions_accepted`).

The repository must be covered by an active GitHub connection of the tenant:
selected in the installation, or an "all repositories" installation on the
repository's owner. Otherwise: `repository_not_connected`.

## Degradations

Every failure is an `unknown` with a reason; the request itself succeeds.

| `reasonCode`                | Cause                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `missing_permission`        | Installation lacks `contents: read`                                                   |
| `repository_not_connected`  | No active installation of the tenant covers the repository                            |
| `github_not_configured`     | No GitHub App configured on this server                                               |
| `installation_token_failed` | Afe could not mint an installation token (suspended, uninstalled)                     |
| `commit_not_found`          | GitHub 404: unknown commit, or removed by a force-push (also: repository not visible) |
| `forbidden`                 | GitHub 401/403 that is not a rate limit                                               |
| `rate_limited`              | Primary or secondary rate limit; `retryAfter` is set and no more calls are made       |
| `timeout`                   | One comparison took longer than its budget                                            |
| `github_unreachable`        | Network error after the client's retries                                              |
| `not_checked_deadline`      | The request's time budget was used up before this comparison                          |
| `not_checked_limit`         | More environments than the per-request limit                                          |

`partial: true` in the response marks answers that are incomplete because of
bounded work (deadline, limit, rate limit, timeout, or more placements than
were read); `notes` explain.

## Bounds

Per request: at most 10 environments checked (newest first), one comparison
per distinct live commit, 4 in flight, 5 s per comparison and 10 s in total
(`ContainmentOptions` in `createContainmentModule`). The GitHub client's own
timeouts, retries and rate-limit tracking apply underneath. Only one commit
per page is requested and only `status`, `ahead_by`, `behind_by` and the
merge-base SHA are kept: no commit messages, authors or file names.

## Cache

Ancestry of two commit SHAs never changes, so results are cached without
expiry: an in-memory LRU (5000 entries) in front of the tenant-scoped table
`commit_comparisons` (migration 0022), keyed by tenant, repository, base and
head. Errors and `unknown` are never cached. The `containment.prune` job
(daily) deletes rows not used within the retention window (`last_used_at`).
The table is derived data and may be truncated at any time.

## Reuse (AFE-20)

`containmentService(ctx)` (apps/server/src/containment) returns the service
bound to a server context:

- `isContained(tenantId, "owner/name", commit, liveCommit)` → verdict
  (`contained`, `reasonCode`, `reason`, `comparison`, `cached`); never throws
  for GitHub failures.
- `check(tenantId, "owner/name", commit)` → the API report.

## UI

The event detail page shows "Where is this commit live?" for events with a
`github.com` repository and a commit SHA (the first of each in the event's
correlation keys): per environment the live commit, since when, whether the
commit is included, why, and a link to the placement event.

## Limitations

- One live commit per (repository, environment). A monorepo deploying several
  services from one repository to the same environment shows the newest one
  only; the correlation service (AFE-20) will key by service.
- Renamed repositories: the cache and the connection lookup use the current
  `owner/name`; events recorded under the old name are matched only by the
  name they carry.
- Only GitHub repositories (the compare API); other hosts answer `400`.

## To verify against docs

- Compare endpoint, `status` values and their direction (`ahead` = head has
  commits base lacks), `per_page` limiting the commit list, 404 for unknown
  commits: https://docs.github.com/en/rest/commits/commits#compare-two-commits
- Permission needed by GitHub Apps ("Contents" repository permission, read):
  https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-contents
- Response for commits without a common ancestor (assumed 404 → `commit_not_found`).
- Manual: run against a real installation with and without `contents: read`,
  a force-pushed-away commit, and a repository not selected in the installation.
