# ADR 0008: Open-source scope without the audit log

- Status: Accepted
- Date: 2026-10-27
- Supersedes: ADR 0003 (the append-only audit log and hash chain parts), ADR 0007
- Amends: ADR 0002 (datastore, extension points)

## Context

Until now Afe stored every event forever in an append-only, hash-chained
`events` table, and offered verifiable exports (CSV/JSON with an integrity
manifest and Ed25519 signature), chain verification (`/api/audit/verify`) and
chain anchoring outside the database (ADR 0007).

The repository owner decided that the audit log (long-term, tamper-evident
history and everything built on it) is a paid feature and is not part of the
open-source Afe. The open-source Afe is a **live deployment-visibility
tool**: it shows what is deploying where right now and recently, across
GitHub, ArgoCD and Vercel, and whether every source can still be observed.

The removed code stays in git history; the paid product is built separately
and is not stubbed here.

## Decision

### What moved out of this repository

Deleted, with their tests and docs:

- the per-tenant SHA-256 hash chain (`hash-chain.ts`, `buildChainedEvent`,
  `GENESIS_HASH`, the `prevHash`/`hash` fields of `CanonicalEvent`),
  `verifyChain`/`verifyTenantChain` and the chain-head lock;
- exports in every form: verifiable and plain CSV/JSON (`@afe/core/export`,
  `AuditExporter`, `/api/export`, `/api/export/public-key`, the web UI Export
  menu, `AFE_EXPORT_SIGNING_KEY`, `afe export-keygen`, `afe verify-export`);
- audit verification (`/api/audit/verify`, the web UI "Verify audit log"
  button and the event detail page's integrity section);
- chain anchoring (`@afe/core/anchoring`, the anchor module and job,
  `/api/audit/anchors*`, `AFE_ANCHOR_*`, `ServerContext.anchors`).

Migration `0021_remove_audit_chain.sql` (forward-only) drops the
append-only and chain-link triggers on `events` and `raw_payloads`, the
`prev_hash`/`hash` columns, `event_chain_heads`, the anchor tables of 0016
and a leftover `anchor.publish` pg-boss schedule.

### What remains

- The canonical event model (ADR 0003) unchanged except for the chain
  fields: one shape for every source, `observation` provenance,
  `correlation` keys, observation gaps as events.
- **Idempotent ingestion** on `(tenant_id, source, source_event_id)`:
  webhook, polling, reconciliation and backfill still deliver an event once.
  First arrival wins.
- **Raw payloads** are still stored (for the event detail page's "download
  raw payload", a debugging aid) and are deleted together with their event.
- **`seq`** stays as a per-tenant ordering key: allocated from the tenant's
  row in `event_sequences`, which the inserting transaction holds until it
  commits, so a tenant's seq order is its commit order. The query API's
  keyset cursor over `(occurredAt, seq)` and its snapshot pinning
  (`snapshotSeq`) work as before. Seq numbers are never reused, so purged
  events leave gaps.
- Events are **immutable once written**: application code never updates
  them. The only deletion is the retention purge. This is a code rule, no
  longer enforced by database triggers.
- Timeline, deployments view, event detail, connection health and
  observation gaps, environment mapping and correlation.

### Retention

`RetentionPolicy` (ADR 0002 extension point, `@afe/core` `retention.ts`):

```ts
interface RetentionPolicy {
  cutoff(tenantId: string, now: Date): Date | null | Promise<Date | null>;
  readonly maxWindowMs: number | null;
}
```

The open-source default is `FixedWindowRetention` from
`AFE_EVENT_RETENTION_DAYS`: **default 30 days, minimum 1, maximum 60**. A
value outside 1..60 is a startup error (Afe refuses to start rather than
silently keeping less than configured). **60 days is the boundary of the
open-source product**: longer history is what the paid audit log is for. It
is a product limit, not a technical one.

Retention is measured on **`occurredAt`** (when it happened in the source),
not `recordedAt` (when Afe stored it):

- the timeline, deployments view and correlation are ordered and filtered by
  `occurredAt`, so the window matches what users see ("the last 30 days");
- ingestion can check an event before storing it. `EventSink`
  implementations **drop** an event whose `occurredAt` is already before the
  cutoff (`IngestResult.status = "expired"`). With `recordedAt`, a poll or
  backfill that re-reads an old object would store it again as new and keep
  it for another full window, and a purged duplicate could reappear; with
  `occurredAt` the same object maps to the same `occurredAt` and stays out.

The `retention.purge` job (hourly, `apps/server/src/retention.ts`) deletes,
per tenant, events with `occurred_at < cutoff` and the raw payloads they
reference, in batches of 1000 rows per transaction (at most 100 batches per
run; it re-enqueues itself when more remain), then raw payloads received
before the cutoff that no event references.

Connector windows never exceed the retention window: GitHub
(`AFE_GITHUB_BACKFILL_DAYS`, `AFE_GITHUB_RECONCILE_LOOKBACK`) and Vercel
(first-connect backfill, 30 days) are clamped to `maxWindowMs` with a log
line, and gap backfills start no earlier than the cutoff. ArgoCD has no
time-range query; history entries older than the window are dropped by the
sink.

Caveats:

- An event whose source timestamp is in the future (clock skew) is kept
  until that time plus the window.
- An `observation_gap.opened` event whose start is older than the window is
  dropped or purged; the gap's `closed` event carries the full gap
  (`startedAt`..`endedAt`), and the current health state lives in
  `connection_health`, so health reporting is unaffected. Gap history is
  limited to the window.

### Seams for another build

The composition root keeps the replaceable pieces as options (ADR 0002):

- `createAfe({ sink })` / `buildAfe({ sink })`: an `EventSink` is the only
  way events are written. **A paid build can supply its own `EventSink`**
  (for example one that also appends every event to a long-term, tamper-
  evident store) **and its own `RetentionPolicy` via `createAfe` options**.
- `createAfe({ retentionPolicy })`: used by the default PostgreSQL sink, by
  the purge job and to clamp connector lookbacks (`ServerContext.retention`).

Nothing in this repository refers to the paid product, and there are no
"upgrade" placeholders.

## Consequences

- Smaller data footprint and less personal data kept: events, actor
  identities and raw payloads are deleted after at most 60 days (privacy
  win; see docs/security/data-inventory.md).
- No tamper evidence: Afe's history is as trustworthy as its database. Afe
  is not an audit record and must not be described as one.
- No export. Data can be read through the query API while it is retained.
- Database backups no longer have a chain to protect; restoring an old
  backup simply brings back events that the next purge removes again.
- Upgrading applies 0021 to existing data: chain columns and heads are
  dropped, existing `seq` values are kept and new events continue after the
  highest one; the first purge run deletes everything older than the window.
