import { describe, expect, it } from "vitest";
import { Secret } from "@afe/core/security";
import {
  GitHubApiError,
  GitHubAppClient,
  GitHubRateLimitError,
  isContainedStatus,
  parseComparison,
  type FetchLike,
} from "../src/index.ts";
import { fakeGitHub, json, testKeyPair } from "./fixtures.ts";

const { privatePem } = testKeyPair();
const X = "a".repeat(40);
const L = "b".repeat(40);
const PATH = `/repos/acme/web/compare/${X}...${L}`;

function installation(fetch: FetchLike) {
  return new GitHubAppClient(
    { appId: "77", privateKey: new Secret(privatePem) },
    { fetch, sleep: async () => {}, maxRetries: 0 },
  ).installation(4242);
}

const tokenRoute = () =>
  json(201, {
    token: "ghs_TOKEN",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { contents: "read", metadata: "read" },
  });

describe("compareCommits (AFE-22)", () => {
  it("calls the compare endpoint with one commit per page and keeps only status and counts", async () => {
    const gh = fakeGitHub({
      "POST /app/installations/4242/access_tokens": tokenRoute,
      [`GET ${PATH}`]: () =>
        json(200, {
          status: "ahead",
          ahead_by: 4,
          behind_by: 0,
          merge_base_commit: { sha: X },
          commits: [{ commit: { message: "hello" } }],
        }),
    });
    const result = await installation(gh.fetch).compareCommits("acme", "web", X, L);
    expect(result).toEqual({ status: "ahead", aheadBy: 4, behindBy: 0, mergeBaseSha: X });
    const req = gh.requests.at(-1)!;
    expect(new URL(req.url).searchParams.get("per_page")).toBe("1");
    expect(req.headers.authorization).toBe("Bearer ghs_TOKEN");
  });

  it("maps statuses to containment", () => {
    expect(isContainedStatus("ahead")).toBe(true);
    expect(isContainedStatus("identical")).toBe(true);
    expect(isContainedStatus("behind")).toBe(false);
    expect(isContainedStatus("diverged")).toBe(false);
    expect(parseComparison({ status: "diverged", ahead_by: 2, behind_by: 3 })).toEqual({
      status: "diverged",
      aheadBy: 2,
      behindBy: 3,
      mergeBaseSha: null,
    });
    expect(() => parseComparison({ status: "weird" })).toThrow(/unexpected compare status/);
    expect(() => parseComparison(null)).toThrow();
  });

  it("raises 404 for an unknown commit and rate-limit errors with retryAfter", async () => {
    const gh = fakeGitHub({ "POST /app/installations/4242/access_tokens": tokenRoute });
    const client = installation(gh.fetch);
    const err = await client.compareCommits("acme", "web", X, L).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(404);

    const limited = fakeGitHub({
      "POST /app/installations/4242/access_tokens": tokenRoute,
      [`GET ${PATH}`]: () =>
        json(
          403,
          { message: "API rate limit exceeded" },
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
          },
        ),
    });
    const rl = await installation(limited.fetch)
      .compareCommits("acme", "web", X, L)
      .catch((e: unknown) => e);
    expect(rl).toBeInstanceOf(GitHubRateLimitError);
  });

  it("refuses anything but hex SHAs in the path", async () => {
    const gh = fakeGitHub({ "POST /app/installations/4242/access_tokens": tokenRoute });
    const client = installation(gh.fetch);
    for (const [base, head] of [
      ["main", L],
      [X, "../../x"],
      [X, "abc"],
    ]) {
      await expect(client.compareCommits("acme", "web", base!, head!)).rejects.toThrow(
        /invalid commit SHA/,
      );
    }
    expect(gh.requests).toHaveLength(0);
  });
});
