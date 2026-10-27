/**
 * Minimal HTTP(S) client on `node:http`/`node:https` (no dependencies, so the
 * agent bundle is a single file). Never follows redirects, always verifies
 * TLS (an extra CA can be given, verification cannot be turned off), applies
 * a connect/idle timeout and limits buffered response bodies.
 */
import http from "node:http";
import https from "node:https";
import { rootCertificates } from "node:tls";

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Extra trusted CA certificates (PEM), added to Node's default roots. */
  ca?: string | Buffer;
  /** Socket idle timeout in ms (default 30 s). For watches, set above the server's watch timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body as a stream (for watches). Consume it, or call `text()`. */
  stream: AsyncIterable<Buffer>;
  /** Reads the whole body (at most `limit` bytes, default 64 MiB). */
  text(limit?: number): Promise<string>;
  /** Discards the body. */
  discard(): void;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "aborted" | "too_large",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Node's bundled roots plus the extra CA (a custom `ca` would otherwise replace the roots). */
function withDefaultRoots(ca: string | Buffer): (string | Buffer)[] {
  return [...rootCertificates, ca];
}

export function request(req: HttpRequest): Promise<HttpResponse> {
  const url = new URL(req.url);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) return reject(new HttpError("request aborted", "aborted"));
    const r = lib.request(
      url,
      {
        method: req.method ?? "GET",
        headers: {
          ...(req.body !== undefined ? { "content-length": Buffer.byteLength(req.body) } : {}),
          ...req.headers,
        },
        ...(isHttps && req.ca ? { ca: withDefaultRoots(req.ca) } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      },
      (res) => {
        const response: HttpResponse = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          stream: res,
          async text(limit = 64 * 1024 * 1024) {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of res as AsyncIterable<Buffer>) {
              size += chunk.length;
              if (size > limit) {
                res.destroy();
                throw new HttpError("response too large", "too_large");
              }
              chunks.push(chunk);
            }
            return Buffer.concat(chunks).toString("utf8");
          },
          discard() {
            res.resume();
          },
        };
        resolve(response);
      },
    );
    r.setTimeout(req.timeoutMs ?? 30_000, () => {
      r.destroy(new HttpError("request timed out", "timeout"));
    });
    r.on("error", (err) => {
      if (err instanceof HttpError) return reject(err);
      if (req.signal?.aborted) return reject(new HttpError("request aborted", "aborted"));
      // Only the error code: messages can contain URLs and addresses, never credentials.
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      reject(new HttpError(`request failed (${code})`, "network"));
    });
    if (req.body !== undefined) r.end(req.body);
    else r.end();
  });
}
