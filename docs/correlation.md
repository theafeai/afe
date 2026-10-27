# Correlation: environment state and journeys

Issue: AFE-20 (productionises the AFE-15 prototype,
[research 0001](research/0001-cross-tool-flow.md)). Code:
`@afe/core/correlation` (pure: links, environment targets, journeys, gaps),
`@afe/db` `listCorrelationEvents`, `apps/server/src/correlation/` (service,
API). API reference: [api.md](api.md#environments-and-journeys).

Correlation answers two questions on top of the stored events:

- **What is live where, and how did it get there?** An environment matrix of
  services × environments (from the [mapping](environment-mapping.md)), each
  cell saying what runs (commit, image, deployment), since when, through which
  event, how sure Afe is, and the placement history behind it.
- **Where did this commit go?** A per-commit journey: change → CI → artifact →
  config → deploy → runtime, with the evidence and confidence of every edge.

## Decision: compute on read, cached per tenant

No derived tables. The correlation service keeps, per tenant, the
correlation-relevant events of the retention window in memory and derives
everything from them on read:

1. **Window.** Events with any correlation key (or a legacy
   `data.correlationHints`), plus observation gaps, with
   `occurredAt >= retention cutoff`. A compact projection is read
   (`listCorrelationEvents`: no raw payloads, only the `data` fields
   correlation and mapping use).
2. **Incremental load.** Events are immutable and a tenant's `seq` order is
   its commit order (ADR 0008), so each request first reads only events with
   `seq` above the last one loaded (one indexed query; nothing new → nothing
   read). Events that fell out of the retention window are dropped.
3. **Recompute.** When the window changed, the graph (links, conflicts,
   environment targets with placement history) is recomputed from scratch,
   at most every `max(minRecomputeMs, 2 × last compute time)` (default
   2 s): a busy tenant costs at most about a third of a core, and responses
   in between reflect the previous graph (`window.asOfSeq`, `window.stale`).
   Concurrent requests share one refresh.
4. **Read.** Mapping (service/environment per target) is resolved per request
   with the tenant's current mapping (cached per revision by the mapping
   service), so a mapping change applies immediately. Journeys and event links
   are lookups in the cached graph.

Bounds: `maxEvents` per tenant (default 250 000; beyond it the oldest are
dropped and `window.truncated` is set), `maxTenants` in memory (default 16,
least recently used evicted). Nothing is persisted, so there is nothing to
migrate, rebuild, back up or keep consistent: late events (reconciliation,
backfill), retention purges and mapping changes are all reflected by the
next recompute.

### Measurements

Synthetic workload (`apps/server/test/fixtures/correlation-workload.ts`,
deterministic): 50 repositories over 30 days, three tools: 60% GitOps services
(push → run + jobs → `artifact.published` → bump commit in a deploy repo →
ArgoCD staging sync + health; one in five promoted to production by a PR
pinning the digest; one in ten CI runs fails; the odd manual image override;
every tenth service uses the mutable tag `:latest`), 30% Vercel projects
(previews, production, GitHub deployment mirrors, rollbacks, CLI deploys) and
10% GitHub Actions deployments, plus observation gaps. Run with
`node --expose-gc --import tsx apps/server/test/bench/correlation-bench.ts`
(resets `TEST_DATABASE_URL`). PostgreSQL 16 and Node 22 on the development
container (shared CPU; treat as orders of magnitude):

| Events (pushes/repo/day) | Links   | Targets | Cold load + compute | Compute only | Warm (no new events) | After 1 new event | Journey | Heap   |
| ------------------------ | ------- | ------- | ------------------- | ------------ | -------------------- | ----------------- | ------- | ------ |
| 4 500 (0.3)              | 21 546  | 203     | 194 ms              | 71 ms        | 4 ms                 | 63 ms             | 0.06 ms | 17 MB  |
| 23 370 (1.5)             | 111 287 | 295     | 826 ms              | 419 ms       | 7 ms                 | 615 ms            | 0.06 ms | 74 MB  |
| 89 404 (5.5)             | 427 012 | 305     | 3 344 ms            | 2 275 ms     | 1 ms                 | 2 543 ms          | 0.07 ms | 269 MB |

The AFE-15 prototype took **330 s** for the links alone at 89k events (its
pairwise linking is quadratic in hot keys: `:latest`, long-lived config
commits) and reported 68 000 conflicts. The production linker
(below) is linear in the number of events.

The alternative, a derived `event_links` table maintained on ingest, measured
in the same run:

| Events | Full rebuild (insert only) | Table size | Incremental per ingested event (median / p95) | Reading the links of all placements back |
| ------ | -------------------------- | ---------- | --------------------------------------------- | ---------------------------------------- |
| 4 500  | 0.3 s                      | 8 MB       | 4.2 / 7.2 ms                                  | 13 ms                                    |
| 23 370 | 2.5 s                      | 41 MB      | 8.6 / 12.4 ms                                 | 73 ms                                    |
| 89 404 | 9.1 s                      | 157 MB     | 10.6 / 18.3 ms                                | 606 ms                                   |

