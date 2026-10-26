/**
 * CSV form of an export (RFC 4180, CRLF line endings, UTF-8, no BOM).
 *
 * Every row carries the full canonical event in `canonical_json`, so the CSV
 * is exactly as verifiable as the JSON export. The other columns are a
 * readable projection derived from it by `eventToCsvCells`; the verifier
 * re-derives them and reports any difference, so editing a readable cell is
 * detected too.
 *
 * Spreadsheet formula injection: derived cells starting with = + - @ TAB or CR
 * are prefixed with a single quote (OWASP recommendation). `canonical_json`
 * always starts with "{" and is never altered.
 */
import { canonicalJson } from "../canonical-json.ts";
import type { ActorRef, CanonicalEvent } from "../event.ts";

export const EXPORT_CSV_COLUMNS = [
  "record_type",
  "seq",
  "id",
  "occurred_at",
  "recorded_at",
  "source",
  "action",
  "outcome",
  "actor_type",
  "actor_id",
  "actor_login",
  "actor_name",
  "on_behalf_of",
  "triggered_by",
  "target_type",
  "target_id",
  "target_name",
  "environment",
  "repository",
  "project",
  "application",
  "cluster",
  "namespace",
  "ref",
  "commit_shas",
  "trigger_type",
  "trigger_source_value",
  "observation_method",
  "source_event_id",
  "connection_id",
  "prev_hash",
  "hash",
  "canonical_json",
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

function cell(v: string | number | undefined | null): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return FORMULA_START.test(s) ? `'${s}` : s;
}

function who(ref: ActorRef | undefined): string {
  if (!ref) return "";
  return ref.login ?? ref.id ?? ref.type;
}

/** The readable cells of an event row (every column, in order). */
export function eventToCsvCells(e: CanonicalEvent): string[] {
  return [
    "event",
    cell(e.seq),
    cell(e.id),
    cell(e.occurredAt),
    cell(e.recordedAt),
    cell(e.source),
    cell(e.action),
    cell(e.outcome),
    cell(e.actor.type),
    cell(e.actor.id),
    cell(e.actor.login),
    cell(e.actor.name),
    cell(who(e.actor.onBehalfOf)),
    cell(who(e.actor.triggeredBy)),
    cell(e.target.type),
    cell(e.target.id),
    cell(e.target.name),
    cell(e.target.environment),
    cell(e.target.repository),
    cell(e.target.project),
    cell(e.target.application),
    cell(e.target.cluster),
    cell(e.target.namespace),
    cell(e.target.ref),
    cell((e.correlation.commitShas ?? []).join(" ")),
    cell(e.trigger.type),
    cell(e.trigger.sourceValue),
    cell(e.observation.method),
    cell(e.sourceEventId),
    cell(e.connectionId),
    cell(e.prevHash),
    cell(e.hash),
    canonicalJson(e),
  ];
}

/** The manifest row: record_type "manifest", the manifest JSON in canonical_json. */
export function manifestCsvCells(manifestJson: string): string[] {
  const cells: string[] = EXPORT_CSV_COLUMNS.map(() => "");
  cells[0] = "manifest";
  cells[cells.length - 1] = manifestJson;
  return cells;
}

function quote(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function csvRow(cells: readonly string[]): string {
  return `${cells.map(quote).join(",")}\r\n`;
}

export interface CsvRecord {
  cells: string[];
  /** Character offset in the input where the record starts. */
  start: number;
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

/** Strict RFC 4180 parser that also reports where each record starts. Accepts LF or CRLF. */
export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const start = i;
    const cells: string[] = [];
    for (;;) {
      let value = "";
      if (text[i] === '"') {
        i += 1;
        for (;;) {
          if (i >= n)
            throw new CsvParseError(`unterminated quoted field in record at offset ${start}`);
          const ch = text[i]!;
          if (ch === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          value += ch;
          i += 1;
        }
        if (i < n && text[i] !== "," && text[i] !== "\r" && text[i] !== "\n") {
          throw new CsvParseError(`unexpected character after quoted field at offset ${i}`);
        }
      } else {
        while (i < n && text[i] !== "," && text[i] !== "\r" && text[i] !== "\n") {
          if (text[i] === '"') throw new CsvParseError(`stray quote at offset ${i}`);
          value += text[i];
          i += 1;
        }
      }
      cells.push(value);
      if (i < n && text[i] === ",") {
        i += 1;
        continue;
      }
      break;
    }
    if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
    else if (text[i] === "\n") i += 1;
    else if (i < n) throw new CsvParseError(`unexpected character at offset ${i}`);
    records.push({ cells, start });
  }
  return records;
}
