/**
 * Verifiable audit export (AFE-14): types and the `AuditExporter` extension
 * point (ADR 0002). Format and verification algorithm:
 * docs/export-verification.md.
 */
import type { CanonicalEvent } from "../event.ts";
import type { EventFilter } from "../event-filter.ts";

/** Version of the export container format (manifest + records). */
export const EXPORT_FORMAT_VERSION = 1 as const;

export type ExportFormat = "json" | "csv";

/** A position in a tenant's hash chain. seq 0 / GENESIS_HASH is the empty chain. */
export interface ChainHead {
  seq: number;
  hash: string;
}

/** One exported event, optionally with its raw source payload bytes. */
export interface ExportRecord {
  event: CanonicalEvent;
  rawPayload?: { contentType: string; body: Uint8Array } | null;
}

export interface ExportSignature {
  algorithm: "ed25519";
  /** First 16 hex characters of SHA-256 of the raw public key. */
  keyId: string;
  /** Raw 32-byte Ed25519 public key, base64url. Trust it only if it matches a key you hold. */
  publicKey: string;
  /** Signature over UTF-8(JCS(manifest without `signature`)), base64url. */
  value: string;
}

/**
 * The integrity proof that accompanies every export. It is the last record of
 * the export file. Every member except `signature` is covered by the
 * signature, when present.
 */
export interface ExportManifest {
  afeExport: typeof EXPORT_FORMAT_VERSION;
  exportId: string;
  tenantId: string;
  /** When the export snapshot was taken (ISO 8601 UTC). */
  createdAt: string;
  format: ExportFormat;
  /** The normalised filter that selected the events (`{}` = everything). */
  filter: EventFilter;
  /** Records are always in ascending chain order. */
  order: "seq_asc";
  count: number;
  firstSeq: number | null;
  lastSeq: number | null;
  /** True if the exported seqs form one gap-free range. */
  contiguous: boolean;
  /** True if the export is unfiltered and holds the whole chain, seq 1 to `chainHead`. */
  completeChain: boolean;
  /** The tenant's chain head in the same database snapshot the events were read from. */
  chainHead: ChainHead;
  includesRawPayloads: boolean;
  hashAlgorithm: "sha-256";
  canonicalization: "rfc8785";
  /** SHA-256 over "<seq> <hash>\n" of every exported event, in order (format-independent). */
  eventsSha256: string;
  /** SHA-256 over the exact bytes of the export file before the manifest record. */
  contentSha256: string;
  signature?: ExportSignature;
}

/** Signs export manifests. OSS default: Ed25519 from `AFE_EXPORT_SIGNING_KEY`. */
export interface ExportSigner {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  /** Raw public key, base64url. */
  readonly publicKey: string;
  /** Returns the base64url signature of `data`. */
  sign(data: Uint8Array): string | Promise<string>;
}

export interface AuditExportRequest {
  tenantId: string;
  format: string;
  filter: EventFilter;
  /** Chain head read in the same snapshot as `records`. */
  chainHead: ChainHead;
  exportId: string;
  createdAt: Date;
  includeRawPayloads: boolean;
  /** Selected events in ascending seq order. */
  records: AsyncIterable<ExportRecord> | Iterable<ExportRecord>;
}

export interface AuditExportResult {
  contentType: string;
  /** Suggested file extension, without a leading dot. */
  fileExtension: string;
  /** UTF-8 text chunks; the manifest is written last. */
  chunks: AsyncIterable<string>;
}

/**
 * Audit export extension point (ADR 0002). OSS default:
 * `createDefaultAuditExporter` (CSV/JSON with integrity proof). The hosted
 * product can supply e.g. signed PDF evidence packs or SIEM streaming.
 */
export interface AuditExporter {
  readonly formats: readonly string[];
  export(request: AuditExportRequest): AuditExportResult;
}
