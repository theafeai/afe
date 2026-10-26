/**
 * Offline verification of an Afe export (JSON Lines or CSV). Pure: needs only
 * the file (and optionally a separately kept manifest and trusted public
 * keys), no database or network. The algorithm is documented step by step in
 * docs/export-verification.md so auditors can reimplement it.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json.ts";
import { canonicalEventSchema, type CanonicalEvent } from "../event.ts";
import {
  eventMatchesFilter,
  isEmptyFilter,
  normaliseEventFilter,
  type EventFilter,
  type EventFilterInput,
} from "../event-filter.ts";
import { GENESIS_HASH, hashEvent, sha256Hex } from "../hash-chain.ts";
import { CsvParseError, EXPORT_CSV_COLUMNS, eventToCsvCells, parseCsv } from "./csv.ts";
import { eventsDigestLine } from "./exporter.ts";
import { manifestSigningInput, normaliseExportPublicKey, verifyEd25519 } from "./signer.ts";
import { EXPORT_FORMAT_VERSION, type ExportFormat, type ExportManifest } from "./types.ts";

export type ExportIssueCode =
  | "malformed_file"
  | "malformed_record"
  | "malformed_event"
  | "manifest_missing"
  | "manifest_malformed"
  | "manifest_not_last"
  | "manifest_conflict"
  | "format_mismatch"
  | "csv_header_mismatch"
  | "csv_column_mismatch"
  | "tenant_mismatch"
  | "hash_mismatch"
  | "prev_hash_mismatch"
  | "seq_order"
  | "seq_beyond_head"
  | "head_mismatch"
  | "filter_mismatch"
  | "raw_payload_mismatch"
  | "raw_payload_missing"
  | "count_mismatch"
  | "seq_range_mismatch"
  | "contiguity_mismatch"
  | "complete_chain_mismatch"
  | "events_digest_mismatch"
  | "content_digest_mismatch"
  | "signature_invalid"
  | "signature_missing"
  | "signature_untrusted"
  | "unexpected_tenant"
  | "unexpected_head";

export interface ExportIssue {
  code: ExportIssueCode;
  message: string;
  /** 0-based index of the event record, when the issue is about one. */
  index?: number;
  seq?: number;
}

export type SignatureStatus =
  /** Signed, signature valid, and the key is one of `trustedPublicKeys`. */
  | "valid_trusted"
  /** Signed and valid with the embedded key, but no trusted key was given to compare with. */
  | "valid_unpinned"
  | "invalid"
  | "absent";

export interface ExportVerificationReport {
  ok: boolean;
  format: ExportFormat | null;
  manifest: ExportManifest | null;
  eventCount: number;
  signature: { status: SignatureStatus; keyId?: string };
  /** What this verification established (true only when proven). */
  proofs: {
    /** Every event's content hashes to its recorded hash and belongs to the manifest's tenant. */
    eventsIntact: boolean;
    /** File bytes, event list, count and seq range match the manifest. */
    exportIntact: boolean;
    /** Manifest signed by a trusted key (or valid but unpinned, see `signature`). */
    manifestSigned: boolean;
    /** Every exported event satisfies the manifest's filter. */
    matchesFilter: boolean;
    /** Number of adjacent exported event pairs whose prevHash link was verified. */
    linksVerified: number;
    /** The export holds the whole chain 1..chainHead, every link verified. */
    completeChain: boolean;
    /** The event at chainHead.seq is in the export and its hash equals the head hash. */
    headIncluded: boolean;
  };
  /** Human-readable list of what is NOT proven by this export. */
  limitations: string[];
  errors: ExportIssue[];
  warnings: string[];
}

export interface VerifyExportOptions {
  /** A manifest kept separately (JSON text or object); compared with / used instead of the embedded one. */
  manifest?: string | ExportManifest | null;
  /** Public keys (raw base64url or SPKI PEM) the signature must match. */
  trustedPublicKeys?: string[];
  /** Fail if the manifest is not signed. */
  requireSignature?: boolean;
  /** Fail unless the export is for this tenant. */
  expectedTenantId?: string;
  /** Fail unless the manifest's chain head equals this (e.g. a head you recorded independently). */
  expectedHead?: { seq: number; hash: string };
  /** Force the format instead of detecting it. */
  format?: ExportFormat;
  /** Stop collecting issues after this many (default 100). */
  maxIssues?: number;
}

