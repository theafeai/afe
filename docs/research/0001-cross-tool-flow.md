# Research 0001: Correlating and visualising flow across GitHub, ArgoCD and Vercel

- Issue: AFE-15
- Status: Recommendation (input to the UI work after AFE-16; not an ADR)
- Date: 2026-10-26
- Code: `packages/core/src/correlation/` (prototype, `@afe/core/correlation`),
  `docs/research/prototypes/` (synthetic dataset, generator, three HTML prototypes)

> **All data in this research is synthetic.** No real repository, ArgoCD
> instance or Vercel team was reachable while writing it. The dataset is
> modelled on the payload shapes in the official docs (see
> [To verify against docs](#to-verify-against-docs)). Every conclusion
> marked _(re-run)_ should be checked on real data; see
> [Re-run on real data](#re-run-on-real-data).

## Summary

1. **Link with typed evidence and four confidence levels.** A link between
   two events always says _why_ (`same_commit_same_repo`, `same_image_digest`,
   `same_image_tag`, `time_proximity`, ...) and _how sure_ (`certain`,
   `strong`, `probable`, `weak`). Confidence is never shown without the
   evidence behind it.
2. **Two different questions need two different models.** Store links as a
   graph (internal), and derive from it:
   - an **environment view**, "what is live where and how did it get there", and
   - a **per-commit journey**, "where did this change go".
3. **v1 UI after AFE-16: an environment matrix as the landing view, with a
   per-commit journey as the drill-down.** The unified timeline stays as
   the raw audit view (what AFE-16 shows anyway) with a "highlight this
   journey" filter. A general dependency graph is not worth building: it is
   unreadable past a handful of events and answers no question the other
   two do not.
4. **GitOps has two revisions, and they must not be confused.** An ArgoCD sync
   deploys a _config_ repository commit; the _app_ commit running is known
   only through the image. Attributing a sync to an app commit via the config
   commit (or its message) gives confidently wrong answers as soon as someone
   overrides an image (scenario c). Attribute through images, by digest when
   possible.
5. **The biggest gap is the artifact.** Nothing in today's GitHub, ArgoCD or
   Vercel events says "image X (digest D) was built from commit C by run R".
   Without it, GitOps flows link only by tag-naming convention (probable). We
   recommend a new `artifact.published` event from the GitHub connector
   (`registry_package` webhook + build provenance attestation or OCI labels).
6. Connectors must fill a few more `correlation` keys and three proposed new
   ones (`upstreamCommitShas`, `deploymentUrls`, digest-pinned `imageRefs`);
   see [What the connectors must capture](#what-the-connectors-must-capture).

## Method and dataset

`docs/research/prototypes/synthetic-dataset.ts` builds 68 canonical events
(validated with `parseEventInput`) for four scenarios, with the abbreviated
source payload each one maps from kept in `rawPayload`:

| Scenario                | What happens                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) GitOps              | `acme/shop` push → Actions run builds `ghcr.io/acme/shop-api:<sha>` → bot bumps the separate `acme/shop-deploy` repo → ArgoCD auto-syncs staging. A human PR promotes to production and pins the digest. A second commit reaches staging only; a third fails CI. |
| (b) Vercel              | `acme/web`: preview per PR, merge to main → production, instant rollback, a build that is _not_ assigned the domains because of the rollback, promote, redeploy, GitHub deployments created by the Vercel app.                                                   |
| (c) Manual, no Git link | `argocd app set --kustomize-image ...:hotfix-1022` + `argocd app sync` (same config revision, different image); `vercel deploy --prod` from a laptop without Git metadata.                                                                                       |
| (d) Mutable tag         | `ghcr.io/acme/worker:1.4` built from tag `v1.4.0`, later rebuilt from a backport commit with the same tag; staging pins the new digest, production is restarted on the tag.                                                                                      |

`docs/research/prototypes/generate.ts` runs the correlation prototype over it
and embeds the result into three standalone HTML prototypes
(`pnpm exec tsx docs/research/prototypes/generate.ts`; open the files
directly in a browser):

- [`timeline.html`](prototypes/timeline.html): unified timeline, lanes per tool, select a commit to highlight its journey; click an event for its keys and links.
- [`journey.html`](prototypes/journey.html): per-commit flow diagram (columns change → CI → artifact → config → deploy → runtime), edge style by confidence, "where it went", excluded steps and "continues as".
- [`environments.html`](prototypes/environments.html): service × environment matrix of what is live, with confidence, and per-cell history.

`packages/core/test/correlation-dataset.test.ts` pins the findings below so
the doc and code cannot drift apart.

## Linking

### Identifiers per tool

"Link" is the confidence the identifier gives when two events share it.
_(re-run)_: which fields are actually populated in practice.

| Identifier (correlation key)                       | GitHub                                                                                                     | ArgoCD                                                                                                      | Vercel                                                                  | Link                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Commit SHA + repo (`commitShas`, `repositories`)   | push `after`, `commits[].id`; `workflow_run.head_sha`; `deployment.sha`; PR `merge_commit_sha`, `head.sha` | `operationState.syncResult.revision`, `status.sync.revision`, `history[].revision` — of the **config** repo | `meta.githubCommitSha` (+ `githubCommitOrg/Repo`), REST `gitSource.sha` | **certain** for the same repo; **strong** across repos (fork/mirror)                             |
| Deployment id (`deploymentIds`)                    | `deployment.id`                                                                                            | `argocd:<ns>/<app>:<history id>`                                                                            | `dpl_…`                                                                 | **certain**, but only within one tool                                                            |
| CI run id (`runIds`)                               | `workflow_run.id`; `deployment.workflow_run.id` (to verify); attestation `invocationId`                    | –                                                                                                           | –                                                                       | **certain**                                                                                      |
| Image digest (`imageDigests`)                      | `registry_package` version / attestation subject (needs new event)                                         | `summary.images` only when manifests pin `@sha256:`; pods' `imageID` via resource tree                      | –                                                                       | **strong** (content-addressed; "strong" not "certain" because identical rebuilds share a digest) |
| Image tag (`imageRefs`)                            | `registry_package` tag (new event)                                                                         | `summary.images`, `spec.source.kustomize.images`, Helm parameters                                           | –                                                                       | **probable** if one build produced it; **weak** if several did (mutable tag)                     |
| Tag that names a commit (`:<sha>`, `:sha-<short>`) | –                                                                                                          | `summary.images`                                                                                            | –                                                                       | **probable** (convention)                                                                        |
| Commit/digest mentioned in a config commit         | push `head_commit.message`, PR body (extract SHAs only)                                                    | –                                                                                                           | –                                                                       | **probable** (convention; proposed `upstreamCommitShas`)                                         |
| Deployment URL                                     | `deployment_status.target_url` / `environment_url`                                                         | –                                                                                                           | `deployment.url`                                                        | **strong** (proposed `deploymentUrls`)                                                           |
| Ref / branch (`refs`)                              | `ref`, `head_branch`                                                                                       | `spec.source.targetRevision` (often `HEAD`/`main`)                                                          | `meta.githubCommitRef`                                                  | grouping only, never a link (many commits share a branch)                                        |
| Pull request (`pullRequests`)                      | `pull_request.number`, `workflow_run.pull_requests[]`                                                      | –                                                                                                           | `meta.githubPrId`                                                       | grouping only (a PR has many commits and previews)                                               |
| Environment name (`environments`)                  | `deployment.environment` (Vercel's app uses `Preview – <project>` / `Production – <project>`, to verify)   | none native: label/annotation or app naming convention                                                      | `target` (`production`/`preview`, custom environments)                  | **weak** at best; names differ per tool and need a mapping                                       |
| Time + place                                       | –                                                                                                          | –                                                                                                           | –                                                                       | **weak**, only for events with no identifier at all                                              |

### Confidence levels

| Level      | Meaning                                                               | Examples                                                                                |
| ---------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `certain`  | Same immutable identifier for the same object.                        | Same commit SHA in the same repo; same deployment id; same run id.                      |
| `strong`   | Content-addressed or unique identifier; wrong only in unusual setups. | Same image digest; same SHA via a mirror; same deployment URL.                          |
| `probable` | A convention or a mutable name.                                       | Tag match with one producer; tag that is a SHA; SHA mentioned in a bump commit message. |
| `weak`     | A guess.                                                              | Mutable tag with several producers; nearest earlier push to the same repo within 6 h.   |

A path's confidence is its weakest link. Weak steps are shown but not
followed further (a guess must not lead to more guesses). Contradictions are
reported, not linked: same tag with different digests yields a
`tag_digest_mismatch` conflict.

### Showing confidence

In the prototypes, and recommended for the UI:

- Edge style: solid for certain/strong, dashed for probable, dotted for
  weak. Badge colour plus the word (never colour alone).
- Every badge expands to its evidence in plain words ("tag
  `worker:1.4` was produced by 2 builds from 2 commits").
- Unknown is a first-class state: "no app commit; image
  `shop-api:hotfix-1022` was not produced by any observed build" rather than
  an empty cell or a guess.
- Ambiguity is explicit: two candidate commits listed, marked _ambiguous_.

## Model

| Model                   | Answers                                         | Verdict                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph of related events | anything, in principle                          | Right **internal** representation (links + evidence). As a UI it is unreadable: 68 events produced 169 links.                                                                                                                             |
| Per-change journey      | "where did my commit go, and is it live?"       | Good drill-down. Needs a stop rule (do not walk into a different commit of the same repo) and an exclusion rule (a sync of the right config revision running a different image is not part of the journey). Root = head commit of a push. |
| Environment view        | "what is live where, how did it get there, who" | Best landing view for an audit tool: it is the question asked during incidents and audits, and it is where uncertainty matters most.                                                                                                      |

**Recommendation:** links graph as the stored/derived model; environment
state and journeys as the two derived read models. The prototype computes all
three from events in memory (`buildLinks` → `deriveEnvironmentStates` →
`buildJourneys`).

Key modelling decisions the prototype validated:

- **Placement** = an event after which something new is live: ArgoCD
  `argocd.sync.succeeded`; Vercel/GitHub `deployment.status_updated`
  succeeded _and the production domains were assigned_; `deployment.promoted`;
  `deployment.rolled_back`. "Build succeeded" is not "live": after a Vercel
  instant rollback, new production builds are not assigned the domains until
  promoted (scenario b).
- **Content attribution**: if a placement names images, its app commit comes
  from the image (digest → strong, single-producer tag → probable,
  multi-producer tag → weak, tag that is a SHA → probable); otherwise from the
  deployment's own commit (certain); otherwise (no Git metadata) only a weak
  time-proximity guess. ArgoCD also records the config revision separately.
- **Builds are time-bound**: a tag is matched only against builds that
  existed when the deployment happened, so the first production sync of
  `worker:1.4` stays probable while the restart after the rebuild becomes weak
  and ambiguous.
- **Service identity across environments** is not provided by any tool. The
  prototype groups by image name, else Vercel project, else repository. Real
  use needs configuration (follow-up 8).

What the prototype produced on the synthetic data:

| Environment                | Live now                                     | Attribution                                                                                        |
| -------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| shop-api staging (Argo)    | `shop-api:<B>`                               | B, probable (tag match; no digest in Argo)                                                         |
| shop-api production (Argo) | `shop-api:hotfix-1022`, manual sync by alice | **unknown**; config revision C2 certain; A's journey excludes this sync                            |
| worker staging (Argo)      | `worker:1.4@DW2`                             | W2, strong (digest)                                                                                |
| worker production (Argo)   | `worker:1.4`, manual restart                 | W or W2, weak each, ambiguous (tag rebuilt); earlier sync was W, probable                          |
| web production (Vercel)    | `dpl_cli1` from `vercel deploy --prod`       | M4, weak guess ("nearest earlier push, 102 min before"); rollback/promote/redeploy history certain |
| web preview (Vercel)       | `dpl_p1`                                     | P1, certain; P1's journey "continues as" merge commit M1                                           |

## Visualisation candidates

| Candidate                  | Prototype           | Findings                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified timeline           | `timeline.html`     | Complete and honest (it is the log), easy to build, needed anyway. Interleaved tools make a single flow hard to follow until a journey is highlighted; then it works well. Does not answer "what is live".                                                                                                      |
| Per-commit journey diagram | `journey.html`      | Clearest for one change; confidence on edges is legible. Columns by stage work for GitOps (change → CI → artifact → config → deploy → runtime). Needs "excluded" and "continues as" lists to be honest. Breaks down for long-lived commits with many deploys (W): a list of placements reads better there.      |
| Environment matrix         | `environments.html` | Answers the audit/incident question at a glance; surfaces uncertainty (unknown, ambiguous, weak) exactly where it matters. Per-cell history ("how it got here") covers rollback/promotion/manual steps well. Needs service and environment mapping (GitHub's `Production – web` shows as a separate row today). |
| Dependency graph           | not built           | The link graph rendered generically (169 edges for 68 events) is noise; journeys are the readable projection of it.                                                                                                                                                                                             |

**v1 after AFE-16:** environment matrix (landing) → click a cell → history of
placements → click a placement → per-commit journey. Keep the unified
timeline as the event log with a "highlight journey" filter.

## Gaps

| Gap                                                     | Effect in the data                                                               | Mitigation                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| No artifact event (image ↔ commit ↔ run)                | GitOps links only via tag conventions                                            | `artifact.published` from `registry_package` + attestations / OCI `org.opencontainers.image.revision` (follow-up 2)              |
| Config repo separate from app repo                      | Config commit links to app commit only by message convention (probable)          | Attribute via images instead; extract SHAs from bump messages as `upstreamCommitShas`; recommend digest pinning in bump tooling. |
| Manual ArgoCD parameter/image override                  | Sync carries a correct config revision but runs an untracked image               | Capture `spec.source.kustomize.images` / Helm parameters on `argocd.application.updated`; show "drift from Git" (follow-up 9).   |
| Mutable tags (`:1.4`, `:latest`)                        | Ambiguous attribution; digest unknown at the Argo side                           | Read running pod `imageID` digests via the ArgoCD resource tree; recommend digest pinning.                                       |
| Deploys without Git metadata (`vercel deploy` from CLI) | Only a weak time guess                                                           | Show as "untracked deploy"; capture Vercel `source: cli` and `meta.gitDirty` when present.                                       |
| Commit containment (ancestry)                           | P1's content went live inside merge M1, but P1's journey stops at "merged as M1" | "continues as" links today; GitHub compare API for "is X included in what is live" (follow-up 10).                               |
| Environment names differ per tool                       | `production`, `Production – web`, Argo app names                                 | Environment/service mapping config (follow-up 8).                                                                                |
| Helm chart sources                                      | Argo revision is a chart version, not a commit                                   | Add chart name+version as a key when needed (out of scope for v1).                                                               |
| Multi-source ArgoCD apps                                | `status.sync.revisions[]` and several repos                                      | Connector must emit every revision with its repository.                                                                          |
| Missed events                                           | A missing webhook breaks a chain silently                                        | Show observation gaps (AFE-4) on the timeline and matrix cells whose evidence falls in a gap.                                    |

## What the connectors must capture

Rules for all connectors: set every key you know on every event (not only
"main" events); repositories via `repositoryKey()`; full SHAs only; keep
commit message text out of the event (R8): extract identifiers only.

### Schema additions (core, follow-up 1) — done (AFE-18)

Additive changes to `correlationSchema` (no schema version bump), implemented
in AFE-18; connectors now write the new keys and the prototype reads them,
falling back to `data.correlationHints` for events stored earlier:

- `upstreamCommitShas: string[]`: full SHAs a change refers to in _another_
  repository (GitOps bump commit messages, PR bodies, Renovate/Argo Image
  Updater commit trailers). Legacy location: `data.correlationHints.mentionedCommitShas`.
- `deploymentUrls: string[]`: lower-case hosts of deployment URLs (Vercel
  `url`, GitHub `deployment_status.target_url` / `environment_url`). Prototype
  reads them (and the legacy `data.correlationHints.deploymentUrls`).
- `imageRefs` documented to allow the digest-pinned form
  `registry/repo:tag@sha256:<hex>` so a digest stays paired with its image
  when an event has several images (today `imageRefs` and `imageDigests` are
  unpaired lists).
- New action `artifact.published` (source `github`): an image was pushed.
- Placement hint `data.aliasAssigned` (Vercel) is used by the prototype; it
  could stay in `data`.

### GitHub connector

| Event                             | `correlation`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| push (`ref.pushed`/`ref.created`) | `commitShas` = `commits[].id` + `after`; `refs` = `ref`; `repositories`; `upstreamCommitShas` = full SHAs found in `commits[].message`; `data.headCommit` = `after`.                                                                                                                                                                                                                                                              |
| `workflow_run.*`                  | `commitShas` = `head_sha`; `refs` from `head_branch`; `repositories` (and `head_repository` for forks); `runIds` = `github:<id>`; `pullRequests` from `pull_requests[]`.                                                                                                                                                                                                                                                          |
| `workflow_job.completed`          | as run, plus `environments` when the job has `environment:`.                                                                                                                                                                                                                                                                                                                                                                      |
| `deployment.*`                    | `commitShas` = `deployment.sha`; `refs`; `environments` = `deployment.environment`; `deploymentIds` = `github:<id>`; `runIds` from `deployment.workflow_run.id` when present; `deploymentUrls` from status `target_url`/`environment_url`.                                                                                                                                                                                        |
| `pull_request.merged`             | `commitShas` = `merge_commit_sha` + `head.sha`; `pullRequests`; `upstreamCommitShas` from the PR body.                                                                                                                                                                                                                                                                                                                            |
| new `artifact.published`          | from `registry_package` (`published`): `imageRefs` (`<registry>/<owner>/<name>:<tag>` for each tag), `imageDigests`; and from the attestation for that digest (`GET /repos/{owner}/{repo}/attestations/{digest}`): `commitShas` (`resolvedDependencies[].digest.gitCommit`), `runIds` (`runDetails.metadata.invocationId`), `repositories`. Fallback: OCI labels `org.opencontainers.image.revision`/`.source` from the registry. |

### ArgoCD connector

| Event                        | `correlation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argocd.sync.*`              | `commitShas` = `operationState.syncResult.revision` (all `revisions[]` for multi-source); `repositories` = `repositoryKey(spec.source.repoURL)` (all sources); `deploymentIds` = `argocd:<ns>/<app>:<history id>` on finish; `environments` from the configured mapping (label/annotation); `imageRefs` = `status.summary.images` (keep `@sha256:` when present); `imageDigests` from those or from pod `imageID`s in the resource tree. Trigger from `operation.initiatedBy` (`automated` → `auto_sync`, `username` → `manual`/`cli`). |
| `argocd.application.updated` | the changed overrides: `imageRefs` from `spec.source.kustomize.images`, Helm `parameters`/`valuesObject` image fields; `data.change` naming the field.                                                                                                                                                                                                                                                                                                                                                                                  |
| `argocd.health.changed`      | same `commitShas`/`repositories`/`environments` as the current sync, so runtime state joins the journey.                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Vercel connector

| Event                                   | `correlation`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.created` / `status_updated` | `commitShas` = `meta.githubCommitSha` (or `gitSource.sha`; GitLab/Bitbucket equivalents); `refs` from `meta.githubCommitRef`; `repositories` from `githubCommitOrg/Repo` or the project's Git link; `pullRequests` from `githubPrId`; `environments` = `target` (or custom environment); `deploymentIds` = `vercel:<dpl id>`; `deploymentUrls` = `url`; `data.aliasAssigned`, trigger from deployment `source` (`git`, `cli`, `redeploy`, ...). |
| `deployment.promoted` / `rolled_back`   | `deploymentIds` of the deployment made live, plus its `commitShas` by reading the deployment (`GET /v13/deployments/{id}`).                                                                                                                                                                                                                                                                                                                     |
| reconciliation                          | poll the project's current production deployment so a rollback/promotion missed by webhook still produces a placement.                                                                                                                                                                                                                                                                                                                          |

## To verify against docs

Doc URLs relied on: [GitHub webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
[GitHub attestations REST](https://docs.github.com/en/rest/users/attestations),
[Argo CD Application spec](https://argo-cd.readthedocs.io/en/stable/user-guide/application-specification/),
[Argo CD API](https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/),
[Vercel webhooks](https://vercel.com/docs/webhooks/webhooks-api),
[Vercel deployments REST](https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-a-deployment-by-id-or-url),
[Vercel instant rollback](https://vercel.com/docs/instant-rollback),
[OCI annotations](https://github.com/opencontainers/image-spec/blob/main/annotations.md).

1. GitHub `deployment` webhook includes `workflow_run` for deployments created by Actions jobs.
2. `registry_package` webhook fields for container tags and digests (`package_version.container_metadata.tag`), and whether it fires for every tag push.
3. Attestations endpoint path, auth (read-only), and the SLSA predicate field names.
4. Environment names used by the Vercel GitHub app (`Preview – <project>` / `Production – <project>`).
5. ArgoCD `status.summary.images` contents when manifests pin digests; resource tree `images` / pod `imageID` availability with read-only RBAC.
6. Vercel webhook events for instant rollback and promotion (`deployment.promoted`; is there a rollback event?) and project fields that expose the current production deployment.
7. Vercel deployment `source` values and `aliasAssigned` semantics after an instant rollback.
8. Vercel CLI Git metadata (`gitDirty`, commit SHA) when run inside a checkout.

## Re-run on real data

Replace `loadSyntheticEvents()` in `generate.ts` with events exported from
Afe once the connectors exist, then check:

- fill rate of each correlation key per source and action (the identifier table);
- share of placements attributed `certain`/`strong`/`probable`/`weak`/unknown, per repo;
- how often tags are mutable (multi-producer) and how often Argo exposes digests;
- whether the 6 h `time_proximity` window produces wrong guesses (compare with
  CLI deploys whose author can confirm);
- journey sizes (steps per commit) and link counts per event, to size storage
  for a derived links table;
- naming of environments and services across tools (input to follow-up 8).

## Prototype code

`@afe/core/correlation` (pure, no I/O, tested in
`packages/core/test/correlation*.test.ts`):

- `buildLinks(events, { proximityWindowMs })` → `{ links, conflicts }`; each
  `Link` has `from` (earlier), `to`, `confidence`, `evidence[]` (`kind`,
  `confidence`, `key`, `detail`). Evidence kinds and base confidence:
  `EVIDENCE_CONFIDENCE`.
- `deriveEnvironmentStates(events, links)` → per environment slot: `current`
  and `history` placements with `commits` (attribution + confidence + `via`),
  `images` (candidate builds), `configRevision`, `notes`.
- `buildJourneys(events, links, environments)` → per pushed head commit:
  `steps` (stage, confidence, reached-from, evidence), `environments`,
  `excluded`, `relatedJourneys`.

Known prototype limits: pairwise linking inside each key bucket (fine for a
prototype, quadratic for hot keys such as a busy repository's environment);
digest conflict detection assumes one image per event; everything is
recomputed from scratch.

## Proposed follow-up issues

1. **(Done, AFE-18) Core: correlation keys for cross-tool linking.** Add `upstreamCommitShas`
   and `deploymentUrls` to `correlationSchema`, document the digest-pinned
   `imageRefs` form, add `artifact.published` to `ACTIONS`. Additive; update
   docs/event-model.md.
2. **GitHub connector: artifact events.** Ingest `registry_package` and look up
   build provenance attestations (fallback OCI labels) to emit
   `artifact.published` with image tag, digest, commit and run id. Read-only
   permissions only.
3. **GitHub connector: fill all correlation keys.** Per the table above,
   including SHAs extracted from push/PR messages (no message text stored)
   and deployment status URLs. Add fixture tests per event type.
4. **ArgoCD connector: images, revisions and overrides.** Emit
   `summary.images` (with digests when pinned), all multi-source revisions,
   history ids, and image overrides on `argocd.application.updated`; optional
   pod digest lookup via resource tree.
5. **Vercel connector: placement fidelity.** Capture Git meta, `source`,
   `aliasAssigned`, deployment URL; enrich promote/rollback events with the
   deployment's commit; reconcile the project's current production deployment.
6. **Correlation service (server).** Productionise the prototype: derived,
   rebuildable `event_links` (tenant-scoped, not part of the hash chain) or
   compute-on-read for a time window; API for environment state and journeys
   on top of the AFE-14 query API. Decide incremental vs batch after measuring.
7. **UI: environment matrix (v1 landing view).** Service × environment
   matrix with confidence badges, unknown/ambiguous states and per-cell
   placement history, after AFE-16.
8. **Environment and service mapping.** Per-tenant configuration that maps
   tool environment names (`Production – web`, Argo app labels, Vercel
   targets) to one environment, and Argo apps / Vercel projects / repos to a
   service. Used by the matrix rows/columns.
9. **Drift and untracked deploy detection.** Flag placements whose content
   does not trace to Git (manual image overrides, CLI deploys without Git
   metadata, unknown images) as findings/alerts, with evidence.
10. **Commit containment.** Use the GitHub compare API to answer "is commit X
    included in what is live in env Y", so PR head commits and older commits
    show where their content went.
11. **UI: commit journey drill-down.** Stage-column journey with confidence on
    edges, "where it went", excluded steps and "continues as", linked from the
    matrix and the timeline.
12. **Re-run AFE-15 on real data.** Once connectors ingest a dogfood setup,
    run the generator on exported events, review the
    [Re-run on real data](#re-run-on-real-data) checks and update this doc.
