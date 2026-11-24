/**
 * Pieces of Sign in with GitHub that need no database (the full flow is
 * in github-sign-in.test.ts). No real GitHub API is called.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Secret } from "@afe/core/security";
import { safeNextPath } from "../src/auth/github-sign-in.ts";
import { githubOrgMembership, normalizeOrgLogin } from "../src/auth/github-membership.ts";

afterEach(() => vi.unstubAllGlobals());

describe("next parameter", () => {
  it.each([
    ["/", "/"],
    ["/changes?repo=acme%2Fapi#top", "/changes?repo=acme%2Fapi#top"],
    ["https://evil.example/", "/"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["/%0d%0aSet-Cookie:x", "/%0d%0aSet-Cookie:x"],
    ["/\r\nx", "/"],
    ["javascript:alert(1)", "/"],
    ["/api/login/github/callback?code=x", "/"],
    ["/" + "a".repeat(600), "/"],
    [undefined, "/"],
    [42, "/"],
  ])("%j becomes %j", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe("organization membership", () => {
  const token = new Secret("gho_test-token");
  function stub(status: number, body: unknown) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(new URL(url).pathname);
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return calls;
  }

  it("uses /user/memberships/orgs/{org} and accepts only active members", async () => {
    const calls = stub(200, { state: "active", role: "member", organization: { login: "Acme" } });
    expect(await githubOrgMembership(token, "acme", "t")).toBe("active");
    expect(calls).toEqual(["/user/memberships/orgs/acme"]);
    expect(calls.some((c) => c === "/user/orgs")).toBe(false);
  });

  it("pending invitations do not qualify", async () => {
    stub(200, { state: "pending", role: "member", organization: { login: "acme" } });
    expect(await githubOrgMembership(token, "acme", "t")).toBe("none");
  });

  it("billing managers and unknown roles do not qualify", async () => {
    stub(200, { state: "active", role: "billing_manager", organization: { login: "acme" } });
    expect(await githubOrgMembership(token, "acme", "t")).toBe("none");
  });

  it("no membership (outside collaborators) is a proven non-member", async () => {
    stub(404, { message: "Not Found" });
    expect(await githubOrgMembership(token, "acme", "t")).toBe("none");
  });

  it("an SSO-unauthorised or under-scoped token proves nothing", async () => {
    stub(403, { message: "Resource protected by organization SAML enforcement." });
    expect(await githubOrgMembership(token, "acme", "t")).toBe("unknown");
  });

  it("an answer about another organization proves nothing", async () => {
    stub(200, { state: "active", role: "admin", organization: { login: "other" } });
    expect(await githubOrgMembership(token, "acme", "t")).toBe("unknown");
  });

  it("normalises org logins", () => {
    expect(normalizeOrgLogin(" Acme-Inc ")).toBe("acme-inc");
    for (const bad of ["", "-acme", "acme/x", "a".repeat(40), 7, null])
      expect(normalizeOrgLogin(bad)).toBeNull();
  });
});
