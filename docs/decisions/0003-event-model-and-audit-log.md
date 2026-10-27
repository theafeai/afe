# ADR 0003: Canonical event model and append-only audit log

- Status: Superseded by ADR 0008 (append-only audit log, hash chain, verification and export removed; the event model and idempotent ingestion remain)
- Date: 2026-10-26
- Issue: AFE-4

## Context

Afe ingests deployment-related activity from GitHub, ArgoCD and Vercel (and
later other tools) by webhook, polling, watch streams, reconciliation and
backfill. Every later feature (connectors, connection health and observation
gaps, the query API and verifiable export, cross-tool flow correlation) reads
the same audit records, so we need:

1. one event shape that every integration maps into,
2. ingestion that stores an event once however many times and ways it arrives,
3. append-only storage whose integrity anyone can verify, and
4. a way to record periods where a source could not be observed.

## Decision

### One canonical event, schema version 1

Defined in `@afe/core` (`packages/core/src/event.ts`) as TypeScript types plus
a zod validator (`parseEventInput`). Field reference: [event model](../event-model.md).

- **Who** `actor` {type `user|bot|token|system|unknown`, id, login, name,
  email, `onBehalfOf`, `triggeredBy`}; **what** `action` from a documented
  `<object>.<verb>` vocabulary plus `outcome`; **where** `target` {type, id,
  name, repository, project, application, environment, cluster, namespace,
  ref}; **how** `trigger` {type such as `push`, `manual`, `schedule`, `api`,
  `rerun`, `auto_sync`, `rollback`, `promotion`; the source's own term in
  `sourceValue`}.
- **When**: `occurredAt` (in the source) and `observedAt` (by Afe) are
  separate; `recordedAt` is when the row was appended.
- **Provenance**: `observation.method` is `webhook | poll | reconciliation |
backfill | stream | internal`. "Discovered by reconciliation" means
  `method = reconciliation`.
- **Correlation**: a structured `correlation` object of normalised key lists
  (commit SHAs, refs, repositories, environments, image refs/digests,
  source-qualified deployment and run ids, pull requests), GIN-indexed for
  containment queries. Cross-tool correlation (AFE-15) works only on these.
- **Evidence**: the raw source payload is stored byte-for-byte in
  `raw_payloads`; the event references it by id and SHA-256.
- Structured fields are strict (unknown keys rejected) so connector typos do
  not silently lose data; free-form, action-specific details go in `data`.
- `source` and `action` are open strings checked by pattern, with the known
  values listed in code and docs, so a connector outside this repository
  (ADR 0002 `Connector` extension point) does not need a schema change.

Normalisation happens at validation (UTC millisecond timestamps, null fields
dropped, correlation lists sorted, de-duplicated and lower-cased where
case-insensitive) so that the same logical event always hashes the same.

### Idempotency: `(tenant_id, source, source_event_id)` is unique

`sourceEventId` must be derived from the source object (deployment id +
transition, run id + attempt + status, ...), never from a webhook delivery id,
so webhook and polling produce the same key. When an event arrives again, the
first stored version wins and is returned with `inserted: false`; nothing is
updated. Per-source key rules are in the event model doc.

We chose "first wins, no merge" because the log is append-only: merging would
require updating evidence. If we later want to record every observation of an
event (e.g. "seen by webhook at T1 and by poll at T2"), that goes in a separate
non-hashed table, not in `events`.

### Tamper evidence: per-tenant SHA-256 hash chain over RFC 8785 JSON

`hash = SHA-256(JCS(event without hash))`, where JCS is
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON and the
hashed object includes `tenantId`, `seq`, `prevHash`, the raw payload's
SHA-256 and every other field. `seq` is 1-based and gap-free per tenant;
`prevHash` of seq 1 is 64 zeros. `verifyChain` (core, works on any sequence of
events, e.g. an export) and `verifyTenantChain` (db) recompute hashes, check
seq continuity and links, check raw payload bytes and compare with the chain
head, and report the first break (`hash_mismatch`, `prev_hash_mismatch`,
`seq_gap`, `head_mismatch`, `raw_payload_mismatch`, ...).

Alternatives considered:

- _Plain `JSON.stringify` hashing_: depends on key order and on serialiser
  details; jsonb storage reorders keys. Rejected.
- _Merkle tree / transparency log_: gives efficient inclusion proofs, but is
  more complex and not needed until we publish signed checkpoints. A linear
  chain can be checkpointed into one later (the head hash is a commitment to
  the whole history).
- _Global chain across tenants_: serialises all inserts and makes per-tenant
  export proofs depend on other tenants' data. Rejected (ADR 0002).

### Storage (migration `0002_events.sql`)

- `events`: one row per event, structured fields as `jsonb`, unique
  `(tenant_id, seq)` and `(tenant_id, source, source_event_id)`, indexes for
  time, source/action, actor, target, connection and correlation queries.
- `raw_payloads`: `bytea` body, content type, SHA-256, size. A composite
  foreign key stops an event referencing another tenant's payload.
- Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on both tables, and a
  `BEFORE INSERT` trigger rejects an event whose `prev_hash` does not equal the
  hash of the tenant's event at `seq - 1`.
- `event_chain_heads(tenant_id, seq, hash)`: mutable bookkeeping. Appends lock
  the tenant's row `FOR UPDATE`, which serialises appends per tenant while
  other tenants proceed in parallel. Verification compares it with the last
  event, which detects removal of events from the end of the chain.

### Ingestion contract

Connectors depend only on `EventSink` from `@afe/core`:
`ingest(tenantId, input) → { inserted, event }`. `@afe/db` provides
`createPgEventSink(pool)`; `@afe/core` provides `createMemoryEventSink()` for
connector tests. Validation errors (`EventValidationError`) are permanent;
other errors are transient and the job is retried, which is safe because
ingestion is idempotent.

### Observation gaps are events

A period where a connection could not observe its source is recorded as
`observation_gap.opened` and `observation_gap.closed` events (source `afe`,
target the connection, gap details in `data.gap`, validated), in the same
hash chain. Builders: `observationGapOpened` / `observationGapClosed`. Health
tracking that decides when to open and close gaps is AFE-13.

## Consequences

- Changing the hashed shape of an event requires a new `schemaVersion`;
  verifiers must keep supporting every version ever written. Adding optional
  fields, enum values, actions and sources is backwards-compatible as long as
  absent optional fields are omitted (they are not hashed).
- Timestamps are truncated to milliseconds; sources with finer precision lose
  it in the canonical event (the raw payload keeps the original).
- Strings containing NUL or unpaired surrogates are rejected (PostgreSQL
  cannot store them in jsonb and JCS cannot canonicalise them). Connectors
  must keep such data in the raw payload only.
- The hash chain proves integrity relative to a trusted head. A database
  superuser can disable triggers and rewrite the entire chain consistently;
  detecting that requires heads anchored outside the database (exports,
  published or signed checkpoints), which AFE-14 builds on.
- Retention that deletes events (a paid `RetentionPolicy`) will need a
  controlled path around the triggers and a signed deletion record; it is out
  of scope here.
