import { REDACTED, Secret } from "./secret.ts";

/**
 * Header names whose values must never be logged.
 * Lower-case, as Node delivers incoming header names.
 */
export const SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-vercel-signature",
  "x-argocd-signature",
  "x-api-key",
  "x-afe-token",
  "x-afe-signature",
] as const;

/**
 * Object keys whose values are treated as secret wherever they appear. Matched
 * case-insensitively after removing `_` and `-`.
 */
export const SENSITIVE_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "authtoken",
  "apikey",
  "apitoken",
  "privatekey",
  "clientsecret",
  "webhooksecret",
  "encryptionkey",
  "authorization",
  "cookie",
  "ciphertext",
  "wrappedkey",
  "credential",
  "credentials",
] as const;

const SENSITIVE_KEY_SET: ReadonlySet<string> = new Set(SENSITIVE_KEYS);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(normalizeKey(key));
}

/**
 * Paths for the pino/Fastify `redact` option. Covers request/response headers
 * on Fastify's request/response log objects, and common secret-bearing keys at
 * the top level and one level deep of any logged object.
 * Wildcard paths only match one level; never log whole config or credential
 * objects in the first place (see docs/security/rules.md).
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_HEADERS.flatMap((h) => [
    `req.headers["${h}"]`,
    `request.headers["${h}"]`,
    `res.headers["${h}"]`,
    `headers["${h}"]`,
  ]),
  ...[
    "password",
    "secret",
    "token",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "apiKey",
    "api_key",
    "privateKey",
    "private_key",
    "clientSecret",
    "client_secret",
    "webhookSecret",
    "webhook_secret",
    "encryptionKey",
    "authorization",
    "ciphertext",
    "wrappedKey",
  ].flatMap((k) => [k, `*.${k}`]),
];

/** Ready-to-use pino/Fastify `redact` option. */
export const LOG_REDACT_OPTIONS = { paths: [...LOG_REDACT_PATHS], censor: REDACTED } as const;

/**
 * Returns a deep copy of `value` with sensitive keys replaced by `[REDACTED]`
 * and `Secret` instances rendered redacted. For logging structured data or
 * error context outside pino, and for scrubbing payloads before storing them.
 * Does not mutate its input. Cycles are rendered as `[Circular]`.
 */
export function redactDeep(value: unknown, extraKeys: readonly string[] = []): unknown {
  const extra = new Set(extraKeys.map(normalizeKey));
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v instanceof Secret) return REDACTED;
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      out[k] = isSensitiveKey(k) || extra.has(normalizeKey(k)) ? REDACTED : walk(inner);
    }
    return out;
  };
  return walk(value);
}

/** Redacts sensitive header values in a header map (e.g. before storing a raw delivery). */
export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[] | undefined> {
  const sensitive = new Set<string>(SENSITIVE_HEADERS);
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = sensitive.has(k.toLowerCase()) && v !== undefined ? REDACTED : v;
  }
  return out;
}
