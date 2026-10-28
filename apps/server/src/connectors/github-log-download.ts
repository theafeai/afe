import { Agent, fetch as httpFetch } from "undici";
import { createSafeLookup, validateOutboundUrl, type OutboundUrlPolicy } from "@afe/core/security";
import type { FetchLike } from "@afe/connector-github";

export const MAX_JOB_LOG_BYTES = 2 * 1024 * 1024;
export class JobLogError extends Error {
  constructor(readonly code: "logs_unavailable" | "logs_too_large" | "logs_unsafe_destination") {
    super(code);
  }
}

/** Only source-issued GitHub Actions storage redirects, never event log_url values. */
export async function downloadGitHubJobLog(
  location: string,
  options: { fetch?: FetchLike; resolve?: OutboundUrlPolicy["resolve"] } = {},
): Promise<string> {
  const signal = AbortSignal.timeout(15_000);
  const agent = new Agent({
    connect: { lookup: createSafeLookup(options), timeout: 10_000 },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  let res: Response | undefined;
  try {
    let url: URL;
    try {
      url = new URL(location);
      if (url.port && url.port !== "443") throw new Error();
      if (
        !url.hostname.endsWith(".actions.githubusercontent.com") &&
        !url.hostname.endsWith(".blob.core.windows.net")
      )
        throw new Error();
      // Include DNS validation in the total deadline; safe lookup repeats it at connect time.
      await Promise.race([
        validateOutboundUrl(location, options),
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error()), { once: true }),
        ),
      ]);
    } catch {
      throw new JobLogError("logs_unsafe_destination");
    }
    // Deliberately no Authorization/Cookie headers, and no second redirect.
    const init = {
      method: "GET",
      headers: { accept: "text/plain", "accept-encoding": "identity" },
      redirect: "manual" as const,
      signal,
    };
    res = options.fetch
      ? await options.fetch(url.toString(), init)
      : ((await httpFetch(url, { ...init, dispatcher: agent })) as unknown as Response);
    if (res.status !== 200) throw new JobLogError("logs_unavailable");
    if (Number(res.headers.get("content-length")) > MAX_JOB_LOG_BYTES)
      throw new JobLogError("logs_too_large");
    // Plain-text per-job logs avoid downloading and expanding workflow ZIP archives.
    const type = res.headers.get("content-type") ?? "";
    if (/zip|gzip|html/i.test(type)) throw new JobLogError("logs_unavailable");
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_JOB_LOG_BYTES) throw new JobLogError("logs_too_large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    if (err instanceof JobLogError) throw err;
    throw new JobLogError("logs_unavailable");
  } finally {
    await res?.body?.cancel().catch(() => {});
    await agent.close();
  }
}
