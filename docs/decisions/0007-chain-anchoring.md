# ADR 0007: Anchoring audit chain heads outside the database

- Status: Superseded by ADR 0008 (chain anchoring removed from the open-source build)
- Date: 2026-10-27
- Issue: AFE-29

## Context

The per-tenant hash chain (ADR 0003) detects any edit relative to a trusted
head. It does not detect a database superuser who disables the triggers,
rewrites a tenant's events and recomputes every hash and the stored head: the
rewritten chain verifies. Detecting that needs statements about the chain
("at seq N the hash was H") that left the database before the rewrite and
that the database administrator cannot rewrite too.

## Decision

### Signed checkpoints

A **checkpoint** is

```json
{
  "type": "afe.chain-checkpoint",
  "version": 1,
  "tenantId": "default",
  "seq": 1234,
  "hash": "<64 hex>",
  "createdAt": "2026-10-27T10:00:00.000Z"
}
```

signed with Ed25519 over UTF-8(RFC 8785 JCS(checkpoint)). The key is
`AFE_ANCHOR_SIGNING_KEY`, or the export key `AFE_EXPORT_SIGNING_KEY` when no
dedicated key is set (same key formats, same `keyId`). `type` separates
checkpoint signatures from export-manifest signatures made with the same key.
A **receipt** (`AnchorReceipt`) is the signed checkpoint plus unsigned anchor
metadata (`anchor.kind`, `location`, `publishedAt`) and, optionally, an
RFC 3161 `timestamp` token over SHA-256 of the same signing input.

### `ChainAnchor` extension point (ADR 0002)

`@afe/core/anchoring` defines `ChainAnchor { kind, publish(signed) →
AnchorReceipt, list?(tenantId), latest?(tenantId), verify?(receipt) }` and
`CheckpointSigner` (same shape as `ExportSigner`). The composition root takes
them through `createAnchorModule({ anchors, signer })`, so the hosted service
can use KMS-signed checkpoints written to its own storage. OSS anchors:

| Anchor           | Config                   | What it gives                                                                                                                                             |
| ---------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Append-only file | `AFE_ANCHOR_DIR`         | `<dir>/<tenant>.anchors.jsonl`, one JCS receipt per line, `O_APPEND` + fsync; refuses a lower seq or a different hash at the same seq. Readable (`list`). |
| HTTP webhook     | `AFE_ANCHOR_WEBHOOK_URL` | POSTs `{"type":"afe.chain_checkpoint","receipt":…}` to an operator endpoint (outbound rules R6: validated before each request, no redirects).             |
| RFC 3161 TSA     | `AFE_ANCHOR_TSA_URL`     | A third-party timestamp over the checkpoint; the token is stored in the receipt (and in the file line when both are set).                                 |

The TSA client builds the DER `TimeStampReq` itself (small encoder, no
dependency), sends `certReq = true` and a random nonce, and checks the
response status, the token's TSTInfo message imprint (SHA-256 of the
checkpoint) and the nonce. It does **not** verify the TSA's CMS signature or
certificate chain; auditors do that with `openssl ts -verify` against the
TSA's CA (documented in docs/export-verification.md). Doing it in Afe is a
follow-up.

### When anchors are published

- `anchor.publish` job, cron derived from `AFE_ANCHOR_INTERVAL` (default `1h`),
  for every tenant whose head moved since the newest anchor.
- At export time (`AFE_ANCHOR_ON_EXPORT`, default on): the export snapshot's
  head is anchored if newer, and the receipts of the newest checkpoint at or
  before the export head are embedded in the manifest (`manifest.anchors`,
  optional and covered by the manifest signature; old exports stay valid).
- TSA anchors run first so later anchors store the token.
- **Continuity check before publishing:** the previous anchors (newest receipt
  of every readable anchor plus the newest stored receipts) must still match
  the live chain. If one does not, nothing is published, the error is
  recorded in `chain_anchor_state` and logged: anchoring a rewritten chain
  would bless it.

