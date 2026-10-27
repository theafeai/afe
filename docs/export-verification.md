# Export format and verification

An Afe export is a self-contained evidence file: the selected audit events in
full canonical form plus an integrity manifest. Anyone can verify it offline
with `afe verify-export`, with `verifyExport()` from `@afe/core/export`, or by
reimplementing the algorithm below (it needs only SHA-256, Ed25519 and an
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) JSON canonicaliser).
Event hashing is defined in [event-model.md](event-model.md#hash-chain-and-verification).
How to request exports: [api.md](api.md#get-apiexport).

## What an export proves

| Claim                                                                                | Proven offline?                                                                                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Each exported event is exactly as recorded (any changed field is detected)           | Yes: its hash is recomputed from its content.                                                                                 |
| The file was not changed after export (no event edited, removed, added or reordered) | Yes, against the manifest (`count`, `eventsSha256`, `contentSha256`).                                                         |
| The manifest itself is authentic                                                     | Only if signed and you check the signature against the operator's public key obtained independently. Unsigned: see below.     |
| Exported events that are adjacent in the chain (seq n, n+1) are linked               | Yes: `prevHash` of n+1 equals `hash` of n.                                                                                    |
| The events belong to the tenant's hash chain ending at `chainHead`                   | For an unfiltered full export (`completeChain`): yes, every link up to the head is checked. For a filtered export: see below. |
| Every event matches the stated filter                                                | Yes: the filter is re-evaluated on each event (`eventMatchesFilter`).                                                         |
| **Completeness**: no event that matches the filter is missing                        | Only for `completeChain` exports. For filtered exports: **no**.                                                               |
| The events are true (the deployment really happened as described)                    | No. Afe records what the source reported; the raw payload (`raw=true`) is the evidence of that.                               |

### Filtered exports

A filtered export holds non-contiguous chain positions. The verifier
recomputes every event's hash and checks links between adjacent ones, but it
cannot recompute the hashes of the events in between without their content,
so a linear hash chain cannot prove offline that a filtered event is a member
of the chain ending at `chainHead`, nor that no matching event was left out.
What it gives instead:

- each event commits to its own position (`seq`) and predecessor
  (`prevHash`), and the manifest commits to the chain head at export time;
- with a signed manifest, the operator's key attests that these events were
  read from the chain with that head and that filter;
- membership can be confirmed later, against the live system, without
  trusting the export: `GET /api/audit/verify?anchorSeq=<chainHead.seq>&anchorHash=<chainHead.hash>`
  verifies the whole chain and that it still has that head hash at that
  position; any exported event can be checked with `GET /api/events/<id>`
  (same `hash`) or `GET /api/events?seqFrom=<seq>&seqTo=<seq>`;
- completeness of a filter result can be checked by re-running the filter
  against the live system (with `seqTo=<chainHead.seq>` to pin it to the same
  point), or by exporting the full chain, which is fully self-proving.

### Unsigned exports

Without a signature, anyone who can edit the file can also recompute the
manifest digests consistently. Tampering is then detected only if the
auditor has an independent copy of the manifest (or its `contentSha256`), an
independently recorded chain head (`--expect-head`, or the live
`/api/audit/verify?anchorSeq=…` check), or if the edit breaks an event hash
or a chain link (it does unless the editor rehashes events and rewrites
every later link, which the anchored head then exposes). Set
`AFE_EXPORT_SIGNING_KEY` for evidence that leaves your organisation.

## File formats

Both formats contain the same canonical events and the same manifest; only
the container differs. The manifest is always the **last** record, so a
truncated download fails verification.

### JSON (`format=json`): JSON Lines, `*.afe.jsonl`

One JSON object per line, `\n`-terminated, UTF-8, each serialised as RFC 8785
canonical JSON:

```
{"event":{...canonical event...},"recordType":"event"}
{"event":{...},"rawPayload":{"base64":"eyJuIjoxfQ==","contentType":"application/json"},"recordType":"event"}
{"manifest":{...},"recordType":"manifest"}
```

`rawPayload` is present only with `raw=true` and only for events that have
one. JSON Lines was chosen over a single JSON document so the export can be
streamed and the manifest (which needs digests over everything before it)
can come last; `jq -s` reads it as an array.

### CSV (`format=csv`): `*.afe.csv`

RFC 4180, UTF-8 without BOM, CRLF line endings, a header row, then one row
per event, then one manifest row. Columns:

`record_type, seq, id, occurred_at, recorded_at, source, action, outcome,
actor_type, actor_id, actor_login, actor_name, on_behalf_of, triggered_by,
target_type, target_id, target_name, environment, repository, project,
application, cluster, namespace, ref, commit_shas, trigger_type,
trigger_source_value, observation_method, source_event_id, connection_id,
prev_hash, hash, canonical_json`

- `record_type` is `event` or `manifest`. In a spreadsheet, filter on
  `record_type = event`.
- `canonical_json` holds the full canonical event (RFC 8785 JSON); the other
  columns are a readable projection of it (`commit_shas` space-separated;
  `on_behalf_of`/`triggered_by` = login, else id). Readable cells that start
  with `=`, `+`, `-`, `@`, TAB or CR are prefixed with `'` against
  spreadsheet formula injection.
- The manifest row has `record_type = manifest`, the manifest JSON in
  `canonical_json`, and every other cell empty.

We chose a trailer row over a separate manifest download because two
requests would read two different database snapshots, and over a comment line
because comment lines are not CSV. A manifest can still be kept separately:
`afe verify-export file --manifest manifest.json` accepts the manifest (bare
object or the JSON Lines manifest record) for a file without one, and
reports `manifest_conflict` if the file also has one that differs.

## Manifest

```json
{
  "afeExport": 1,
  "exportId": "7d0f…",
  "tenantId": "default",
  "createdAt": "2026-10-26T09:00:00.000Z",
  "format": "csv",
  "filter": {
    "actions": ["argocd.sync.*", "deployment.created", "…"],
    "environments": ["production"]
  },
  "order": "seq_asc",
  "count": 2,
  "firstSeq": 1,
  "lastSeq": 3,
  "contiguous": false,
  "completeChain": false,
  "chainHead": { "seq": 4, "hash": "…" },
  "includesRawPayloads": false,
  "hashAlgorithm": "sha-256",
  "canonicalization": "rfc8785",
  "eventsSha256": "…",
  "contentSha256": "…",
  "signature": {
    "algorithm": "ed25519",
    "keyId": "3f9a…",
    "publicKey": "<base64url 32 bytes>",
    "value": "<base64url>"
  }
}
```

- `filter`: the normalised filter (see [api.md](api.md#filters)); `{}` = all.
- `chainHead`: the tenant's chain head in the **same database snapshot** the
  events were read from; every exported `seq` is `<= chainHead.seq`.
- `contiguous`: exported seqs form one gap-free range.
- `completeChain`: the filter is empty and the export holds seq 1 to
  `chainHead.seq`.
- `eventsSha256`: lowercase hex SHA-256 over the concatenation, in file
  order, of `"<seq> <hash>\n"` for every event (format-independent: a CSV and
  a JSON export of the same selection have the same value).
- `contentSha256`: lowercase hex SHA-256 over the exact file bytes **before**
  the manifest record (JSON: up to the start of the manifest line; CSV: up to
  the start of the manifest row, so it includes the header row).
- `signature` (optional): Ed25519 ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032))
  over the UTF-8 bytes of RFC 8785 JSON of the manifest **without** the
  `signature` member. `keyId` is the first 16 hex characters of SHA-256 of the
  raw public key. The embedded `publicKey` is a convenience: trust it only if
  it equals a key you obtained independently from the operator
  (`GET /api/export/public-key` on a system you trust, a published key, a
  contract annex).

## Verification algorithm

Input: the export file bytes; optionally a separately kept manifest, trusted
public keys, an expected tenant and an expected chain head.

1. **Decode** the file as UTF-8 (reject invalid UTF-8). Format: JSON Lines if
   it starts with `{`, CSV if it starts with `record_type,`.
2. **Split records.**
   - JSON: split on `\n`; parse each non-empty line; `recordType` is `event`
     or `manifest`.
   - CSV: parse RFC 4180; the first row must equal the column list above;
     every row has 33 cells; parse `canonical_json`.
   - The manifest must be the last record; remember the byte offset where it
     starts (`contentEnd`; the file length if there is none).
3. **Manifest.** Use the separate manifest if given (it must equal the
   embedded one, compared as canonical JSON, if both exist); fail if there is
   none. Check `afeExport = 1`, `hashAlgorithm = "sha-256"`,
   `canonicalization = "rfc8785"`, and the field types. `format` must match
   the file. Normalise `filter`.
4. **Signature.** If `signature` is present, verify it (Ed25519,
   `publicKey`, over `JCS(manifest − signature)`). If trusted keys were
   given, `publicKey` must be one of them. If a signature is required (or
   trusted keys were given) and absent, fail. Check the expected tenant and
   head, if given.
5. **Each event**, in file order, with `prev` = the previous event (none at
   first):
   1. it is a valid canonical event (`canonicalEventSchema`);
   2. `tenantId = manifest.tenantId`;
   3. `SHA-256(JCS(event − hash)) = event.hash` (`hash_mismatch`);
   4. CSV: the readable cells equal the projection recomputed from
      `canonical_json` (`csv_column_mismatch`);
   5. `seq > prev.seq` (`seq_order`); if `seq = 1`, `prevHash` is 64 zeros;
      if `seq = prev.seq + 1`, `prevHash = prev.hash` (`prev_hash_mismatch`);
   6. `seq <= chainHead.seq` (`seq_beyond_head`); if `seq = chainHead.seq`,
      `hash = chainHead.hash` (`head_mismatch`);
   7. the event matches `filter` (`filter_mismatch`);
   8. if a raw payload is embedded, `SHA-256(base64decode(body)) =
event.rawPayload.sha256`; if `includesRawPayloads` and the event has a
      `rawPayload` reference, the payload must be present.
6. **Totals.** `count` = number of events; `firstSeq`/`lastSeq` = first and
   last seq (null when empty); `contiguous` matches; if `completeChain`, the
   filter is empty, the first seq is 1, all seqs are contiguous and linked,
   and the last event equals `chainHead` (or the chain and export are both
   empty); `eventsSha256` and `contentSha256` match (step 2's `contentEnd`).
7. The export verifies if no step failed. Report separately what was proven
   (signature status, complete chain or not) and the limitations above.

Exit codes of `afe verify-export`: 0 verified, 1 verification failed, 2 usage
error. `--json` prints the full report.

```sh
afe verify-export afe-export-default-20261026T090000Z.afe.csv \
  --public-key 6Yt…base64url…  --require-signature \
  --tenant default --expect-head 1234:9f86d0…
```

## Chain anchors

An export proves its events are intact relative to its `chainHead`. It does
not prove that the chain itself was not rewritten consistently in the
database before the export (triggers disabled, every hash recomputed). That
is what **anchors** are for ([ADR 0007](decisions/0007-chain-anchoring.md)):
signed checkpoints `{tenantId, seq, hash, createdAt}` that Afe publishes
periodically to places outside the database (an append-only file on another
volume, an operator webhook, an RFC 3161 timestamp authority).

### Receipt format

The anchor file (`<AFE_ANCHOR_DIR>/<tenant>.anchors.jsonl`) has one receipt
per line, RFC 8785 JSON:

```json
{
  "afeAnchor": 1,
  "anchor": { "kind": "file", "location": "/anchors/default.anchors.jsonl", "publishedAt": "…" },
  "checkpoint": {
    "createdAt": "2026-10-27T10:00:00.000Z",
    "hash": "…",
    "seq": 1234,
    "tenantId": "default",
    "type": "afe.chain-checkpoint",
    "version": 1
  },
  "signature": { "algorithm": "ed25519", "keyId": "…", "publicKey": "…", "value": "…" },
  "timestamp": { "kind": "rfc3161", "tsaUrl": "…", "token": "<base64 DER>", "genTime": "…" }
}
```

- `signature`: Ed25519 over UTF-8(JCS(`checkpoint`)). Same key formats and
  `keyId` as export signatures. Only `checkpoint`, `signature` and `timestamp`
  are evidence; `anchor` is unsigned metadata.
- `timestamp` (optional): an RFC 3161 TimeStampToken whose message imprint is
  SHA-256(UTF-8(JCS(`checkpoint`))).
- Exports made while anchoring is enabled carry the newest receipts at or
  before `chainHead` in `manifest.anchors` (optional member, covered by the
  manifest signature; exports without it verify as before).

### Verifying an export against anchors

```sh
afe verify-export export.afe.jsonl --public-key <key> \
  --anchors /mnt/worm/afe-anchors/default.anchors.jsonl [--anchor-public-key <key>] [--require-anchor]
```

`--anchors` accepts JSON Lines (the anchor file), a JSON array or a single
receipt, and may be repeated. Anchor signatures must match
`--anchor-public-key` if given, else `--public-key`. For every receipt of the
export's tenant, after checking its signature and timestamp imprint:

| Anchored seq `s` vs. export                         | Result                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `s = chainHead.seq`                                 | `match` if `chainHead.hash` equals the anchored hash, else `anchor_mismatch`                              |
| `s < chainHead.seq`, event `s` in the export        | `match` if its (recomputed) hash equals the anchored hash, else `anchor_mismatch`                         |
| `s < chainHead.seq`, complete export, event missing | `anchor_mismatch`                                                                                         |
| `s < chainHead.seq`, filtered export without `s`    | `not_covered` (warning): a filtered export cannot prove anything about an event it does not contain       |
| `s > chainHead.seq`, anchor made before the export  | `anchor_beyond_head`: the chain was shorter at export time than an earlier anchor, so events were removed |
| `s > chainHead.seq`, anchor made after the export   | `after_view`: nothing to compare                                                                          |

What this proves: for a **complete** export, a `match` at seq `s` means the
whole exported prefix 1..`s` is the history that existed when the anchor was
made (every link is verified), so a consistent rewrite of anything up to `s`
is detected. For a **filtered** export, an anchor at `chainHead` confirms
the head the (signed) manifest names, and anchors at exported seqs confirm
those events; membership of the other filtered events still rests on the
signed manifest and the live check. `--require-anchor` fails unless at least
one anchor was confirmed (`anchor_missing`).

### Verifying the live chain against anchors

`GET /api/audit/verify` reports `anchors` (see [api.md](api.md)): every
receipt from the anchor file and the database copy is re-checked and
compared with the live chain; any mismatch makes `ok` false. To use receipts
you kept yourself: `POST /api/audit/anchors/verify` with
`{"text": "<anchor file contents>"}` or `{"receipts": [...]}`.

### Checking the TSA token

Afe checks the token's imprint and nonce, not the TSA's signature. To verify
the TSA signature (needs the TSA's CA certificate):

```sh
jq -r 'select(.checkpoint.seq == 1234) | .timestamp.token' default.anchors.jsonl | base64 -d > cp.tst
DIGEST=$(jq -cjS 'select(.checkpoint.seq == 1234) | .checkpoint' default.anchors.jsonl | sha256sum | cut -d" " -f1)
openssl ts -verify -digest "$DIGEST" -in cp.tst -token_in -CAfile tsa-ca.pem
```

The digest is SHA-256 of the RFC 8785 JSON of `checkpoint`; for its fields
(ASCII strings and integers) `jq -cjS` (compact, sorted keys, no newline)
produces the same bytes. `afe verify-export --json` prints
`anchors.results[].timestamp` (imprint status) and `timestampGenTime`.

## Keys

`afe export-keygen` prints a new `AFE_EXPORT_SIGNING_KEY` (the 32-byte Ed25519
seed, base64url) and its public key. A PKCS#8 PEM also works. Treat the
private key like any other secret (docs/security/key-management.md); publish
the public key where auditors can get it independently of the Afe instance.
Rotating the key does not invalidate old exports: verify them with the key
that was current then (`keyId` tells which).
