import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Secret } from "@afe/core/security";
import {
  GITHUB_API_VERSION,
  GitHubApiError,
  GitHubAppClient,
  GitHubHttp,
  GitHubNetworkError,
  GitHubRateLimitError,
  REQUIRED_PERMISSIONS,
  SUBSCRIBED_EVENTS,
  OPTIONAL_SUBSCRIBED_EVENTS,
  applyRepositoryChange,
  buildAppManifest,
  checkPermissions,
  connectionConfig,
  convertManifestCode,
  describePermissionProblems,
  nextPageUrl,
  readOnlyTokenPermissions,
  type FetchLike,
  type GitHubInstallation,
} from "../src/index.ts";
import { fakeGitHub, installationFixture, json, testKeyPair } from "./fixtures.ts";

const { privatePem } = testKeyPair();
const noSleep = async () => {};

function tokenRoute(perms: Record<string, string> = { actions: "read" }) {
  return () =>
    json(201, {
      token: "ghs_INSTALLATION_TOKEN",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: perms,
      repository_selection: "selected",
    });
}

function client(fetch: FetchLike) {
  return new GitHubAppClient(
    { appId: "77", privateKey: new Secret(privatePem) },
    { fetch, sleep: noSleep },
  );
}

describe("GitHub REST client", () => {
  it("sends User-Agent, API version and App JWT; reads an installation", async () => {
    const gh = fakeGitHub({
      "GET /app/installations/4242": () => json(200, installationFixture()),
    });
    const inst = await client(gh.fetch).getInstallation(4242);
    expect(inst.account?.login).toBe("acme");
    const req = gh.requests[0]!;
    expect(req.headers["user-agent"]).toBe("afe-github-connector");
    expect(req.headers["x-github-api-version"]).toBe(GITHUB_API_VERSION);
    expect(req.headers.accept).toBe("application/vnd.github+json");
    expect(req.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("mints narrowed installation tokens once and paginates repositories via Link", async () => {
    const page2 = "https://api.github.com/installation/repositories?per_page=2&page=2";
    const gh = fakeGitHub({
      "POST /app/installations/4242/access_tokens": tokenRoute(),
      "GET /installation/repositories": (req) =>
        new URL(req.url).searchParams.get("page") === "2"
          ? json(200, { total_count: 3, repositories: [{ id: 3, name: "c", full_name: "acme/c" }] })
          : json(
              200,
              {
                total_count: 3,
                repositories: [
                  { id: 1, name: "a", full_name: "acme/a" },
                  { id: 2, name: "b", full_name: "acme/b" },
                ],
              },
              { link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
            ),
    });
    const inst = client(gh.fetch).installation(4242, {
      tenantId: "default",
      permissions: { actions: "read", metadata: "read" },
    });
    const repos = await inst.listRepositories({ perPage: 2 });
    expect(repos.map((r) => r.full_name)).toEqual(["acme/a", "acme/b", "acme/c"]);
    const mints = gh.requests.filter((r) => r.method === "POST");
    expect(mints).toHaveLength(1);
    expect(mints[0]!.body).toEqual({ permissions: { actions: "read", metadata: "read" } });
    const reads = gh.requests.filter((r) => r.method === "GET");
    expect(reads.map((r) => r.headers.authorization)).toEqual([
      "Bearer ghs_INSTALLATION_TOKEN",
      "Bearer ghs_INSTALLATION_TOKEN",
    ]);
    expect(new URL(reads[0]!.url).searchParams.get("per_page")).toBe("2");
  });

  it("lists workflow runs, deployments and statuses with GET only", async () => {
    const gh = fakeGitHub({
      "POST /app/installations/1/access_tokens": tokenRoute(),
      "GET /repos/acme/api/actions/runs": () =>
        json(200, {
          total_count: 1,
          workflow_runs: [{ id: 10, event: "push", head_sha: "a".repeat(40) }],
        }),
      "GET /repos/acme/api/deployments": () => json(200, [{ id: 20, environment: "production" }]),
      "GET /repos/acme/api/deployments/20/statuses": () =>
        json(200, [{ id: 30, state: "success" }]),
    });
    const inst = client(gh.fetch).installation(1);
    const runs = await inst.listWorkflowRuns("acme", "api", { created: ">=2026-10-01" });
    expect(runs[0]!.id).toBe(10);
    expect(new URL(gh.requests[1]!.url).searchParams.get("created")).toBe(">=2026-10-01");
    expect((await inst.listDeployments("acme", "api"))[0]!.environment).toBe("production");
    expect((await inst.listDeploymentStatuses("acme", "api", 20))[0]!.state).toBe("success");
    // Read-only: the only non-GET is minting the installation token.
    const nonGet = gh.requests.filter((r) => r.method !== "GET");
    expect(nonGet.map((r) => new URL(r.url).pathname)).toEqual([
      "/app/installations/1/access_tokens",
    ]);
  });

  it("stops at maxPages and refuses pagination links to another host", async () => {
    const gh = fakeGitHub({
      "POST /app/installations/1/access_tokens": tokenRoute(),
      "GET /repos/acme/api/deployments": () =>
        json(200, [{ id: 1 }], {
          link: '<https://evil.example/repos/acme/api/deployments?page=2>; rel="next"',
        }),
    });
    await expect(client(gh.fetch).installation(1).listDeployments("acme", "api")).rejects.toThrow(
      /another host/,
    );
    const gh2 = fakeGitHub({
      "POST /app/installations/1/access_tokens": tokenRoute(),
      "GET /repos/acme/api/deployments": () =>
        json(200, [{ id: 1 }], {
          link: '<https://api.github.com/repos/acme/api/deployments?page=2>; rel="next"',
        }),
    });
    const deps = await client(gh2.fetch)
      .installation(1)
      .listDeployments("acme", "api", {}, { maxPages: 3 });
    expect(deps).toHaveLength(3);
  });

  it("maps rate limits to GitHubRateLimitError and does not call while exhausted", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const gh = fakeGitHub({
      "GET /app/installations/1": () =>
        json(
          403,
          { message: "API rate limit exceeded" },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          },
        ),
    });
    const c = client(gh.fetch);
    const err = await c.getInstallation(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfter.getTime()).toBe(reset * 1000);
    await expect(c.getInstallation(1)).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(gh.requests).toHaveLength(1);
    expect(c.http.rateLimit("app")?.remaining).toBe(0);

    const secondary = fakeGitHub({
      "GET /app/installations/1": () =>
        json(403, { message: "secondary rate limit" }, { "retry-after": "30" }),
    });
    const e2 = await client(secondary.fetch)
      .getInstallation(1)
      .catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(GitHubRateLimitError);
  });

  it("retries 5xx and network errors a bounded number of times", async () => {
    let calls = 0;
    const flaky = fakeGitHub({
      "GET /app/installations/1": () =>
        ++calls < 3 ? json(502, {}) : json(200, installationFixture({ id: 1 })),
    });
    expect((await client(flaky.fetch).getInstallation(1)).id).toBe(1);
    expect(calls).toBe(3);
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(client(down).getInstallation(1)).rejects.toBeInstanceOf(GitHubNetworkError);
  });

  it("raises GitHubApiError without echoing tokens", async () => {
    const gh = fakeGitHub({});
    const err = (await client(gh.fetch)
      .getInstallation(9)
      .catch((e: unknown) => e)) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(404);
    expect(err.message).not.toMatch(/Bearer/);
  });

  it("converts a manifest code", async () => {
    const gh = fakeGitHub({
      "POST /app-manifests/abc/conversions": () => json(201, { id: 5, slug: "afe-x", pem: "p" }),
    });
    const conv = await convertManifestCode(new GitHubHttp({ fetch: gh.fetch }), "abc");
    expect(conv.slug).toBe("afe-x");
    expect(gh.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("parses Link headers", () => {
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl('<https://a/x?page=3>; rel="last"')).toBeNull();
    expect(nextPageUrl('<https://a/x?page=1>; rel="prev", <https://a/x?page=3>; rel="next"')).toBe(
      "https://a/x?page=3",
    );
  });
});

describe("permissions", () => {
  it("accepts exactly the required read permissions", () => {
    expect(checkPermissions({ ...REQUIRED_PERMISSIONS })).toEqual({
      ok: true,
      missing: [],
      writable: [],
      extra: [],
      optionalMissing: ["attestations", "contents", "packages", "pull_requests"],
    });
  });

  it("flags write access and missing read permissions", () => {
    const check = checkPermissions({ actions: "write", metadata: "read", contents: "read" });
    expect(check).toEqual({
      ok: false,
      missing: ["deployments", "environments"],
      writable: ["actions"],
      extra: ["contents"],
      optionalMissing: ["attestations", "packages", "pull_requests"],
    });
    expect(describePermissionProblems(check)).toBe(
      "write access granted (Afe needs read only): actions; missing read permission: deployments, environments",
    );
  });

  it("narrows token permissions to read", () => {
    expect(readOnlyTokenPermissions({ actions: "write", metadata: "read", x: "none" })).toEqual({
      actions: "read",
      metadata: "read",
    });
  });
});

describe("manifest and connection config", () => {
  it("the shipped app-manifest.json matches the generated manifest", () => {
    const file = JSON.parse(
      readFileSync(new URL("../app-manifest.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(file).toEqual(buildAppManifest({ publicUrl: "https://afe.example.com/" }));
  });

  it("requests only read permissions", () => {
    const m = buildAppManifest({ publicUrl: "https://x" });
    expect(new Set(Object.values(m.default_permissions))).toEqual(new Set(["read"]));
    expect(m.default_events).toEqual([...SUBSCRIBED_EVENTS, ...OPTIONAL_SUBSCRIBED_EVENTS]);
    expect(m.public).toBe(false);
  });

  it("builds config and applies repository changes", () => {
    const inst = installationFixture() as unknown as GitHubInstallation;
    const cfg = connectionConfig(inst, [
      { id: 2, full_name: "acme/b" },
      { id: 1, full_name: "acme/a" },
    ]);
    expect(cfg.repositories).toEqual([
      { id: 1, fullName: "acme/a" },
      { id: 2, fullName: "acme/b" },
    ]);
    const after = applyRepositoryChange(cfg.repositories, {
      action: "added",
      installation: inst,
      repository_selection: "selected",
      repositories_added: [{ id: 3, name: "c", full_name: "acme/c" }],
      repositories_removed: [{ id: 1, name: "a", full_name: "acme/a" }],
    });
    expect(after).toEqual([
      { id: 2, fullName: "acme/b" },
      { id: 3, fullName: "acme/c" },
    ]);
    expect(
      applyRepositoryChange(after, {
        action: "added",
        installation: inst,
        repository_selection: "all",
        repositories_added: [],
        repositories_removed: [],
      }),
    ).toBe("all");
  });
});