interface ParsedRecord {
  index: number;
  event: unknown;
  csvCells?: string[];
  raw?: { contentType: unknown; base64: unknown };
}

const HEX64 = /^[0-9a-f]{64}$/;

export function verifyExport(
  input: string | Uint8Array,
  options: VerifyExportOptions = {},
): ExportVerificationReport {
  const maxIssues = options.maxIssues ?? 100;
  const errors: ExportIssue[] = [];
  const warnings: string[] = [];
  const issue = (i: ExportIssue) => {
    if (errors.length < maxIssues) errors.push(i);
  };
  const report = (
    format: ExportFormat | null,
    manifest: ExportManifest | null,
    eventCount: number,
    partial: Partial<ExportVerificationReport["proofs"]> = {},
    signature: ExportVerificationReport["signature"] = { status: "absent" },
  ): ExportVerificationReport => {
    const proofs = {
      eventsIntact: false,
      exportIntact: false,
      manifestSigned: false,
      matchesFilter: false,
      linksVerified: 0,
      completeChain: false,
      headIncluded: false,
      ...partial,
    };
    return {
      ok: errors.length === 0,
      format,
      manifest,
      eventCount,
      signature,
      proofs,
      limitations: limitations(manifest, proofs, signature.status),
      errors,
      warnings,
    };
  };

  // --- 1. Decode -----------------------------------------------------------
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      issue({ code: "malformed_file", message: "file is not valid UTF-8" });
      return report(null, null, 0);
    }
  }
  const format: ExportFormat | null =
    options.format ??
    (text.startsWith("{") ? "json" : text.startsWith("record_type,") ? "csv" : null);
  if (!format) {
    issue({ code: "malformed_file", message: "not an Afe export (expected JSON Lines or CSV)" });
    return report(null, null, 0);
  }

  // --- 2. Split records and find the manifest ------------------------------
  const records: ParsedRecord[] = [];
  let embedded: unknown = null;
  let contentEnd = text.length;
  try {
    if (format === "json") {
      let pos = 0;
      let index = 0;
      while (pos < text.length) {
        const nl = text.indexOf("\n", pos);
        const end = nl === -1 ? text.length : nl;
        const line = text.slice(pos, end);
        const lineStart = pos;
        pos = end + 1;
        if (embedded !== null) {
          issue({ code: "manifest_not_last", message: "content follows the manifest record" });
          break;
        }
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          issue({ code: "malformed_record", message: `line ${index + 1} is not valid JSON` });
          index += 1;
          continue;
        }
        if (obj?.recordType === "manifest") {
          embedded = obj.manifest ?? null;
          contentEnd = lineStart;
        } else if (obj?.recordType === "event") {
          records.push({
            index: records.length,
            event: obj.event,
            raw: obj.rawPayload as ParsedRecord["raw"],
          });
        } else {
          issue({
            code: "malformed_record",
            message: `line ${index + 1} has an unknown recordType`,
          });
        }
        index += 1;
      }
    } else {
      const rows = parseCsv(text);
      const header = rows[0]?.cells ?? [];
      if (canonicalJson(header) !== canonicalJson([...EXPORT_CSV_COLUMNS])) {
        issue({
          code: "csv_header_mismatch",
          message: "CSV header does not match the Afe export columns",
        });
        return report(format, null, 0);
      }
      for (const row of rows.slice(1)) {
        if (embedded !== null) {
          issue({ code: "manifest_not_last", message: "rows follow the manifest row" });
          break;
        }
        if (row.cells.length !== EXPORT_CSV_COLUMNS.length) {
          issue({
            code: "malformed_record",
            message: `CSV row at offset ${row.start} has ${row.cells.length} columns`,
          });
          continue;
        }
        const json = row.cells[row.cells.length - 1]!;
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          issue({
            code: "malformed_record",
            message: `CSV row at offset ${row.start}: canonical_json is not JSON`,
          });
          continue;
        }
        if (row.cells[0] === "manifest") {
          embedded = parsed;
          contentEnd = row.start;
        } else if (row.cells[0] === "event") {
          records.push({ index: records.length, event: parsed, csvCells: row.cells });
        } else {
          issue({
            code: "malformed_record",
            message: `CSV row at offset ${row.start} has an unknown record_type`,
          });
        }
      }
    }
  } catch (err) {
    if (err instanceof CsvParseError) {
      issue({ code: "malformed_file", message: `CSV: ${err.message}` });
      return report(format, null, 0);
    }
    throw err;
  }

  // --- 3. Choose the manifest ----------------------------------------------
  let external: unknown = null;
  if (options.manifest) {
    try {
      const m =
        typeof options.manifest === "string"
          ? (JSON.parse(options.manifest) as unknown)
          : options.manifest;
      // Accept the bare manifest or a {"recordType":"manifest","manifest":{...}} record.
      external =
        (m as { recordType?: string }).recordType === "manifest"
          ? (m as { manifest: unknown }).manifest
          : m;
    } catch {
      issue({ code: "manifest_malformed", message: "the separate manifest is not valid JSON" });
      return report(format, null, records.length);
    }
  }
  if (
    external !== null &&
    embedded !== null &&
    canonicalJson(external) !== canonicalJson(embedded)
  ) {
    issue({
      code: "manifest_conflict",
      message: "the separate manifest differs from the one in the file",
    });
  }
  const manifestValue = external ?? embedded;
  if (manifestValue === null) {
    issue({
      code: "manifest_missing",
      message: "no manifest: the export is truncated or the manifest was removed",
    });
    return report(format, null, records.length);
  }
  const manifestProblem = checkManifestShape(manifestValue);
  if (manifestProblem) {
    issue({ code: "manifest_malformed", message: manifestProblem });
    return report(format, null, records.length);
  }
  const manifest = manifestValue as ExportManifest;
  let filter: EventFilter;
  try {
    filter = normaliseEventFilter(manifest.filter as EventFilterInput);
  } catch (err) {
    issue({ code: "manifest_malformed", message: `manifest filter: ${(err as Error).message}` });
    return report(format, manifest, records.length);
  }
  if (manifest.format !== format) {
    issue({
      code: "format_mismatch",
      message: `manifest says ${manifest.format}, file is ${format}`,
    });
  }

  // --- 4. Signature ----------------------------------------------------------
  let signature: ExportVerificationReport["signature"] = { status: "absent" };
  if (manifest.signature) {
    const s = manifest.signature;
    const valid =
      s.algorithm === "ed25519" &&
      verifyEd25519(s.publicKey, manifestSigningInput(manifest), s.value);
    if (!valid) {
      signature = { status: "invalid", keyId: s.keyId };
      issue({
        code: "signature_invalid",
        message: "manifest signature does not verify: the manifest was altered",
      });
    } else if (options.trustedPublicKeys && options.trustedPublicKeys.length > 0) {
      const trusted = options.trustedPublicKeys.map(normaliseExportPublicKey);
      if (trusted.includes(s.publicKey)) {
        signature = { status: "valid_trusted", keyId: s.keyId };
      } else {
        signature = { status: "invalid", keyId: s.keyId };
        issue({
          code: "signature_untrusted",
          message: `manifest is signed by key ${s.keyId}, which is not trusted`,
        });
      }
    } else {
      signature = { status: "valid_unpinned", keyId: s.keyId };
      warnings.push(
        `signature is valid for the embedded key ${s.keyId}; pass the operator's public key to pin it`,
      );
    }
  } else if (options.requireSignature || (options.trustedPublicKeys?.length ?? 0) > 0) {
    issue({ code: "signature_missing", message: "the manifest is not signed" });
  }
  if (options.expectedTenantId !== undefined && manifest.tenantId !== options.expectedTenantId) {
    issue({ code: "unexpected_tenant", message: `export is for tenant ${manifest.tenantId}` });
  }
  if (
    options.expectedHead &&
    (options.expectedHead.seq !== manifest.chainHead.seq ||
      options.expectedHead.hash !== manifest.chainHead.hash)
  ) {
    issue({
      code: "unexpected_head",
      message: "the manifest's chain head is not the expected head",
    });
  }

  // --- 5. Events -------------------------------------------------------------
  const head = manifest.chainHead;
  const eventsDigest = createHash("sha256");
  let eventsIntact = true;
  let matchesFilter = true;
  let linksVerified = 0;
  let allLinked = true;
  let headIncluded = false;
  let contiguous = true;
  let prev: { seq: number; hash: string } | null = null;
  let firstSeq: number | null = null;

  for (const rec of records) {
    const e = rec.event as CanonicalEvent;
    const at = { index: rec.index, seq: typeof e?.seq === "number" ? e.seq : undefined };
    const parsed = canonicalEventSchema.safeParse(e);
    if (!parsed.success) {
      eventsIntact = false;
      issue({
        code: "malformed_event",
        message: "event does not match the canonical event schema",
        ...at,
      });
      if (typeof e?.seq !== "number" || typeof e?.hash !== "string") continue;
    }
    eventsDigest.update(eventsDigestLine(e.seq, e.hash), "utf8");

    if (e.tenantId !== manifest.tenantId) {
      eventsIntact = false;
      issue({ code: "tenant_mismatch", message: `event belongs to tenant ${e.tenantId}`, ...at });
    }
    let recomputed: string | null = null;
    try {
      recomputed = hashEvent(e);
    } catch {
      // reported below
    }
    if (recomputed !== e.hash) {
      eventsIntact = false;
      issue({
        code: "hash_mismatch",
        message: "event content does not match its hash: the event was modified",
        ...at,
      });
    }
    if (rec.csvCells && parsed.success) {
      const expected = eventToCsvCells(e);
      const diff = EXPORT_CSV_COLUMNS.filter((_, i) => expected[i] !== rec.csvCells![i]);
      if (diff.length > 0) {
        issue({
          code: "csv_column_mismatch",
          message: `readable columns differ from canonical_json: ${diff.join(", ")}`,
          ...at,
        });
      }
    }
    if (prev && e.seq <= prev.seq) {
      issue({ code: "seq_order", message: `seq ${e.seq} does not follow ${prev.seq}`, ...at });
    }
    if (prev && e.seq !== prev.seq + 1) contiguous = false;
    if (e.seq === 1 && e.prevHash !== GENESIS_HASH) {
      allLinked = false;
      issue({
        code: "prev_hash_mismatch",
        message: "first event of the chain does not link to genesis",
        ...at,
      });
    }
    if (prev && e.seq === prev.seq + 1) {
      if (e.prevHash === prev.hash) linksVerified += 1;
      else {
        allLinked = false;
        issue({
          code: "prev_hash_mismatch",
          message: `event ${e.seq} does not link to event ${prev.seq}`,
          ...at,
        });
      }
    }
    if (e.seq > head.seq) {
      issue({
        code: "seq_beyond_head",
        message: `seq ${e.seq} is after the chain head ${head.seq}`,
        ...at,
      });
    } else if (e.seq === head.seq) {
      if (e.hash === head.hash) headIncluded = true;
      else
        issue({
          code: "head_mismatch",
          message: "the last chain event does not match the chain head",
          ...at,
        });
    }
    if (parsed.success && !eventMatchesFilter(e, filter)) {
      matchesFilter = false;
      issue({
        code: "filter_mismatch",
        message: "event does not match the manifest's filter",
        ...at,
      });
    }
    if (rec.raw) {
      const body =
        typeof rec.raw.base64 === "string" ? Buffer.from(rec.raw.base64, "base64") : null;
      if (!e.rawPayload || !body || sha256Hex(body) !== e.rawPayload.sha256) {
        issue({
          code: "raw_payload_mismatch",
          message: "raw payload bytes do not match the event's rawPayload.sha256",
          ...at,
        });
      }
    } else if (manifest.includesRawPayloads && e.rawPayload) {
      issue({
        code: "raw_payload_missing",
        message: "manifest says raw payloads are included, but this one is missing",
        ...at,
      });
    }
    firstSeq ??= e.seq;
    prev = { seq: e.seq, hash: e.hash };
  }

  // --- 6. Manifest totals ------------------------------------------------------
  let exportIntact = true;
  const fail = (code: ExportIssueCode, message: string) => {
    exportIntact = false;
    issue({ code, message });
  };
  if (manifest.count !== records.length) {
    fail(
      "count_mismatch",
      `manifest lists ${manifest.count} events, file has ${records.length}: events were removed or added`,
    );
  }
  if (manifest.firstSeq !== firstSeq || manifest.lastSeq !== (prev?.seq ?? null)) {
    fail("seq_range_mismatch", "first/last seq differ from the manifest");
  }
  if (manifest.contiguous !== contiguous) {
    fail("contiguity_mismatch", "manifest's contiguous flag does not match the events");
  }
  const emptyChain = head.seq === 0 && records.length === 0;
  const formsChain =
    emptyChain ||
    (contiguous && allLinked && firstSeq === 1 && headIncluded && records.length === head.seq);
  if (manifest.completeChain && !formsChain) {
    fail(
      "complete_chain_mismatch",
      "manifest claims the complete chain, but the events do not form it",
    );
  }
  if (manifest.completeChain && !isEmptyFilter(filter)) {
    fail("complete_chain_mismatch", "a filtered export cannot be the complete chain");
  }
  if (eventsDigest.digest("hex") !== manifest.eventsSha256) {
    fail("events_digest_mismatch", "eventsSha256 does not match the exported events");
  }
  const contentSha = sha256Hex(new TextEncoder().encode(text.slice(0, contentEnd)));
  if (contentSha !== manifest.contentSha256) {
    fail("content_digest_mismatch", "contentSha256 does not match the file: the file was modified");
  }

  return report(
    format,
    manifest,
    records.length,
    {
      eventsIntact: eventsIntact && records.length === manifest.count,
      exportIntact,
      manifestSigned: signature.status === "valid_trusted" || signature.status === "valid_unpinned",
      matchesFilter,
      linksVerified,
      completeChain: formsChain && eventsIntact && isEmptyFilter(filter) && errors.length === 0,
      headIncluded,
    },
    signature,
  );
}

