import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { revealIfSecret, type Secret } from "@afe/core/security";

/**
 * Signed, expiring `state` for the install and manifest redirects.
 *
 * The state names the tenant the installation will be connected to, so it
 * must not be forgeable (HMAC-SHA256) and must not be usable by anyone other
 * than the browser that started the flow: it carries the SHA-256 of a random
 * nonce that is also set as an HttpOnly cookie, and the callback requires
 * both. Without that binding an attacker could start a flow for their own
 * tenant and lure a victim into installing the App with the attacker's state.
 */
export type StatePurpose = "install" | "manifest";

export interface StatePayload {
  purpose: StatePurpose;
  tenantId: string;
  /** SHA-256 (base64url) of the browser-bound nonce. */
  nonceHash: string;
  /** Expiry, epoch ms. */
  exp: number;
}

export const STATE_TTL_MS = 15 * 60_000;

/** Derives the state signing key from an instance secret (domain-separated). */
export function deriveStateKey(material: string | Secret<string> | Buffer): Buffer {
  const ikm = Buffer.isBuffer(material) ? material : Buffer.from(revealIfSecret(material), "utf8");
  return Buffer.from(hkdfSync("sha256", ikm, "afe", "afe github redirect state v1", 32));
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

const hashNonce = (nonce: string) => createHash("sha256").update(nonce).digest("base64url");

export function signState(
  key: Buffer,
  p: { purpose: StatePurpose; tenantId: string; nonce: string },
  now: number = Date.now(),
): string {
  const payload: StatePayload = {
    purpose: p.purpose,
    tenantId: p.tenantId,
    nonceHash: hashNonce(p.nonce),
    exp: now + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export type StateCheck =
  | { ok: true; payload: StatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_purpose" | "nonce" };

export function verifyState(
  key: Buffer,
  state: unknown,
  expected: { purpose: StatePurpose; nonce: string | undefined },
  now: number = Date.now(),
): StateCheck {
  if (typeof state !== "string" || state.length > 2048) return { ok: false, reason: "malformed" };
  const [body, mac, extra] = state.split(".");
  if (!body || !mac || extra !== undefined) return { ok: false, reason: "malformed" };
  const expectedMac = createHmac("sha256", key).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== expectedMac.length || !timingSafeEqual(got, expectedMac)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, reason: "expired" };
  if (payload.purpose !== expected.purpose) return { ok: false, reason: "wrong_purpose" };
  if (!expected.nonce) return { ok: false, reason: "nonce" };
  const a = Buffer.from(hashNonce(expected.nonce));
  const b = Buffer.from(String(payload.nonceHash));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "nonce" };
  return { ok: true, payload };
}