### Storage (migration 0016)

`chain_anchor_receipts` (tenant-scoped, no UPDATE) keeps a copy of every
receipt; `chain_anchor_state` records the last run and error. The copy is a
convenience only: an attacker with database access can delete or forge rows.
Verification never trusts it alone: signatures are re-checked against the
configured key(s), readable external anchors (the file) are read directly,
and `/api/audit/verify` warns when only the database copy was available.

### Verification

`verifyAnchorsAgainstChain(receipts, view)` (pure, in core) checks each
receipt (shape, signature, trusted key, TSA imprint) and its position:

- `match` / `mismatch`: the chain (or export) has / does not have the
  anchored hash at the anchored seq. A mismatch is the rewrite signal.
- `beyond_head`: the anchor is newer than the head of the view although it
  was made before it (live chain: always; export: anchor `createdAt` <=
  manifest `createdAt`): events were removed.
- `after_view`: anchor made after the export; nothing to compare.
- `not_covered`: a filtered export does not contain the anchored seq.

`GET /api/audit/verify` adds `anchors` (status of every receipt from the
anchor file and the database, latest anchor, age, staleness, last run) and
fails `ok` on any anchor error. `POST /api/audit/anchors/verify` checks
receipts supplied by an auditor against the live chain. `afe verify-export
--anchors <file>` checks an export against anchors kept outside Afe.

## Threat model

Anchors help only against an attacker who cannot also rewrite the anchor
location and does not hold the signing key:

- **File anchor:** worthless on the same disk as the database or writable by
  the same administrator. Put it on a separate volume that is synced to
  storage with a retention lock (S3 Object Lock in compliance mode, GCS bucket
  retention policy with a locked policy) or a backup system the DB admin does
  not control. The file's append-only checks protect against Afe itself being
  fed a rewritten chain, not against someone editing the file.
- **Webhook anchor:** as strong as the endpoint's own storage.
- **TSA:** independent of the operator; proves the checkpoint existed at
  `genTime`. Someone holding the signing key can still create new checkpoints
  for a rewritten chain, but cannot obtain timestamps for the past, and cannot
  remove earlier lines from retention-locked storage.
- **Signing key:** an attacker with the Afe host's environment can sign new
  checkpoints. Old anchors in external storage still expose the rewrite; keep
  the key out of the database host where possible (KMS in the hosted service).
- **Detection, not prevention:** anchoring makes a rewrite visible to anyone
  who checks against an external anchor. It is only as frequent as the
  interval: events appended after the newest anchor are covered by the next
  anchor, not the previous one.

## Consequences

- No cloud SDK is added. Object storage with a retention lock is used by
  syncing the anchor directory (see docs/self-hosting/configuration.md).
- Anchoring is off unless an anchor is configured; configuring one without a
  signing key is a startup error.
- `ServerContext.anchors` lets `/api/audit/verify` and exports use the anchor
  module without depending on its configuration.

## To verify against docs

The environment had no network access; these are based on knowledge of the
standards and must be checked:

1. RFC 3161 interoperability with real TSAs (FreeTSA, DigiCert, Sectigo):
   request/response content types `application/timestamp-query` /
   `application/timestamp-reply`, DER (not BER) responses, `certReq` handling.
   https://www.rfc-editor.org/rfc/rfc3161
2. Many public TSAs are served over plain `http:` only; Afe's outbound rules
   (R6) require `https:` for public hosts. Pick an https TSA or decide on an
   explicit exception (the token is self-authenticating).
3. That `openssl ts -verify -digest <hex> -in <token.der> -token_in -CAfile <ca>`
   verifies tokens stored by Afe (TimeStampToken, not TimeStampResp).
4. S3 Object Lock and GCS retention semantics as documented for operators
   (https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html,
   https://cloud.google.com/storage/docs/bucket-lock).
