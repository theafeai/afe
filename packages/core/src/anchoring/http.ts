/**
 * Outbound POST for anchors (webhook, TSA), following docs/security/rules.md
 * R6: the URL is validated before every request (createSafeLookup is not
 * invoked for IP-literal hosts), the connection re-checks the resolved
 * address, redirects are never followed, and there is a timeout and a
 * response size limit. Response bodies are never put in error messages.
 */
import http from "node:http";
import https from "node:https";
import {
  createSafeLookup,
  validateOutboundUrl,
  type OutboundUrlPolicy,
} from "../security/outbound-url.ts";

export interface AnchorHttpOptions {
  policy: OutboundUrlPolicy;
  /** Connect + response timeout. Default 10s. */
  timeoutMs?: number;
  /** Maximum response body size. Default 64 KiB. */
  maxResponseBytes?: number;
}

export async function postBytes(
  target: string,
  body: Uint8Array,
  headers: Record<string, string>,
  options: AnchorHttpOptions,
  what: string,
): Promise<{ status: number; body: Buffer }> {
  const url = await validateOutboundUrl(target, options.policy);
  const transport = url.protocol === "https:" ? https : http;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const max = options.maxResponseBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(body.length), "user-agent": "afe-anchor" },
        lookup: createSafeLookup(options.policy) as never,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > max) {
            req.destroy(new Error(`${what} response is larger than ${max} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", (err) => reject(new Error(`${what} request failed: ${err.message}`)));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`${what} timed out`)));
    req.on("error", (err) => reject(new Error(`${what} request failed: ${err.message}`)));
    req.end(body);
  });
}
