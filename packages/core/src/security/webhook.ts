import { createHmac, timingSafeEqual } from "node:crypto";
import { type Secret, revealIfSecret } from "./secret.ts";

export type HmacAlgorithm = "sha256" | "sha1";

const HEX_LENGTH: Record<HmacAlgorithm, number> = { sha256: 64, sha1: 40 };

export interface VerifyHmacOptions {
  /** The raw request body exactly as received. Never a re-serialised JSON object. */
  payload: Buffer | string;
  secret: string | Buffer | Secret<string>;
  /** The signature header value as received (may be undefined/array if absent/duplicated). */
  signature: string | string[] | undefined | null;
  algorithm: HmacAlgorithm;
  /** Required literal prefix, e.g. `sha256=` for GitHub. */
  prefix?: string;
}

/**
 * Verifies a hex HMAC signature over the raw body.
 *
 * Returns false (never throws) for a missing, duplicated, malformed or wrong
 * signature. The expected and received digests are compared with
 * `crypto.timingSafeEqual`. Malformed input is rejected before the comparison
 * based only on public facts (the prefix and the fixed digest length for the
 * algorithm), so no information about the expected digest leaks through timing.
 */
export function verifyHmacSignature(options: VerifyHmacOptions): boolean {
  const { signature, algorithm } = options;
  const prefix = options.prefix ?? "";
  if (typeof signature !== "string") return false;
  if (!signature.startsWith(prefix)) return false;
  const received = signature.slice(prefix.length).toLowerCase();
  if (received.length !== HEX_LENGTH[algorithm] || !/^[0-9a-f]+$/.test(received)) return false;

  const secret = revealIfSecret(options.secret);
  if (secret.length === 0) return false; // an unset secret must never verify
  const expected = createHmac(algorithm, secret).update(options.payload).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}

/** Computes a hex HMAC signature; for tests and fakes that emulate a provider. */
export function signHmac(
  algorithm: HmacAlgorithm,
  secret: string | Buffer | Secret<string>,
  payload: Buffer | string,
  prefix = "",
): string {
  return prefix + createHmac(algorithm, revealIfSecret(secret)).update(payload).digest("hex");
}

/**
 * GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`.
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 * The legacy SHA-1 `X-Hub-Signature` header must not be accepted.
 */
export function verifyGitHubSignature(
  payload: Buffer | string,
  secret: string | Secret<string>,
  signatureHeader: string | string[] | undefined | null,
): boolean {
  return verifyHmacSignature({
    payload,
    secret,
    signature: signatureHeader,
    algorithm: "sha256",
    prefix: "sha256=",
  });
}

/**
 * Vercel: `x-vercel-signature: <hex HMAC-SHA1 of the raw body>`, keyed with the
 * webhook secret (or the integration client secret for integration webhooks).
 * https://vercel.com/docs/webhooks/webhooks-api#securing-webhooks
 */
export function verifyVercelSignature(
  payload: Buffer | string,
  secret: string | Secret<string>,
  signatureHeader: string | string[] | undefined | null,
): boolean {
  return verifyHmacSignature({ payload, secret, signature: signatureHeader, algorithm: "sha1" });
}

/**
 * Checks a sender-supplied timestamp is within `toleranceMs` of `now`. Use it in
 * addition to delivery-id deduplication when a source puts a timestamp inside
 * the signed payload (e.g. Vercel's `createdAt`), so old captured deliveries are
 * rejected even after the delivery-id record has been pruned.
 */
export function isTimestampFresh(
  timestampMs: number,
  toleranceMs: number,
  now: number = Date.now(),
): boolean {
  return Number.isFinite(timestampMs) && Math.abs(now - timestampMs) <= toleranceMs;
}

export interface DeliveryRecord {
  /** Null when the tenant is not yet known (e.g. a GitHub App hook before installation lookup). */
  tenantId: string | null;
  /** e.g. `github`, `vercel`, `argocd`. */
  source: string;
  /** The provider's unique delivery id (GitHub `X-GitHub-Delivery`, Vercel payload `id`). */
  deliveryId: string;
  receivedAt?: Date;
}

/**
 * Rejects replayed webhook deliveries. `recordDelivery` atomically records the
 * delivery and returns true the first time a (source, deliveryId) is seen, and
 * false for every later attempt. Call it only after the signature is verified.
 */
export interface ReplayGuard {
  recordDelivery(record: DeliveryRecord): Promise<boolean>;
}

/** In-memory `ReplayGuard` for tests and single-process tooling. Not for production. */
export class InMemoryReplayGuard implements ReplayGuard {
  readonly #seen = new Set<string>();

  async recordDelivery(record: DeliveryRecord): Promise<boolean> {
    const key = JSON.stringify([record.source, record.deliveryId]);
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    return true;
  }
}
