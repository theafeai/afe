# Environment and service mapping

Issue: AFE-19. Code: `@afe/core/mapping` (model, resolver, safe regex),
`@afe/db` `mapping.ts` (migration `0019_environment_mapping.sql`),
`apps/server/src/mapping/` (API, audit, job), `apps/web/src/pages/Mapping.tsx`
(Settings → Mapping). API: [api.md](api.md#environment-and-service-mapping).

## Why

Every tool names environments its own way: GitHub has `production` and
`Production – web` (the Vercel GitHub integration), ArgoCD has application
names, projects, destination namespaces and clusters, and labels; Vercel has
targets `production` / `preview` and custom environments. The environment
matrix (research doc [0001](research/0001-cross-tool-flow.md), gap
"Environment names differ per tool") needs one set of **services** (rows) and
**environments** (columns) per tenant, and so does correlation.

## Model

- `Service {id, name, description?}`: id is a slug (`^[a-z0-9][a-z0-9_-]{0,63}$`).
- `Environment {id, name, order, kind, productionLike}`: `order` is the matrix
  column position; `productionLike` (ADR 0019) gives the heavy chip;
  `kind` (`production | staging | preview | development | other`) is legacy,
  kept for compatibility. For an inferred environment it is never derived from
  the name (AFE-117): `production` when production-like, `preview` for a
  short-lived family, else `other`. The UI shows no kind, only the
  production-like chip (ADR 0017 rule 9).
- `MappingRule {id, kind, field, match, pattern, caseSensitive, priority,
targetId, enabled, note?}`: `kind: service` rules assign a service,
  `kind: environment` rules an environment. The two rule sets are
  independent.

### Fields (what each tool emits)

| Field                | Read from the canonical event                                                         |
| -------------------- | ------------------------------------------------------------------------------------- |
| `github.environment` | `target.environment` (deployment environment name) or `correlation.environments[0]`   |
| `github.repository`  | `target.repository` (`owner/name`)                                                    |
| `argocd.application` | `target.application`                                                                  |
| `argocd.project`     | `target.project` (AppProject)                                                         |
| `argocd.namespace`   | `target.namespace` (destination namespace)                                            |
| `argocd.cluster`     | `target.cluster` (destination name or server URL)                                     |
| `argocd.environment` | `target.environment` (connector: label `afe.dev/environment`, `environment` or `env`) |
| `argocd.repository`  | `target.repository` (source repo URL)                                                 |
| `argocd.label:<key>` | the application's `metadata.labels[<key>]`, read from the stored raw payload          |
| `vercel.project`     | `target.project` (project id), `data.projectName`, `target.name`                      |
| `vercel.target`      | `target.environment`: `production`, `preview` or the custom environment slug          |
| `vercel.repository`  | `target.repository`                                                                   |

A field can have several values; a rule matches when any of them matches.
Events do not carry ArgoCD labels, so label rules make the server read the
raw payloads of the ArgoCD events being resolved (one query per page, bodies
over 1 MiB skipped). Label rules therefore cost more than the others.

## Resolution

`resolvePlacement(event, compiledMapping) → {serviceId, environmentId,
matchedRuleIds, confidence, service, environment}` (pure, in core).

- **Read time only.** The result is never written into events: the log is
  immutable and mapping changes must apply to history. `GET /api/deployments`
  adds `placement` per row; the matrix (AFE-20) and correlation call the same
  resolver (`ctx.mapping.placements(tenantId, events)` on the server).
- **Precedence**, per dimension: the tenant's enabled rules by ascending
  `priority` (ties by id), then the enabled built-in rules in their fixed
  order, then the inferred rules (`inferred:*`). The first rule with a matching value wins. A rule whose target does
  not exist (or whose pattern no longer compiles) is inactive and reported
  (`inactiveReason` in `GET /api/mapping`, `inactive` in the preview).
- **Unmapped is explicit.** No match → `null`, listed in `unmapped`, shown in
  the UI as "unmapped service/environment". Nothing is guessed. `confidence`:
  `configured` (both by tenant rules), `default` (both mapped, one by a
  built-in or inferred rule), `partial` (one unmapped), `unmapped`.
- **Fast.** `compileMapping` compiles every pattern once per configuration
  (the server caches it per tenant and revision) and caches results per
  distinct set of raw values (bounded, 10 000 entries), so a page of
  thousands of events costs a few map lookups each (tested: 5 000 events with
  200 regex rules well under a second).

### Matching

- `exact`: whole value, case-insensitive unless `caseSensitive`.
- `glob`: `*` (any run, including `/`) and `?` (one character), whole value.
  Matched iteratively, never via `RegExp`: O(value × pattern).
- `regex`: a search like `RegExp.test` (anchor with `^…$`), case-insensitive
  unless `caseSensitive`.

**Regex safety.** JavaScript's `RegExp` backtracks; `(a+)+$` or even
`a*a*a*a*b` take exponential or high-polynomial time on some inputs, and a
rule runs on every event read. Blacklisting "catastrophic constructs" is
unreliable, and a native RE2 binding would add a compiled dependency to a
self-hosted image. Instead patterns are parsed into a restricted, RE2-like
syntax and executed by a small Thompson-NFA (Pike VM) in
`packages/core/src/mapping/safe-regex.ts`: time is O(value length × program
size) for every pattern. Bounds: pattern ≤ 256 characters, program ≤ 4 000
instructions (so `{n,m}` expansion cannot explode), repeat counts ≤ 100,
values truncated to 1 024 characters. Supported: literals, `.`, classes,
`\d \w \s` (and negations), `\b \B`, `^ $`, groups `( )` / `(?: )`, `|`,
`* + ? {n} {n,} {n,m}` (lazy suffix accepted). Rejected with a message:
backreferences, lookaround, named groups, `\p{…}`, `\u…`, nested
quantifiers like `a**`, stray `{`. Tests check equivalence with `RegExp` on
the supported syntax and that classic ReDoS patterns run in linear time.

## Built-in rules

No environment is seeded ([ADR 0019](decisions/0019-inferred-environments-and-process.md)): a tenant's environments come from
the [inferred setup](#inferred-setup) plus the ones its admin creates. The
built-in environment rules (`BUILTIN_RULES`, ids `builtin:*`) remain, and are
evaluated after the tenant's rules, but they target the ids `production`,
`staging`, `preview` and `development`, so they only apply where an
environment with that id exists:

- `vercel.target` exactly `production` → production, `preview` → preview;
- on `github.environment`, `argocd.environment`, `vercel.target`: leading
  words `^(prod|production|prd|live)\b` → production,
  `^(stag|stage|staging|stg|uat|preprod|pre-prod)\b` → staging,
  `^(preview|review|pr-\d+)\b` → preview,
  `^(dev|develop|development|test|testing|qa|sandbox)\b` → development
  (so `Production – web` and `prod-eu` are production);
- on `argocd.namespace` and `argocd.application`: suffixes like `-prod`,
  `-staging`, `-dev` → the matching environment.

They fold an org's own names into fixed buckets, so they are **off by
default** for tenants set up since inferred setup
(`mapping_settings.builtin_rules_default = false`; `inactiveReason` "off by
default: environments are inferred"). An admin can still switch any of them
on (`PUT /api/mapping/builtin-rules/:id`). There are no built-in service
rules: services are the tenant's to define.

### Upgrading (migration 0042)

Nothing stored is changed or deleted:

- Tenants that had changed their mapping (a `mapping_settings` row) keep their
  environment rows, which are now admin environments, and keep the built-in
  rules on (`builtin_rules_default = true`). What they see does not change;
  inference only adds environments their rules do not already place, and
  reports disagreements in "Afe noticed".
- Tenants that never changed their mapping used four virtual default
  environments that were never stored. After the upgrade they have none:
  their environments are inferred from the names their tools report (for
  example `Production – web` and Vercel `production` become two
  environments, where before both were "Production"). An admin who wants the
  old buckets creates the environments and switches the built-in rules on,
  or adds rules.
- Until the first inference run (at most ten minutes after start, or
  immediately on `POST /api/setup/infer`, or queued by an admin's first
  `GET /api/setup`) such a tenant's environments are unmapped.

## Inferred setup

Code: `@afe/core/setup` (signals, rules, merge), `@afe/db` `setup.ts`
(migration `0042_inferred_setup.sql`), `apps/server/src/setup/` (job and
API). Decision: [ADR 0019](decisions/0019-inferred-environments-and-process.md)
(Afe infers, the admin adjusts; inference never overwrites the admin; rules
first, no LLM).

### Two stores

| Store             | Written by                                          | Holds                                                                                         |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `inferred_setup`  | the `setup.infer` job only (`replaceInferredSetup`) | per environment and field: value, confidence, one-line reason, evidence, first inferred       |
| `setup_overrides` | admin API calls only (`PATCH /api/setup`, Mapping)  | per environment and field: value, who (`set_by`, `set_by_name`), when, the guess kept against |

Both are keyed `(tenant_id, subject, field)`, subject `environment:<id>`.
Each table refuses `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` unless the
transaction declared its writer (`set_config('afe.setup_writer', 'inference'
| 'admin', true)`, done by the `@afe/db` functions), so the inference job has
no write path to overrides at all. Tests check this, and that the job's
module imports no override writer.

**Effective value** = override ?? the admin's environment row (Mapping page)
?? inferred ?? none. For an admin environment the row's `kind` is the
admin's statement about production (`production` → production-like). An
inferred value is never applied over an admin value: it is shown beside it
(`inferred` on every field) and, when it disagrees with confidence
`probable` or better, listed in "Afe noticed".

### Environments from what tools report

The job reads up to 10 000 of the tenant's newest `deployment.*`,
`argocd.sync.*` and Terraform `terraform.plan.*`, `terraform.apply.*`,
`terraform.destroy.*` events. A per-connector **signal extractor**
(`DEFAULT_SIGNAL_EXTRACTORS`; GitHub, Vercel, Argo CD, Terraform) turns each
into source-neutral signals: environment name as reported, deployment
reached or not, commit, ref, tool-declared production, transient, how it
started, approval waits and protection rules. Adding a connector means adding
an extractor.

Terraform (AFE-116) names the environment the way the reporter connection
does: its configured environment (`terraform.environment`), else its
workspace (`terraform.workspace`); Terraform's `default` workspace names no
environment. An apply is a deployment (reached when it completes
successfully; started and completed reports of one run are one deployment;
how it started comes from the reported trigger: `push`/`schedule` automatic,
`cli`/`manual` on demand, `pull_request` per change). Plans and destroys show
that the environment exists but are not deployments, so they never count
toward order, cadence or process.

Each reported name is first resolved with the admin's own mapping (tenant
rules, enabled built-in rules): if it lands in an admin environment, it is
evidence for that environment. Otherwise it becomes an inferred environment
with the tool's name and the slug as id (`Production – web` →
`production-web`; names from several tools with the same slug merge).
Short-lived names (`pr-42`, `preview/feature-x`, or GitHub
`transient_environment`) collapse into one **family** (`previews`) with a
safe-regex pattern. The names and patterns are stored as `sources` and
become inferred mapping rules (`inferred:*`, evaluated after the built-in
rules), which is how events are placed in inferred environments. At most 50
environments (the mapping limit) are kept, the busiest first.

### Rules (strongest first, each with confidence and evidence)

| Field            | Rule                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order`          | For commits that reached A and B: A first in ≥ 80 % → A < B (strong with ≥ 5 commits, else probable); together within a minute in ≥ 80 % of ≥ 5 → parallel (same position). Otherwise first-seen order (weak); environments with no relation go after the chain. Cycles keep first-seen order                                      |
| `productionLike` | Tool-declared (GitHub `production_environment`, Vercel `production` target): certain > short-lived: false, strong > approval gate and a single deploy branch: strong > name pattern: probable > last in the order: weak                                                                                                            |
| `gating`         | Required reviewers seen (`deployment.review_*`): approval, certain > a protection rule: approval, strong > short-lived: per change, strong > how ≥ 60 % of deployments started (`push` automatic, `workflow_dispatch` on demand, `pull_request` per change): strong for GitHub's own word, else probable, weak under 3 deployments |
| `batching`       | Median commits that reached the upstream environment between two deployments here > 1.5 → batches (strong with ≥ 5 intervals)                                                                                                                                                                                                      |
| `cadence`        | Median and p90 time between deployments (≥ 3 deployments)                                                                                                                                                                                                                                                                          |
| `name`           | The reported name (certain; strong when several spellings merged); a family's name (strong)                                                                                                                                                                                                                                        |

Rules are deterministic (same events, same facts, in any order) and run in
the deployment: no LLM, no data leaves it. Evidence holds tool names,
environment names, counts and rule names only, never repository names,
logins or commit messages. Not inferred yet: GitHub Environments' own
protection settings (not fetched; only what deployments and reviews show),
and order disagreements are not reported.

### When it runs

Job `setup.infer`: every ten minutes for every tenant with events, one tenant
at a time; on demand for one tenant (`POST /api/setup/infer`, and an admin's
first `GET /api/setup` of a tenant that has never been inferred; viewers'
reads never queue a run). Each run replaces
the tenant's facts atomically; facts of environments that no longer appear
in the retained events are deleted, so inferred data never outlives the
events it came from.

### Afe noticed

Reported, never applied:

- `disagreement`: an admin value (override or admin row) differs from a
  `probable` or stronger guess for `productionLike`, `gating` or `batching`.
  Actions: keep (stores the guess in `kept_inferred`; the notice returns only
  if the guess changes) or use Afe's guess (clears the override).
- `new_environment`: an inferred environment first seen after the admin
  first adjusted the setup (created an environment or set an override), with
  no decision yet. Actions: add (`included: true`) or not an environment
  (`included: false`: it leaves the mapping and its events become unmapped).

### Mapping page interplay

The existing Mapping page keeps working on the effective environments:
editing or targeting an inferred environment with a rule makes it an admin
environment (a row; an admin creating an environment is an override) and
clears name/order overrides, so the newest admin edit wins; deleting an
inferred environment sets `included: false`; deleting an admin environment
also clears its overrides.

## Storage and audit

Migration `0019_environment_mapping.sql`: `mapping_settings` (revision per
tenant), `mapping_services`, `mapping_environments`, `mapping_rules`
(foreign keys to the tenant's service/environment; deleting a referenced
target answers 409), `mapping_builtin_rule_overrides`, `mapping_audit_outbox`.
All tenant-scoped; every repository function takes the tenant id.

Every change runs in one transaction that locks the tenant's settings row,
bumps `revision`, applies the change and writes a `config.mapping.changed`
event (source `afe`, `sourceEventId` `config_mapping:<revision>`) to the
outbox. After commit the server appends it via `ctx.sink` and deletes the
outbox row; if that fails, the `mapping.audit-outbox` job (every minute)
retries. Ingestion is idempotent, so a retry never duplicates. The event
records who (the authenticated principal: a user, or `static:admin`
"Administrator" for the bootstrap admin token, never a token fingerprint), and in
`data`: `revision`, `entity` (`service | environment | rule | builtin_rule |
rule_order | setup`), `operation`, `id`, `before` and `after` summaries. That
is how the audit log shows who changed how deployments are classified. Setup
override changes (`PATCH /api/setup`) are mapping changes too: one event per
request, `before`/`after` listing each changed field. Inference runs are not
changes and write no event.

## UI

Settings → **Mapping** (`/settings/mapping`): services and environments
(add, delete, move columns), service and environment rule tables (add, edit,
delete, move up/down), the rule form with a live preview (debounced
`POST /api/mapping/preview` with the draft in place: how many recent
deployments would change, and how), built-in defaults with on/off switches,
unmapped values with "Create rule" (pre-fills the form), and how recent
deployments classify now. The Deployments page shows the resolved
service · environment under "Where". The page lists the effective
environments (inferred ones included); its hint "Built-in defaults; your first
change makes them your own" is out of date until the web UI is updated (the
Adjust screen for the setup API comes later).

## Integration and follow-ups

- `GET /api/deployments` returns `placement` (additive). The events module
  only calls `ctx.mapping.placements` when the mapping module is registered.
- The environment matrix (AFE-20) and correlation should use
  `ctx.mapping.placements` / `compileMapping` + `resolvePlacement` instead of
  `placementSlot`'s raw `environment` string (left unchanged here).
- Viewers see the editing controls but the server answers 403 on save; the
  page could hide them for viewers.
- No external API is involved; nothing needs verification against tool docs
  beyond the connector field mappings above (the ArgoCD raw payload shape
  `{application: {metadata: {labels}}}` is the connector's own minimised form).
