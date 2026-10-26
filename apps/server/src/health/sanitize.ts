import { createHash } from "node:crypto";

const MAX_DETAIL = 500;

// Things that may carry credentials in an error message. Connectors must not
// pass them in the first place (HealthReporter docs); this is defence in depth,
// because gap details end up in the immutable audit log.
const PATTERNS: [RegExp, string][] = [
  // Authorization schemes followed by a credential.
  [/\b(bearer|basic|token|digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [REDACTED]"],
  // key=value / key: value pairs whose key looks secret.
  [
    /\b([A-Za-z_-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|signature|credential)[A-Za-z_-]*)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
    "$1$2[REDACTED]",
  ],
  // URL user-info and query strings.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi, "$1?[REDACTED]"],
  // Well-known token formats (GitHub, Slack, JWT).
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[REDACTED]"],
  // PEM blocks.
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, "[REDACTED]"],
  // Long opaque strings (hex/base64 tokens).
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[REDACTED]"],
];

/**
 * Makes a failure detail safe to store (health row, audit log, alerts):
 * removes control characters, redacts anything that looks like a credential,
 * collapses whitespace and truncates.
 */
export function sanitizeDetail(detail: string | null | undefined): string | null {
  if (detail == null) return null;
  // eslint-disable-next-line no-control-regex
  let s = String(detail).replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const [re, replacement] of PATTERNS) s = s.replace(re, replacement);
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_DETAIL) s = `${s.slice(0, MAX_DETAIL - 1)}…`;
  return s.length > 0 ? s : null;
}

/** Message of an unknown thrown value, sanitised. */
export function errorDetail(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return sanitizeDetail(raw) ?? "error";
}

/**
 * Deterministic UUID-formatted id (version nibble 8, RFC 9562 "custom") from
 * the given parts, so retries derive the same gap/alert id.
 */
export function deterministicId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