function checkManifestShape(m: unknown): string | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "manifest is not an object";
  const o = m as Record<string, unknown>;
  if (o.afeExport !== EXPORT_FORMAT_VERSION)
    return `unsupported export version ${String(o.afeExport)}`;
  const isInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const isSeq = (v: unknown) => v === null || (isInt(v) && (v as number) >= 1);
  if (typeof o.tenantId !== "string" || !o.tenantId) return "manifest.tenantId missing";
  if (o.format !== "json" && o.format !== "csv") return "manifest.format invalid";
  if (!o.filter || typeof o.filter !== "object" || Array.isArray(o.filter))
    return "manifest.filter invalid";
  if (o.order !== "seq_asc") return "manifest.order invalid";
  if (!isInt(o.count) || !isSeq(o.firstSeq) || !isSeq(o.lastSeq)) return "manifest counts invalid";
  if (typeof o.contiguous !== "boolean" || typeof o.completeChain !== "boolean")
    return "manifest flags invalid";
  const h = o.chainHead as Record<string, unknown> | undefined;
  if (!h || !isInt(h.seq) || typeof h.hash !== "string" || !HEX64.test(h.hash))
    return "manifest.chainHead invalid";
  if (o.hashAlgorithm !== "sha-256" || o.canonicalization !== "rfc8785")
    return "unsupported hash algorithm";
  if (typeof o.eventsSha256 !== "string" || !HEX64.test(o.eventsSha256))
    return "manifest.eventsSha256 invalid";
  if (typeof o.contentSha256 !== "string" || !HEX64.test(o.contentSha256))
    return "manifest.contentSha256 invalid";
  if (o.signature !== undefined) {
    const s = o.signature as Record<string, unknown>;
    if (!s || typeof s.publicKey !== "string" || typeof s.value !== "string")
      return "manifest.signature invalid";
  }
  return null;
}

