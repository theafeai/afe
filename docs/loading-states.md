# Loading resource state

AFE-94 distinguishes an unresolved request from a known application state.

## Shared requests

`useAsync(load, resourceDependencies, refreshKey?)` returns `data: null` and
`loading: true` immediately when resource dependencies change. It aborts the old
request and ignores late completions, even when a transport ignores cancellation.
A different event, user, repository, ref, attempt or page must be a different
resource dependency (or a keyed component).

Use `reload()` or the optional third `refreshKey` argument to refresh the same
resource. Existing content remains available with `loading: true`. Transient
errors retain it alongside the error; 401, 403 and 404 clear it. Consumers must
check loading and errors before allowing operations based on retained data.

`usePaged` shares that lifetime with all cursor requests. Changing filters,
refreshing or unmounting cancels pagination; stale items and cursors cannot attach
to another query. Duplicate load-more requests are guarded synchronously. Existing
items stay visible while the first page refreshes.

## Audited flows

| Flow                                        | Loading and context behavior                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub repository/view/page selection       | Keyed repository workspaces and resource-scoped list/capability requests; no previous view's data under the new heading.                                                                  |
| Workflow run, job and step statuses         | Known source values map explicitly; absent or unrecognized values are neutral unknown, never invented pending/progress.                                                                   |
| Event workflow progress                     | Keyed by event; polling retains valid progress, reports refreshes, clears revoked data and ignores aborted completions. Update controls appear only after progress resolves.              |
| GitHub operation buttons                    | Capability checks have a loading message distinct from unavailable reasons. Preparation and execution also require resolved capabilities. Run actions wait for authoritative run details. |
| Workflow refs and inputs                    | Changing the loaded ref clears the previous input schema immediately. Dispatch waits for inputs, environment choices and capabilities; ref/environment loads and errors are explicit.     |
| Environment reviewer dropdown               | Loading, error and empty options are explicit; options reload when capability eligibility changes. Existing environment details load before editor defaults are constructed.              |
| Run attempt, jobs and logs                  | Attempt-specific requests clear old data, preserve valid content on refresh and block log access until the current capability check completes.                                            |
| Timeline, deployments and placement history | Shared cursor lifetime; refreshes retain rows. Placement-history metadata is scoped to the same cell/target and checked for cancellation.                                                 |
| Drift pagination                            | Query-scoped continuation requests, cancellation and explicit continuation errors prevent stale findings from another filter.                                                             |
| Mapping                                     | Refresh revisions are separate from resource dependencies, preserving editor and pagination state.                                                                                        |
| Other `useAsync` detail pages               | Event/user/connection/journey dependencies invalidate data synchronously; existing initial-load, error and empty renderers remain in control.                                             |

The visual checks and screenshots are in
[screenshots/afe-94](screenshots/afe-94/README.md). Server authorization, source
version checks, confirmation and idempotency remain authoritative at execution.
