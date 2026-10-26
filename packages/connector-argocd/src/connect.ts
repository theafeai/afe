import type { OutboundUrlPolicy } from "@afe/core/security";
import { ArgoCdClient, type TokenProvider } from "./client.ts";
import { createArgoCdTransport, type TransportOptions } from "./transport.ts";

/** Non-secret per-connection settings, stored in `connections.config`. */
export interface ArgoCdConnectionConfig {
  /** Normalised server URL; also the connection's `externalId`. */
  serverUrl: string;
  /** Extra CA certificate(s), PEM. Public data (rules.md R7.2). */
  caPem?: string | null;
}

export interface CreateClientOptions extends Omit<TransportOptions, "caPem" | "policy"> {
  config: ArgoCdConnectionConfig;
  token: TokenProvider;
  policy: OutboundUrlPolicy;
  timeoutMs?: number;
  maxResponseBytes?: number;
  retries?: number;
}

export interface ArgoCdClientHandle {
  client: ArgoCdClient;
  /** Releases the connection pool. Call when done (or keep one per connection). */
  close(): Promise<void>;
}

/** Production client for one ArgoCD connection: safe DNS lookup, connection CA, GET only. */
export function createArgoCdClient(options: CreateClientOptions): ArgoCdClientHandle {
  const transport = createArgoCdTransport({
    policy: options.policy,
    caPem: options.config.caPem ?? undefined,
    connectTimeoutMs: options.connectTimeoutMs,
    headersTimeoutMs: options.headersTimeoutMs,
    bodyTimeoutMs: options.bodyTimeoutMs,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
  });
  const client = new ArgoCdClient({
    serverUrl: options.config.serverUrl,
    token: options.token,
    get: transport.get,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    retries: options.retries,
  });
  return { client, close: () => transport.close() };
}