Why compute-on-read wins here:

- **Retention bounds the data** (≤ 60 days, ADR 0008). Typical tenants are in
  the 5k–25k range, where a cold request is under a second and every request
  without new events costs one `seq` query.
- **Links alone do not answer the questions.** Environment state needs
  time-bound artifact attribution (which builds of a tag existed at the
  placement), mapping, gaps and history; with a links table all of that still
  has to be computed at read time from events _and_ links, and reading the
  placement links back alone costs 0.6 s at 89k.
- **Consistency.** A derived table must be kept right under late and
  out-of-order events (a backfilled build changes older tag attributions),
  retention purges, link-rule changes and rebuilds; compute-on-read cannot
  disagree with the events.
- Incremental maintenance would cost 5–20 ms of extra database work per
  ingested event and up to ~160 MB of table per 90k events.

When to revisit: tenants beyond ~250k correlation events in the window, or
many such tenants per server process. The path then is to persist the
per-tenant graph snapshot or to partition it per repository; the read API
does not change.

## Linking (core)

`buildLinks(events)` groups events per key ("bucket") and records typed
evidence; confidence levels and evidence kinds are those of the prototype
(`EVIDENCE_CONFIDENCE`): `certain` (same deployment id, run id, commit in the
same repository), `strong` (same image digest, same commit across
repositories, same deployment URL host), `probable` (image tag with one
producer, tag naming a commit, a reference from a bump commit or PR),
`weak` (mutable tag, time proximity). A path's confidence is its weakest
link; weak steps are not expanded.

Production changes:

- **Linear size.** Buckets of up to 24 events are linked pairwise (as in the
  prototype). Larger buckets are linked as a chain in time order plus a link
  to the bucket's first event; references (`upstreamCommitShas`, tags naming a
  commit) link to the first event of a large bucket. Every member stays
  reachable forward in time with the same evidence kind. Large image-tag
  buckets link each event to the five most recent builds of the tag that
  existed at its time.
- **Keys:** `commitShas`, `repositories`, `deploymentIds`, `runIds`,
  `imageDigests`, digest-pinned `imageRefs` (`name:tag@sha256:…`; the digest
  stays paired with its image), `upstreamCommitShas` and `deploymentUrls`
  (AFE-18), with the legacy `data.correlationHints`
  (`mentionedCommitShas`, `mentionedImageDigests`, `deploymentUrls`) read as
  a fallback for events stored before AFE-18.
- **Artifacts (AFE-21).** `artifact.published` and
  `artifact.provenance_resolved` are build events. Build events with the same
  digests form one _artifact_: when the attestation arrives after the
  deployment, the published event (no commit) and the provenance event (commit,
  run) are one candidate, so the placement is attributed `strong` by digest.
  Digest matches are not time-bound (content addressed); tag matches only
  count artifacts that existed at the placement.
- **Conflicts** are reported, never linked, once per key:
  `tag_digest_mismatch` (same `name:tag`, different digests: a moved tag or a
  deployment running something else) and `digest_commit_mismatch` (builds of
  one digest claim different commits, e.g. OCI label vs attestation).

## Environment state

A **target** is one place something is deployed to, as the tool names it:
an ArgoCD application (`argocd:<ns>/<app>`), a Vercel project and target
(`vercel:<project>:production`, previews per branch), a GitHub repository
environment. A **placement** is an event after which something new is live
in a target: `argocd.sync.succeeded`; a successful
`deployment.status_updated` whose domains were assigned
(`data.aliasAssigned !== false`); `deployment.promoted`;
`deployment.rolled_back`.

Per placement:

- `kind`: `deploy`, `promotion`, `rollback`, `redeploy` or `manual`
  (from the action and `trigger.type`).
- content: images (with candidate builds) and app `commits`, each with
  confidence and `via` (how it was attributed); ArgoCD's synced GitOps
  revision separately as `configRevision` (never the app commit).
- `attribution.status`: `attributed`, `ambiguous` (an image traces to several
  commits: mutable tag), `guess` (no Git metadata; weak time-proximity guess),
  `unknown` (e.g. an image no observed build produced); `confidence` is the
  weakest attributed commit (`weak` when ambiguous, null when unknown).
- `evidenceEventIds`: the build or same-deployment events it relies on.

**Matrix.** Rows and columns come from the tenant's
[mapping](environment-mapping.md): each target is resolved (service,
environment) by its current placement event with `ctx.mapping`. Targets no
rule maps go to the explicit **unmapped** bucket (`_unmapped`), never
guessed. A cell can hold several targets (two clusters, or Vercel production
and its GitHub `Production – web` mirror): `live` is the most recent
placement, `consistent` says whether all targets run the same content.

