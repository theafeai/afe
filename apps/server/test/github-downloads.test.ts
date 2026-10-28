import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { Secret } from "@afe/core/security";
import { githubArchiveUrl, registerGitHubDownloads } from "../src/actions/github-downloads.ts";
import type { GitHubOperations } from "../src/actions/github-operations.ts";
const transfer = vi.hoisted(() => vi.fn());
vi.mock("undici", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  fetch: transfer,
}));
vi.mock("@afe/core/security", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  validateOutboundUrl: vi.fn(async (url: string) => new URL(url)),
}));
let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function setup({ expired = false, completed = true } = {}) {
  const scope = {
    tid: "default",
    uid: "alice",
    path: "/repos/acme/app",
    token: { secret: new Secret("never-forward-this-token") },
  };
  const service = {
    scope: vi.fn(async () => scope),
    require: vi.fn(),
    request: vi.fn(async () => ({ data: { id: 88, expired } })),
    run: vi.fn(async () => ({
      id: 123,
      status: completed ? "completed" : "in_progress",
      run_attempt: 2,
    })),
    guarded: async (fn: () => Promise<unknown>) => fn(),
  } as unknown as GitHubOperations;
  app = Fastify();
  registerGitHubDownloads(app, service);
  return app;
}
it("proxies an artifact without forwarding the GitHub credential to archive storage", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://public.blob.core.windows.net/artifacts/build.zip?sig=fixture",
          },
        }),
    ),
  );
  transfer.mockResolvedValue(new Response(new Uint8Array([80, 75, 3, 4])));
  const response = await setup().inject({
    url: "/api/actions/github/repositories/acme/app/download?kind=artifact&id=88&connectionId=c",
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("application/zip");
  expect(response.headers["content-disposition"]).toContain("attachment");
  expect(transfer.mock.calls[0]![1]).not.toHaveProperty("headers");
  expect(transfer.mock.calls[0]![1].redirect).toBe("manual");
  expect(response.body).not.toContain("never-forward");
});
it("keeps archived attempts separate and refuses completed-only downloads for an active run", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const response = await setup({ completed: false }).inject({
    url: "/api/actions/github/repositories/acme/app/download?kind=logs&id=123&attempt=2&connectionId=c",
  });
  expect(response.statusCode).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
});
it("returns a useful expired-artifact response without following an outbound URL", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const response = await setup({ expired: true }).inject({
    url: "/api/actions/github/repositories/acme/app/download?kind=artifact&id=88&connectionId=c",
  });
  expect(response.statusCode).toBe(410);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  "http://public.blob.core.windows.net/x",
  "https://attacker.example/x",
  "https://user:pass@public.blob.core.windows.net/x",
  "https://public.blob.core.windows.net:8443/x",
  "https://127.0.0.1/x",
])("rejects unsafe archive destinations: %s", (url) =>
  expect(() => githubArchiveUrl(url)).toThrow(),
);
it("bounds archive size and never follows an additional redirect", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://public.blob.core.windows.net/x" },
        }),
    ),
  );
  transfer.mockResolvedValue(
    new Response("x", { headers: { "content-length": String(11 * 1024 * 1024 * 1024) } }),
  );
  expect(
    (
      await setup().inject({
        url: "/api/actions/github/repositories/acme/app/download?kind=artifact&id=88&connectionId=c",
      })
    ).statusCode,
  ).toBe(413);
});

it("downloads a completed historical attempt while a newer attempt is active", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://public.blob.core.windows.net/old-attempt.zip" },
        }),
    ),
  );
  transfer.mockResolvedValue(new Response(new Uint8Array([80, 75, 3, 4])));
  const response = await setup({ completed: false }).inject({
    url: "/api/actions/github/repositories/acme/app/download?kind=logs&id=123&attempt=1&connectionId=c",
  });
  expect(response.statusCode).toBe(200);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/attempts/1/logs"),
    expect.anything(),
  );
});
