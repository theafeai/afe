/**
 * Sign in with GitHub end to end against a fake GitHub (no real API
 * calls). Needs Postgres at TEST_DATABASE_URL.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { EnvKeyProvider } from "@afe/core/security";
import {
  createLocalUser,
  getExternalIdentityForUser,
  getLocalUser,
  getUserToolPolicy,
  setUserToolPolicy,
  upsertConnection,
} from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, loadConfig, type AfeApp } from "../src/index.ts";
import { ACCESS_CACHE_TTL_MS } from "../src/auth/access-cache.ts";
import { LOGIN_COOKIE } from "../src/auth/github-sign-in.ts";

const ADMIN = "a".repeat(40);
let pool: pg.Pool, afe: AfeApp, now: number;
let gh: { id: number; login: string };
let membership: { status: number; body: unknown };
let calls: string[];
const admin = { authorization: `Bearer ${ADMIN}` };

beforeEach(async () => {
  pool = await createTestPool();
  now = Date.now();
  gh = { id: 100, login: "alice" };
  membership = {
    status: 200,
    body: { state: "active", role: "member", organization: { login: "acme" } },
  };
  calls = [];
  vi.stubEnv("AFE_USER_GITHUB_CLIENT_ID", "test-client");
  vi.stubEnv("AFE_USER_GITHUB_CLIENT_SECRET", "test-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(input);
      calls.push(u.pathname);
      if (u.pathname === "/login/oauth/access_token")
        return Response.json({ access_token: "gho_signin-test-token" });
      if (u.pathname === "/user") return Response.json(gh);
      if (u.pathname === "/user/memberships/orgs/acme")
        return Response.json(membership.body, { status: membership.status });
      if (u.pathname === "/user/repos") return Response.json([{ full_name: "acme/allowed" }]);
      throw new Error(`unexpected external call ${u.pathname}`);
    }),
  );
  afe = await buildAfe({
    pool,
    logLevel: "silent",
    clock: () => now,
    config: loadConfig({
      DATABASE_URL: "unused",
      AFE_ADMIN_TOKEN: ADMIN,
      AFE_PUBLIC_URL: "https://afe.example",
    }),
    keys: new EnvKeyProvider({ keys: { k1: randomBytes(32) } }),
    connectors: [],
  });
});
afterEach(async () => {
  await afe.app.close();
  await pool.end();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function installAcme(tenantId = "default") {
  await upsertConnection(pool, tenantId, {
    source: "github",
    externalId: `inst-${tenantId}`,
    name: "acme",
    status: "active",
    config: { account: { id: 9, login: "acme", type: "Organization" }, suspendedAt: null },
  });
}
async function settings(body: Record<string, unknown>) {
  return afe.app.inject({
    method: "PUT",
    url: "/api/admin/github-sign-in",
    headers: admin,
    payload: body,
  });
}
async function enable(extra: Record<string, unknown> = {}) {
  const r = await settings({ enabled: true, autoProvision: false, allowedOrgs: [], ...extra });
  expect(r.statusCode, r.body).toBe(200);
}
async function linkedUser(subject = "100", login = "alice") {
  const created = await createLocalUser(pool, "default", login);
  await setUserToolPolicy(pool, "default", created.user.id, "github", {
    mode: "source",
    custom: [],
  });
  await pool.query(
    "INSERT INTO user_external_identities (tenant_id,user_id,provider,subject,login) VALUES ('default',$1,'github',$2,$3)",
    [created.user.id, subject, login],
  );
  return created;
}
const cookieOf = (setCookie: unknown, name: string) =>
  ([] as string[])
    .concat(setCookie as string[])
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`));
async function start(next?: string) {
  const r = await afe.app.inject({
    method: "POST",
    url: "/api/login/github",
    payload: next === undefined ? {} : { next },
  });
  expect(r.statusCode, r.body).toBe(200);
  const url = new URL(r.json().url);
  return {
    url,
    state: url.searchParams.get("state")!,
    cookie: cookieOf(r.headers["set-cookie"], LOGIN_COOKIE)!,
  };
}
const callback = (state: string, cookie?: string) =>
  afe.app.inject({
    url: `/api/login/github/callback?code=test-code&state=${state}`,
    headers: cookie ? { cookie } : {},
  });
function sessionCookie(res: { headers: Record<string, unknown> }) {
  const all = ([] as string[]).concat(res.headers["set-cookie"] as string[]);
  return all
    .map((c) => c.split(";")[0]!)
    .filter((c) => /^afe_(session|csrf)=./.test(c))
    .join("; ");
}

describe("Sign in with GitHub", () => {
  it("is off by default", async () => {
    expect((await afe.app.inject({ url: "/api/login/github/available" })).json()).toEqual({
      available: false,
    });
    expect(
      (await afe.app.inject({ method: "POST", url: "/api/login/github", payload: {} })).statusCode,
    ).toBe(409);
    const r = await callback("x", `${LOGIN_COOKIE}=y`);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/login?github_error=unavailable");
    const s = (await afe.app.inject({ url: "/api/admin/github-sign-in", headers: admin })).json();
    expect(s).toMatchObject({
      enabled: false,
      autoProvision: false,
      allowedOrgs: [],
      defaultRole: "viewer",
    });
  });

  it("uses a fixed redirect URI and the expected scopes", async () => {
    await enable();
    const { url, cookie } = await start();
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://afe.example/api/login/github/callback",
    );
    expect(url.searchParams.get("scope")).toBe("repo read:user read:org");
    expect(cookie).toMatch(new RegExp(`^${LOGIN_COOKIE}=[A-Za-z0-9_-]{43}$`));
  });

  it("login CSRF: the state is bound to the browser that started it and is single use", async () => {
    await enable();
    const user = await linkedUser();
    const { state, cookie } = await start("/changes");
    const other = await start();
    // Another browser's cookie, or none, never completes this flow.
    expect((await callback(state, other.cookie)).headers.location).toBe(
      "/login?github_error=invalid_state",
    );
    expect((await callback(state)).headers.location).toBe("/login?github_error=invalid_state");
    const ok = await callback(state, cookie);
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/changes");
    expect(ok.headers["referrer-policy"]).toBe("no-referrer");
    const session = await afe.app.inject({
      url: "/api/session",
      headers: { cookie: sessionCookie(ok) },
    });
    expect(session.json().principal).toMatchObject({
      id: `local:${user.user.id}`,
      roles: ["viewer"],
      managedUser: true,
    });
    // Replaying the same state fails.
    expect((await callback(state, cookie)).headers.location).toBe(
      "/login?github_error=invalid_state",
    );
    // Never logged or returned.
    expect(ok.body).not.toContain("gho_signin-test-token");
  });

  it("limits next to same-origin relative paths", async () => {
    await enable();
    await linkedUser();
    for (const next of ["https://evil.example/", "//evil.example", "/api/admin/users"]) {
      const { state, cookie } = await start(next);
      expect((await callback(state, cookie)).headers.location).toBe("/");
    }
  });

  it("matches users by numeric GitHub id only, never by login", async () => {
    await enable();
    const user = await linkedUser("100", "alice");
    gh = { id: 999, login: "alice" }; // someone took over the login
    let s = await start();
    expect((await callback(s.state, s.cookie)).headers.location).toBe(
      "/login?github_error=not_linked",
    );
    gh = { id: 100, login: "alice-renamed" };
    s = await start();
    expect((await callback(s.state, s.cookie)).statusCode).toBe(303);
    expect((await getExternalIdentityForUser(pool, "default", user.user.id, "github"))!.login).toBe(
      "alice-renamed",
    );
  });

  it("administrator storage accounts (ADR 0012) are never signed in to", async () => {
    await enable();
    const linked = await afe.app.inject({
      method: "POST",
      url: "/api/profile/tools/github/token",
      headers: admin,
      payload: { token: "github_pat_admin-fixture-token" },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    const s = await start();
    const r = await callback(s.state, s.cookie);
    expect(r.headers.location).toBe("/login?github_error=not_linked");
    expect(String(r.headers["set-cookie"])).not.toMatch(/afe_session=[^;]/);
  });

  it("disabled users cannot sign in", async () => {
    await enable();
    const user = await linkedUser();
    await afe.app.inject({
      method: "PATCH",
      url: `/api/admin/users/${user.user.id}`,
      headers: admin,
      payload: { disabled: true },
    });
    const s = await start();
    expect((await callback(s.state, s.cookie)).headers.location).toBe(
      "/login?github_error=disabled",
    );
  });

  it("settings: orgs must have this tenant's active installation; never admin; provisioning needs orgs", async () => {
    expect(
      (await settings({ enabled: true, autoProvision: true, allowedOrgs: [] })).statusCode,
    ).toBe(400);
    expect(
      (
        await settings({
          enabled: true,
          autoProvision: false,
          allowedOrgs: [],
          defaultRole: "admin",
        })
      ).statusCode,
    ).toBe(400);
    // Another tenant's installation of the same org does not count.
    await pool.query("INSERT INTO tenants(id,name) VALUES ('other','Other')");
    await installAcme("other");
    const r = await settings({ enabled: true, autoProvision: true, allowedOrgs: ["acme"] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "org_not_installed", orgs: ["acme"] });
    await installAcme();
    expect(
      (await settings({ enabled: true, autoProvision: true, allowedOrgs: ["ACME"] })).statusCode,
    ).toBe(200);
    expect(
      (await afe.app.inject({ url: "/api/admin/github-sign-in", headers: admin })).json(),
    ).toMatchObject({
      allowedOrgs: ["acme"],
      defaultRole: "viewer",
      installedOrgs: ["acme"],
    });
  });

  it("auto-provisions active members of allowed orgs as managed viewers only", async () => {
    await installAcme();
    await enable({ autoProvision: true, allowedOrgs: ["acme"] });
    membership = {
      status: 200,
      body: { state: "pending", role: "member", organization: { login: "acme" } },
    };
    let s = await start();
    expect((await callback(s.state, s.cookie)).headers.location).toBe(
      "/login?github_error=not_member",
    );
    membership = { status: 404, body: { message: "Not Found" } }; // outside collaborator
    s = await start();
    expect((await callback(s.state, s.cookie)).headers.location).toBe(
      "/login?github_error=not_member",
    );
    expect((await pool.query("SELECT 1 FROM users")).rowCount).toBe(0);
    expect(calls).not.toContain("/user/orgs");

    membership = {
      status: 200,
      body: { state: "active", role: "member", organization: { login: "acme" } },
    };
    s = await start();
    const ok = await callback(s.state, s.cookie);
    expect(ok.statusCode).toBe(303);
    const { rows } = await pool.query<{ id: string; username: string }>(
      "SELECT id, username FROM users",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe("alice");
    const identity = (await getExternalIdentityForUser(pool, "default", rows[0]!.id, "github"))!;
    expect(identity).toMatchObject({ subject: "100", provisioned: true });
    expect(await getUserToolPolicy(pool, "default", rows[0]!.id, "github")).toEqual({
      mode: "source",
      custom: [],
    });
    for (const tool of ["vercel", "argocd", "terraform"])
      expect((await getUserToolPolicy(pool, "default", rows[0]!.id, tool)).mode).toBe("none");
    const cookie = sessionCookie(ok);
    const session = await afe.app.inject({ url: "/api/session", headers: { cookie } });
    expect(session.json().principal.roles).toEqual(["viewer"]);
    // Managed users cannot reach admin routes.
    expect(
      (await afe.app.inject({ url: "/api/admin/users", headers: { cookie } })).statusCode,
    ).toBe(403);
  });

  it("offboarding: lost membership disables a provisioned user on the next access refresh", async () => {
    await installAcme();
    await enable({ autoProvision: true, allowedOrgs: ["acme"] });
    const s = await start();
    const cookie = sessionCookie(await callback(s.state, s.cookie));
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users");
    expect((await afe.app.inject({ url: "/api/session", headers: { cookie } })).statusCode).toBe(
      200,
    );
    // Membership lost upstream: the next refresh after the TTL disables the user.
    membership = { status: 404, body: { message: "Not Found" } };
    now += ACCESS_CACHE_TTL_MS + 1;
    const { requestEventAccess } = await import("../src/auth/permissions.ts");
    const rules = await requestEventAccess(
      pool,
      {
        tenantId: "default",
        principal: {
          id: `local:${rows[0]!.id}`,
          tenantId: "default",
          roles: ["viewer"],
          kind: "github",
          localUserId: rows[0]!.id,
        },
      } as never,
      afe.context,
    );
    expect(rules).toEqual([]);
    expect((await getLocalUser(pool, "default", rows[0]!.id))!.disabled).toBe(true);
    expect((await afe.app.inject({ url: "/api/session", headers: { cookie } })).statusCode).toBe(
      401,
    );
  });

  it("unlinking GitHub ends sessions that started with GitHub", async () => {
    await enable();
    await linkedUser();
    const s = await start();
    const ok = await callback(s.state, s.cookie);
    const cookie = sessionCookie(ok);
    const csrf = (await afe.app.inject({ url: "/api/session", headers: { cookie } })).json()
      .csrfToken;
    const unlink = await afe.app.inject({
      method: "DELETE",
      url: "/api/profile/tools/github",
      headers: { cookie, "x-afe-csrf": csrf },
    });
    expect(unlink.statusCode).toBe(200);
    expect((await afe.app.inject({ url: "/api/session", headers: { cookie } })).statusCode).toBe(
      401,
    );
  });

  it("rate limits the callback per client address", async () => {
    await enable();
    let last;
    for (let i = 0; i < 21; i++) last = await callback("x", `${LOGIN_COOKIE}=y`);
    expect(last!.headers.location).toBe("/login?github_error=rate_limited");
    expect(last!.statusCode).toBe(303);
    expect(last!.headers["referrer-policy"]).toBe("no-referrer");
    expect(last!.headers["retry-after"]).toBeDefined();
  });

  it("rate limits the start per client address; another address is unaffected", async () => {
    await enable();
    for (let i = 0; i < 20; i++) await start();
    const limited = await afe.app.inject({ method: "POST", url: "/api/login/github", payload: {} });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers["cache-control"]).toBe("no-store");
    // X-Forwarded-For is not trusted: it cannot move a client into a fresh bucket.
    const spoofed = await afe.app.inject({
      method: "POST",
      url: "/api/login/github",
      headers: { "x-forwarded-for": "203.0.113.9" },
      payload: {},
    });
    expect(spoofed.statusCode).toBe(429);
    const other = await afe.app.inject({
      method: "POST",
      url: "/api/login/github",
      remoteAddress: "198.51.100.7",
      payload: {},
    });
    expect(other.statusCode, other.body).toBe(200);
  });

  it("rate limits the administrator settings routes per principal", async () => {
    for (let i = 0; i < 20; i++)
      expect(
        (await settings({ enabled: false, autoProvision: false, allowedOrgs: [] })).statusCode,
      ).toBe(200);
    const put = await settings({ enabled: false, autoProvision: false, allowedOrgs: [] });
    expect(put.statusCode).toBe(429);
    expect(put.json().error).toBe("rate_limited");
    for (let i = 0; i < 60; i++)
      expect(
        (await afe.app.inject({ url: "/api/admin/github-sign-in", headers: admin })).statusCode,
      ).toBe(200);
    const get = await afe.app.inject({ url: "/api/admin/github-sign-in", headers: admin });
    expect(get.statusCode).toBe(429);
    // Unauthenticated requests are rejected before the limiter and use no bucket.
    expect((await afe.app.inject({ url: "/api/admin/github-sign-in" })).statusCode).toBe(401);
  });
});

describe("Profile linking keeps one GitHub account per Afe user", () => {
  it("a GitHub id already bound to another user is rejected", async () => {
    await linkedUser("100", "alice");
    const bob = await createLocalUser(pool, "default", "bob");
    await setUserToolPolicy(pool, "default", bob.user.id, "github", { mode: "source", custom: [] });
    const r = await afe.app.inject({
      method: "POST",
      url: "/api/profile/tools/github/token",
      headers: { authorization: `Bearer ${bob.token}` },
      payload: { token: "github_pat_fixture-token" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("identity_in_use");
    expect(
      (await pool.query("SELECT 1 FROM user_tool_accounts WHERE user_id=$1", [bob.user.id]))
        .rowCount,
    ).toBe(0);
  });

  it("linking stores the numeric id", async () => {
    const bob = await createLocalUser(pool, "default", "bob");
    await setUserToolPolicy(pool, "default", bob.user.id, "github", { mode: "source", custom: [] });
    gh = { id: 4242, login: "bob-gh" };
    const r = await afe.app.inject({
      method: "POST",
      url: "/api/profile/tools/github/token",
      headers: { authorization: `Bearer ${bob.token}` },
      payload: { token: "github_pat_fixture-token" },
    });
    expect(r.statusCode).toBe(200);
    expect(await getExternalIdentityForUser(pool, "default", bob.user.id, "github")).toMatchObject({
      subject: "4242",
      login: "bob-gh",
      provisioned: false,
    });
  });
});
