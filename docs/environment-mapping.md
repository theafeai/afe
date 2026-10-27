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
- `Environment {id, name, order, kind}`: `order` is the matrix column
  position; `kind` is `production | staging | preview | development | other`.
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
  order. The first rule with a matching value wins. A rule whose target does
  not exist (or whose pattern no longer compiles) is inactive and reported
  (`inactiveReason` in `GET /api/mapping`, `inactive` in the preview).
- **Unmapped is explicit.** No match → `null`, listed in `unmapped`, shown in
  the UI as "unmapped service/environment". Nothing is guessed. `confidence`:
  `configured` (both by tenant rules), `default` (both mapped, one by a
  built-in), `partial` (one unmapped), `unmapped`.
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

## Built-in defaults

Out of the box a tenant has four environments (`production` 10, `staging` 20,
`preview` 30, `development` 40) and environment rules (`BUILTIN_RULES`, ids
`builtin:*`), evaluated after the tenant's rules:

- `vercel.target` exactly `production` → production, `preview` → preview;
- on `github.environment`, `argocd.environment`, `vercel.target`: leading
  words `^(prod|production|prd|live)\b` → production,
  `^(stag|stage|staging|stg|uat|preprod|pre-prod)\b` → staging,
  `^(preview|review|pr-\d+)\b` → preview,
  `^(dev|develop|development|test|testing|qa|sandbox)\b` → development
  (so `Production – web` and `prod-eu` are production);
- on `argocd.namespace` and `argocd.application`: suffixes like `-prod`,
  `-staging`, `-dev` → the matching environment.

There are no built-in service rules: services are the tenant's to define.
Override a default by adding a rule (tenant rules come first) or switch it off
(`PUT /api/mapping/builtin-rules/:id`). The default environments are virtual
until the tenant's first change, which copies them into its table (after that
they can be renamed, reordered or deleted; built-in rules targeting a deleted
environment become inactive).

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
records who (the authenticated principal: token fingerprint or user), and in
`data`: `revision`, `entity` (`service | environment | rule | builtin_rule |
rule_order`), `operation`, `id`, `before` and `after` summaries. That is how
the audit log shows who changed how deployments are classified.

## UI

Settings → **Mapping** (`/settings/mapping`): services and environments
(add, delete, move columns), service and environment rule tables (add, edit,
delete, move up/down), the rule form with a live preview (debounced
`POST /api/mapping/preview` with the draft in place: how many recent
deployments would change, and how), built-in defaults with on/off switches,
unmapped values with "Create rule" (pre-fills the form), and how recent
deployments classify now. The Deployments page shows the resolved
service · environment under "Where".

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