function limitations(
  manifest: ExportManifest | null,
  proofs: ExportVerificationReport["proofs"],
  sig: SignatureStatus,
): string[] {
  const out: string[] = [];
  if (!manifest) return out;
  if (sig === "absent") {
    out.push(
      "The manifest is not signed: anyone who can edit the file can rewrite it consistently. " +
        "Its integrity rests on a copy of the manifest (or its contentSha256) kept elsewhere, " +
        "or on checking the chain head against the live system.",
    );
  } else if (sig === "valid_unpinned") {
    out.push(
      "The signing key was not compared with a trusted key; pass the operator's public key.",
    );
  }
  if (!proofs.completeChain) {
    out.push(
      "Completeness is not proven: this is a filtered or partial export, so events that match the " +
        "filter but are missing from the file cannot be detected offline. Re-run the same filter " +
        "against the live system or export the full chain to check completeness.",
    );
    out.push(
      "Membership of non-adjacent events in the chain is proven only relative to the chain head: " +
        `confirm that the live chain still verifies and that its event at seq ${manifest.chainHead.seq} ` +
        `has hash ${manifest.chainHead.hash} (GET /api/audit/verify?anchorSeq=...&anchorHash=...).`,
    );
  }
  out.push(
    "Event contents are what the source reported, as recorded by Afe; the export proves they were not changed since.",
  );
  return out;
}
