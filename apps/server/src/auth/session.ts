/**
 * Web UI sessions (ADR 0006): a stateless, HMAC-SHA256 signed cookie holding
 * the principal (never the token), an expiry and the session's CSRF token.
 *
 * Format: `v1.<base64url(JSON payload)>.<base64url(HMAC(key, "v1." + payload))>`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ROLES, type Principal, type Role } from "@afe/core";

export const SESSION_COOKIE = "afe_session";
export const CSRF_COOKIE = "afe_csrf";
export const CSRF_HEADER = "x-afe-csrf";
/** Session cookie path: only API requests need it. */
export const SESSION_COOKIE_PATH = "/api";

export interface SessionPayload {
  /** Principal id. */
  sub: string;
  tid: string;
  roles: Role[];
  /** How the principal authenticated at login (e.g. "token"). */
  via: string;
  name?: string;
  localUserId?: string;
  credentialVersion?: number;
  /** Issued at / expires at, epoch milliseconds. */
  iat: number;
  exp: number;
  /** CSRF token bound to this session (double-submit: also in the non-HttpOnly CSRF cookie). */
  csrf: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Derives the session HMAC key from a secret, with a purpose label. */
export function deriveSessionKey(...parts: string[]): Buffer {
  const h = createHmac("sha256", "afe-session-key-v1");
  for (const p of parts) h.update(p, "utf8").update("\0");
  return h.digest();
}

export class SessionCodec {
  readonly #key: Buffer;

  constructor(
    key: Buffer,
    readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {
    if (key.length < 32) throw new Error("session key must be at least 32 bytes");
    this.#key = key;
  }

  #mac(data: string): Buffer {
    return createHmac("sha256", this.#key).update(data).digest();
  }

  issue(principal: Principal): { cookie: string; payload: SessionPayload } {
    const now = this.clock();
    const payload: SessionPayload = {
      sub: principal.id,
      tid: principal.tenantId,
      roles: [...principal.roles],
      via: principal.kind,
      ...(principal.localUserId
        ? { localUserId: principal.localUserId, credentialVersion: principal.credentialVersion }
        : {}),
      ...(principal.name ? { name: principal.name } : {}),
      iat: now,
      exp: now + this.ttlMs,
      csrf: randomBytes(32).toString("base64url"),
    };
    const data = `v1.${b64(JSON.stringify(payload))}`;
    return { cookie: `${data}.${b64(this.#mac(data))}`, payload };
  }

  /** Returns the payload of a valid, unexpired cookie, else null. Never throws. */
  verify(cookie: string | undefined): SessionPayload | null {
    if (!cookie || cookie.length > 4096) return null;
    const parts = cookie.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const data = `${parts[0]}.${parts[1]}`;
    let sig: Buffer;
    try {
      sig = Buffer.from(parts[2]!, "base64url");
    } catch {
      return null;
    }
    const expected = this.#mac(data);
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    let p: unknown;
    try {
      p = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!isPayload(p)) return null;
    if (p.exp <= this.clock()) return null;
    return p;
  }
}

function isPayload(p: unknown): p is SessionPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.sub === "string" &&
    typeof o.tid === "string" &&
    o.tid !== "" &&
    typeof o.via === "string" &&
    typeof o.iat === "number" &&
    typeof o.exp === "number" &&
    typeof o.csrf === "string" &&
    o.csrf.length >= 32 &&
    Array.isArray(o.roles) &&
    o.roles.every((r) => (ROLES as readonly unknown[]).includes(r))
  );
}

export function sessionPrincipal(p: SessionPayload): Principal {
  return {
    id: p.sub,
    tenantId: p.tid,
    roles: [...p.roles],
    kind: "session",
    ...(p.localUserId
      ? { localUserId: p.localUserId, credentialVersion: p.credentialVersion }
      : {}),
    ...(p.name ? { name: p.name } : {}),
  };
}

/** Parses a Cookie header. Later duplicates do not override the first value. */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join(";") : header;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export interface CookieOptions {
  path: string;
  maxAgeSec: number;
  httpOnly: boolean;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  return [
    `${name}=${value}`,
    `Path=${o.path}`,
    `Max-Age=${o.maxAgeSec}`,
    ...(o.maxAgeSec === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    ...(o.httpOnly ? ["HttpOnly"] : []),
    "SameSite=Lax",
    ...(o.secure ? ["Secure"] : []),
  ].join("; ");
}
