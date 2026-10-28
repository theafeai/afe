import { describe, expect, it, vi } from "vitest";
import { downloadGitHubJobLog, MAX_JOB_LOG_BYTES } from "../src/connectors/github-log-download.ts";

const url = "https://productionresultssa0.blob.core.windows.net/log?sig=secret";
const resolve = async () => ["203.0.113.1"];
describe("bounded GitHub job log download", () => {
  it.each([
    "http://productionresultssa0.blob.core.windows.net/log",
    "https://evil.example/log",
    "https://productionresultssa0.blob.core.windows.net.evil.example/log",
    "https://user:secret@productionresultssa0.blob.core.windows.net/log",
    "https://productionresultssa0.blob.core.windows.net:444/log",
  ])("rejects unsafe destinations: %s", async (location) => {
    const fetch = vi.fn();
    await expect(downloadGitHubJobLog(location, { resolve, fetch })).rejects.toMatchObject({
      code: "logs_unsafe_destination",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects private DNS even on an allowed storage domain", async () => {
    const fetch = vi.fn();
    await expect(
      downloadGitHubJobLog(url, { resolve: async () => ["127.0.0.1"], fetch }),
    ).rejects.toMatchObject({ code: "logs_unsafe_destination" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not follow another redirect or echo the signed URL", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    );
    await expect(downloadGitHubJobLog(url, { resolve, fetch })).rejects.toThrow("logs_unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toBeDefined();
  });
  it("caps both declared and streamed bytes", async () => {
    for (const response of [
      new Response("small", { headers: { "content-length": String(MAX_JOB_LOG_BYTES + 1) } }),
      new Response("x".repeat(MAX_JOB_LOG_BYTES + 1)),
    ])
      await expect(
        downloadGitHubJobLog(url, { resolve, fetch: async () => response }),
      ).rejects.toMatchObject({ code: "logs_too_large" });
  });
  it("returns text without credentials and closes the response", async () => {
    let init: RequestInit | undefined;
    const text = await downloadGitHubJobLog(url, {
      resolve,
      fetch: async (_u, options) => {
        init = options;
        return new Response("hello\nworld");
      },
    });
    expect(text).toBe("hello\nworld");
    expect(init!.headers).toEqual({ accept: "text/plain", "accept-encoding": "identity" });
    expect(init!.redirect).toBe("manual");
  });
});
