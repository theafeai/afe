import tls from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import { createSafeLookup, validateOutboundUrl, type OutboundUrlPolicy } from "@afe/core/security";

/** Minimal response shape the client needs; satisfied by fetch `Response`. */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}

export interface HttpGetInit {
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Long-lived streaming request (watch): no body idle timeout. */
  stream?: boolean;
}

/**
 * The only HTTP operation the ArgoCD connector has: GET. Injectable for tests.
 * There is deliberately no way to issue another method (rules.md R1.4).
 */
export type HttpGet = (url: URL, init: HttpGetInit) => Promise<HttpResponse>;

export interface TransportOptions {
  /** Outbound policy; the same one used by `validateOutboundUrl` when saving. */
  policy: OutboundUrlPolicy;
  /**
   * Extra trusted CA certificates (PEM) for this connection, e.g. a private CA
   * or a self-signed ArgoCD certificate. Added to the default roots; TLS
   * verification is never disabled (rules.md R7).
   */
  caPem?: string;
  /** TCP+TLS connect timeout; default 10 s. */
  connectTimeoutMs?: number;
  /** Time to receive response headers; default 30 s. */
  headersTimeoutMs?: number;
  /** Max idle time between body chunks for normal requests; default 30 s. */
  bodyTimeoutMs?: number;
  /**
   * Max idle time between chunks on watch streams; default 0 (disabled). The
   * watch consumer (AFE-10) is expected to run its own watchdog and reconnect.
   */
  streamIdleTimeoutMs?: number;
}

function defaultRoots(): string[] {
  // `getCACertificates("default")` includes NODE_EXTRA_CA_CERTS (and the system
  // store when Node runs with --use-system-ca); `rootCertificates` is the
  // bundled Mozilla store only. Passing `ca` replaces the defaults, so we must
  // include them explicitly.
  const get = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
  return get ? get("default") : [...tls.rootCertificates];
}

/** A closable `HttpGet` backed by undici with a per-connection TLS and DNS policy. */
export interface ArgoCdTransport {
  get: HttpGet;
  close(): Promise<void>;
}

/**
 * Builds the production transport: undici `fetch` with
 * - `connect.lookup = createSafeLookup(policy)`, re-checking the resolved address
 *   at connect time (DNS rebinding, rules.md R6.1);
 * - `connect.ca` = default roots + the connection's CA bundle (R7.2);
 * - `redirect: "manual"`: redirects are never followed (R6.3);
 * - connect/headers/body timeouts (R6.4).
 */
export function createArgoCdTransport(options: TransportOptions): ArgoCdTransport {
  const ca = options.caPem ? [...defaultRoots(), options.caPem] : undefined;
  const connect = {
    lookup: createSafeLookup(options.policy),
    timeout: options.connectTimeoutMs ?? 10_000,
    ...(ca ? { ca } : {}),
  };
  const agent = new Agent({
    connect,
    headersTimeout: options.headersTimeoutMs ?? 30_000,
    bodyTimeout: options.bodyTimeoutMs ?? 30_000,
  });
  const streamAgent = new Agent({
    connect,
    headersTimeout: options.headersTimeoutMs ?? 30_000,
    bodyTimeout: options.streamIdleTimeoutMs ?? 0,
  });

  const get: HttpGet = async (url, init) => {
    // Node skips `lookup` when the host is an IP literal, so `createSafeLookup`
    // alone would not stop https://10.0.0.1/. Re-validate every request URL
    // (scheme, credentials, address class) before connecting.
    await validateOutboundUrl(url.href, options.policy);
    const res = await undiciFetch(url, {
      method: "GET",
      headers: init.headers,
      signal: init.signal,
      redirect: "manual",
      dispatcher: init.stream ? streamAgent : agent,
    });
    return res as unknown as HttpResponse;
  };

  return {
    get,
    async close() {
      await Promise.all([agent.close(), streamAgent.close()]);
    },
  };
}
