/**
 * OSS default `AuditExporter`: streams JSON Lines or CSV with an integrity
 * manifest as the final record. See docs/export-verification.md.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json.ts";
import { isEmptyFilter } from "../event-filter.ts";
import { csvRow, EXPORT_CSV_COLUMNS, eventToCsvCells, manifestCsvCells } from "./csv.ts";
import { signManifest } from "./signer.ts";
import {
  EXPORT_FORMAT_VERSION,
  type AuditExporter,
  type AuditExportRequest,
  type AuditExportResult,
  type ExportFormat,
  type ExportManifest,
  type ExportRecord,
  type ExportSigner,
} from "./types.ts";

export interface DefaultAuditExporterOptions {
  /** Signs manifests; null/absent produces unsigned exports. */
  signer?: ExportSigner | null;
}

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, { contentType: string; ext: string }> = {
  json: { contentType: "application/x-ndjson; charset=utf-8", ext: "afe.jsonl" },
  csv: { contentType: "text/csv; charset=utf-8", ext: "afe.csv" },
};

export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportFormatError";
  }
}

/** JSON Lines record of one event. */
export function eventJsonLine(record: ExportRecord, includeRaw: boolean): string {
  const obj: Record<string, unknown> = { recordType: "event", event: record.event };
  if (includeRaw && record.rawPayload) {
    obj.rawPayload = {
      contentType: record.rawPayload.contentType,
      base64: Buffer.from(
        record.rawPayload.body.buffer,
        record.rawPayload.body.byteOffset,
        record.rawPayload.body.byteLength,
      ).toString("base64"),
    };
  }
  return `${canonicalJson(obj)}\n`;
}

export function manifestJsonLine(manifest: ExportManifest): string {
  return `${canonicalJson({ recordType: "manifest", manifest })}\n`;
}

/** The line hashed into `eventsSha256` for each event. */
export function eventsDigestLine(seq: number, hash: string): string {
  return `${seq} ${hash}\n`;
}

const FLUSH_BYTES = 64 * 1024;

export function createDefaultAuditExporter(
  options: DefaultAuditExporterOptions = {},
): AuditExporter {
  const signer = options.signer ?? null;
  return {
    formats: ["json", "csv"],
    export(request: AuditExportRequest): AuditExportResult {
      if (request.format !== "json" && request.format !== "csv") {
        throw new ExportFormatError(`unsupported export format ${JSON.stringify(request.format)}`);
      }
      const format: ExportFormat = request.format;
      if (format === "csv" && request.includeRawPayloads) {
        throw new ExportFormatError("raw payloads can only be included in JSON exports");
      }
      return {
        contentType: EXPORT_CONTENT_TYPES[format].contentType,
        fileExtension: EXPORT_CONTENT_TYPES[format].ext,
        chunks: generate(request, format, signer),
      };
    },
  };
}

async function* generate(
  req: AuditExportRequest,
  format: ExportFormat,
  signer: ExportSigner | null,
): AsyncGenerator<string> {
  const content = createHash("sha256");
  const events = createHash("sha256");
  let buffer = "";
  const emit = (s: string) => {
    content.update(s, "utf8");
    buffer += s;
  };

  let count = 0;
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;
  let contiguous = true;

  if (format === "csv") emit(csvRow(EXPORT_CSV_COLUMNS));
  for await (const record of req.records) {
    const e = record.event;
    if (e.tenantId !== req.tenantId) throw new Error("export record from another tenant");
    if (lastSeq !== null && e.seq <= lastSeq)
      throw new Error("export records must be in ascending seq order");
    if (e.seq > req.chainHead.seq) throw new Error("export record is newer than the chain head");
    if (lastSeq !== null && e.seq !== lastSeq + 1) contiguous = false;
    firstSeq ??= e.seq;
    lastSeq = e.seq;
    count += 1;
    events.update(eventsDigestLine(e.seq, e.hash), "utf8");
    emit(
      format === "json"
        ? eventJsonLine(record, req.includeRawPayloads)
        : csvRow(eventToCsvCells(e)),
    );
    if (buffer.length >= FLUSH_BYTES) {
      yield buffer;
      buffer = "";
    }
  }

  let manifest: ExportManifest = {
    afeExport: EXPORT_FORMAT_VERSION,
    exportId: req.exportId,
    tenantId: req.tenantId,
    createdAt: req.createdAt.toISOString(),
    format,
    filter: req.filter,
    order: "seq_asc",
    count,
    firstSeq,
    lastSeq,
    contiguous,
    completeChain: isEmptyFilter(req.filter) && count === req.chainHead.seq,
    chainHead: { seq: req.chainHead.seq, hash: req.chainHead.hash },
    includesRawPayloads: req.includeRawPayloads,
    hashAlgorithm: "sha-256",
    canonicalization: "rfc8785",
    eventsSha256: events.digest("hex"),
    contentSha256: content.digest("hex"),
  };
  if (signer) manifest = await signManifest(manifest, signer);
  buffer +=
    format === "json"
      ? manifestJsonLine(manifest)
      : csvRow(manifestCsvCells(canonicalJson(manifest)));
  yield buffer;
}

/** Collects an export into one string (tests, small exports). */
export async function collectExport(result: AuditExportResult): Promise<string> {
  let out = "";
  for await (const chunk of result.chunks) out += chunk;
  return out;
}