**Since when.** `since` is the current placement; `contentSince` is when the
same content (same commits and images) first went live without interruption
(a restart or redeploy of the same image does not reset it).

**Observation gaps.** Gap spans come from `observation_gap.opened/closed`
events (an open gap lasts until now). A gap applies to an event of the same
connection (`connectionId`), or of the same source when the event has no
connection. Each placement lists `gaps` with a `relation`:

- `evidence_in_gap`: the placement or an event its attribution relies on
  happened while its connection was not observed (it was recovered later;
  related events may still be missing);
- `after_placement` (current placements only): the target's connection is
  not being observed right now (an open gap), so a later placement may have
  been missed ("possibly stale"). Closed gaps do not count: recovery runs a
  backfill over the gap window, so anything missed was re-observed.

Cells summarise these as `gap.flagged`, `gap.evidenceInGap` and
`gap.possiblyStale`.

## Journeys

`buildJourney(graph, repository, commitSha)`: seeds are all events carrying
the commit in the repository; a best-path search walks links forward in time
(confidence = weakest link; weak steps shown but not expanded). Rules from
the prototype:

- **Stop rule:** an event of the same repository carrying other commits but
  not this one is a different change. It is listed in `continuesAs` with a
  relation: `merged_as` (a merged PR names both), `included_in` (pushed
  together; the other commit is the push head) or `later_commit`.
- **Exclusion rule:** a placement whose content traces to something else
  (e.g. a sync of the right config revision running an overridden image) is
  listed in `excluded` with the reason, not followed.
- **Environments:** placements attributed to the commit (`via: attribution`,
  with the attribution confidence), syncing it as config revision
  (`config_revision`), unattributed placements reached through links
  (`reached`) and, on request, **commit containment** (`containment`, below).
- Bounded by `maxSteps` (default 300 in the API); `truncated` says so.

### Commit containment (AFE-22) hook

`GET /api/journeys?…&include=containment` asks AFE-22's
`containmentService(ctx).isContained(tenant, repo, commit, liveCommit)` for
each current placement of the same repository whose (non-weak) live app
commit is a different, later one (at most 5 per request, 5 s each). When the
live commit includes this one, the environment is added with `via:
"containment"` and the live attribution's confidence; every check is listed
in `journey.containment` (`contained: true | false | "unknown"`, reason).
Live commits here are **app commits attributed through images** where
possible, so GitOps environments work too (AFE-22 alone compares the GitOps
config revision). The hook is an option:
`createCorrelationModule({ containment: (ctx) => hook })`; the core functions
are `containmentCandidates` and `applyContainment`.

## For the UI and later issues

- AFE-24 (environment matrix): `GET /api/environments/state` gives rows,
  columns (ordered), cells with `live`, `status`, `confidence`, `gap`,
  `consistent`, targets and `historyUrl`; never show confidence without
  `commits[].via` / `notes`.
- AFE-25 (journey UI): `stages` gives column order and membership, `edges`
  the arrows (style by confidence), `environments`, `excluded`,
  `continuesAs`; every step carries an event summary. Implemented in
  `apps/web/src/pages/Journey.tsx` at `/journeys?repository=owner/name&commit=<sha>`
  (`view=diagram|list|placements`, `containment=1`); edges show the path
  confidence of the step they lead to, evidence on hover/focus. The timeline
  highlights a journey with `/events?journey=owner/name@<sha>`.
- AFE-26 (drift): placements with `attribution.status` `unknown` or `guess`,
  `notes` (e.g. "was not produced by any observed build"), `kind: manual`,
  inconsistent cells and `tag_digest_mismatch` conflicts are the raw
  findings.

## Known limits and follow-ups

- Service identity comes only from the mapping; unmapped targets are shown,
  not grouped by guess (the core's `service` field is a display fallback).
- The first request after a restart pays the cold load (≈ 0.8 s at 23k, 3.3 s
  at 89k events). A start-up warm-up is a possible follow-up.
- Multi-image placements with unpaired `imageDigests` are attributed per image
  only when refs are digest-pinned (connector rule from AFE-18).
- Helm chart revisions (no commit) are not linked (research gap, out of scope).
- Numbers above are from synthetic data; re-measure on real tenants
  (research 0001, "Re-run on real data").

## To verify against docs

Nothing new beyond the connector docs: correlation reads only canonical
events. The field assumptions it depends on are listed in
[research 0001](research/0001-cross-tool-flow.md#to-verify-against-docs)
(GitHub `registry_package` and attestations, ArgoCD `summary.images`, Vercel
`aliasAssigned` after an instant rollback).
