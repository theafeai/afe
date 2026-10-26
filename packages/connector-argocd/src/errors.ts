import { UnsafeUrlError } from "@afe/core/security";

export type ArgoCdErrorKind =
  /** Token missing, invalid, expired or deleted (HTTP 401). */
  | "unauthorized"
  /** Token valid but RBAC denies the request (HTTP 403). */
  | "forbidden"
  | "not_found"
  | "rate_limited"
  /** ArgoCD answered with a 5xx. */
  | "server_error"
  /** Unexpected status, including 3xx (redirects are never followed). */
  | "unexpected_status"
  /** Certificate not trusted, hostname mismatch, expired certificate. */
  | "tls"
  /** Refused by the outbound URL policy (private/blocked address). */
  | "unsafe_address"
  /** DNS failure, connection refused or reset. */
  | "unreachable"
  | "timeout"
  /** Response larger than the configured limit. */
  | "too_large"
  /** Body is not the JSON we expected, or the stream reported an error. */
  | "invalid_response"
  | "aborted";

/**
 * Error from the ArgoCD client. Messages never contain the token, request
 * headers or upstream response bodies (docs/security/rules.md R2.4, R6.5), so
 * they are safe to log and to show to the user.
 */
export class ArgoCdError extends Error {
  readonly kind: ArgoCdErrorKind;
  readonly status: number | undefined;
  /** Low-level code (e.g. `SELF_SIGNED_CERT_IN_CHAIN`), when known. */
  readonly code: string | undefined;

  constructor(
    kind: ArgoCdErrorKind,
    message: string,
    opts: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "ArgoCdError";
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
  }

  /** True for failures worth retrying with backoff. */
  get retryable(): boolean {
    return ["rate_limited", "server_error", "unreachable", "timeout"].includes(this.kind);
  }
}

const TLS_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "EPROTO",
]);

const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

const TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
]);

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && i < 6; i++) {
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

/** Maps a transport-level exception (undici/fetch, node:tls) to an `ArgoCdError`. */
export function toArgoCdError(err: unknown, host: string): ArgoCdError {
  if (err instanceof ArgoCdError) return err;
  for (const e of causeChain(err)) {
    if (e instanceof UnsafeUrlError || (e as { code?: string }).code === "EAFE_UNSAFE_ADDRESS") {
      return new ArgoCdError(
        "unsafe_address",
        `refusing to connect to ${host}: address not allowed by the outbound policy`,
        { code: "EAFE_UNSAFE_ADDRESS" },
      );
    }
    const code = (e as { code?: string }).code;
    const name = (e as { name?: string }).name;
    if (code && TLS_CODES.has(code)) {
      return new ArgoCdError(
        "tls",
        `TLS verification failed for ${host} (${code}); configure the server's CA certificate`,
        { code },
      );
    }
    if (code && TIMEOUT_CODES.has(code)) {
      return new ArgoCdError("timeout", `request to ${host} timed out`, { code });
    }
    if (name === "TimeoutError") return new ArgoCdError("timeout", `request to ${host} timed out`);
    if (code && UNREACHABLE_CODES.has(code)) {
      return new ArgoCdError("unreachable", `could not reach ${host} (${code})`, { code });
    }
    if (name === "AbortError") return new ArgoCdError("aborted", `request to ${host} aborted`);
  }
  return new ArgoCdError("unreachable", `could not reach ${host}`);
}

export function statusError(status: number, what: string): ArgoCdError {
  if (status === 401) {
    return new ArgoCdError("unauthorized", `${what}: token rejected (401)`, { status });
  }
  if (status === 403) {
    return new ArgoCdError("forbidden", `${what}: permission denied by ArgoCD RBAC (403)`, {
      status,
    });
  }
  if (status === 404) return new ArgoCdError("not_found", `${what}: not found (404)`, { status });
  if (status === 429)
    return new ArgoCdError("rate_limited", `${what}: rate limited (429)`, { status });
  if (status >= 500) {
    return new ArgoCdError("server_error", `${what}: ArgoCD server error (${status})`, { status });
  }
  if (status >= 300 && status < 400) {
    return new ArgoCdError(
      "unexpected_status",
      `${what}: unexpected redirect (${status}); redirects are not followed, use the final server URL`,
      { status },
    );
  }
  return new ArgoCdError("unexpected_status", `${what}: unexpected status ${status}`, { status });
}
