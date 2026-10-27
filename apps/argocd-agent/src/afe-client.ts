/**
 * Signed requests from the agent to Afe (protocol v1, see
 * packages/connector-argocd/src/agent-protocol.ts). The secret is only used
 * to compute the HMAC; it is never sent and never logged.
 */
import { agentRequestHeaders } from "@afe/connector-argocd/agent-protocol";
import { HttpError, request } from "./http.ts";

export interface AfeClientOptions {
  /** Afe base URL, e.g. https://afe.example.com. */
  baseUrl: string;
  agentId: string;
  secret: () => Promise<string> | string;
  /** Extra CA (PEM) for Afe's certificate. */
  ca?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export interface AfeResult {
  status: number;
  body: Record<string, unknown> | null;
  /** From `Retry-After` (seconds), when present. */
  retryAfterMs?: number;
}

export class AfeClient {
  constructor(private readonly o: AfeClientOptions) {}

  /** POSTs a JSON body. Network errors throw `HttpError`; HTTP errors are returned. */
  async post(path: string, body: string): Promise<AfeResult> {
    const secret = await this.o.secret();
    const headers = agentRequestHeaders(
      this.o.agentId,
      secret,
      body,
      (this.o.now ?? (() => new Date()))(),
    );
    const res = await request({
      url: new URL(path, this.o.baseUrl).toString(),
      method: "POST",
      headers: { ...headers, accept: "application/json", "user-agent": "afe-argocd-agent" },
      body,
      ...(this.o.ca ? { ca: this.o.ca } : {}),
      timeoutMs: this.o.timeoutMs ?? 30_000,
    });
    let parsed: Record<string, unknown> | null = null;
    try {
      const text = await res.text(1024 * 1024);
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch (e) {
      if (e instanceof HttpError && e.kind !== "too_large") throw e;
      parsed = null;
    }
    const ra = Number(res.headers["retry-after"]);
    return {
      status: res.status,
      body: parsed,
      ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: Math.min(ra, 600) * 1000 } : {}),
    };
  }
}
