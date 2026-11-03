import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  ensureGitHubAdminIdentity,
  getCredential,
  getGitHubAdminIdentity,
  getUserToolPolicy,
  setLocalUserDisabled,
} from "@afe/db";
import { createTestPool, seedLegacyToolPolicy } from "@afe/db/testing";
import { EnvKeyProvider } from "@afe/core/security";
import { buildAfe, loadConfig, type AfeApp } from "../src/index.ts";
import { toolAccounts } from "../src/auth/tool-accounts.ts";

const admin = "a".repeat(40),
  viewer = "v".repeat(40);
const headers = (token = admin) => ({ authorization: `Bearer ${token}` });
const endpoint = "/api/profile/tools/github/token";
let pool: pg.Pool, afe: AfeApp;
let upstream: number | "network";
let identity: unknown;
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });

beforeEach(async () => {
  pool = await createTestPool();
  upstream = 200;
  identity = { id: 1, login: "octocat" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (upstream === "network") throw new Error("private-provider-detail");
      return new Response(
        JSON.stringify(upstream === 200 ? identity : { message: "private-provider-detail" }),
        { status: upstream },
      );
    }),
  );
  afe = await buildAfe({
    pool,
    keys,
    logLevel: "silent",
    connectors: [],
    config: loadConfig({
      DATABASE_URL: "unused",
      AFE_ADMIN_TOKEN: admin,
      AFE_VIEWER_TOKEN: viewer,
    }),
  });
});
afterEach(async () => {
  await afe.app.close();
  await pool.end();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function link(token = "github_pat_fixture-token") {
  return afe.app.inject({ method: "POST", url: endpoint, headers: headers(), payload: { token } });
}
async function adminUser() {
  return (await pool.query<{ user_id: string }>("SELECT user_id FROM github_admin_identities"))
    .rows[0]!.user_id;
}

it.each(["github_pat_fixture-token", "ghp_classic-fixture-token"])(
  "links %s directly from an admin cookie session and persists across sign-in",
  async (token) => {
    const before = await afe.app.inject({ url: "/api/profile", headers: headers() });
    expect(before.json().tools).toMatchObject([
      { tool: "github", linked: false, sourceEnabled: true },
    ]);
    expect((await pool.query("SELECT * FROM github_admin_identities")).rowCount).toBe(0);
    const login = await afe.app.inject({
      method: "POST",
      url: "/api/session",
      payload: { token: admin },
    });
    const cookie = (login.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]).join("; ");
    expect(
      (
        await afe.app.inject({
          method: "POST",
          url: endpoint,
          headers: { cookie },
          payload: { token },
        })
      ).statusCode,
    ).toBe(403);
    const linked = await afe.app.inject({
      method: "POST",
      url: endpoint,
      headers: { cookie, "x-afe-csrf": login.json().csrfToken },
      payload: { token },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toEqual({ ok: true });
    const uid = await adminUser();
    const account = (await toolAccounts(afe.context, "default", uid))[0]!;
    expect(
      (await getCredential(pool, keys, "default", account.credential_id))?.secret.reveal(),
    ).toBe(token);
    expect(await getUserToolPolicy(pool, "default", uid, "github")).toEqual({
      mode: "source",
      custom: [],
    });
    for (const requestHeaders of [headers(), { cookie }]) {
      const profile = await afe.app.inject({ url: "/api/profile", headers: requestHeaders });
      expect(profile.json().tools).toMatchObject([{ linked: true, accountName: "octocat" }]);
      expect(profile.json().administratorGitHub.username).toMatch(/^github-admin-/);
      expect(profile.body).not.toContain(token);
      expect(profile.body).not.toContain(account.credential_id);
    }
  },
);

it("replaces and disconnects encrypted credentials without replacing grants", async () => {
  expect((await link()).statusCode).toBe(200);
  const uid = await adminUser();
  const policy = {
    mode: "source" as const,
    custom: [],
    denied: [{ resource: "repository:acme/app", action: "github.rerun" }],
  };
  await seedLegacyToolPolicy(pool, "default", uid, "github", policy);
  const first = (await toolAccounts(afe.context, "default", uid))[0]!;
  upstream = 401;
  expect((await link("expired-test-token")).statusCode).toBe(403);
  expect((await toolAccounts(afe.context, "default", uid))[0]!.credential_id).toBe(
    first.credential_id,
  );
  upstream = 200;
  expect((await link("replacement-test-token")).statusCode).toBe(200);
  expect(await getCredential(pool, keys, "default", first.credential_id)).toBeNull();
  expect(await getUserToolPolicy(pool, "default", uid, "github")).toEqual(policy);
  const second = (await toolAccounts(afe.context, "default", uid))[0]!;
  expect(
    (
      await afe.app.inject({
        method: "DELETE",
        url: "/api/profile/tools/github",
        headers: headers(),
      })
    ).statusCode,
  ).toBe(200);
  expect(await getCredential(pool, keys, "default", second.credential_id)).toBeNull();
  expect(await toolAccounts(afe.context, "default", uid)).toEqual([]);
  expect((await link()).statusCode).toBe(200);
  expect(await adminUser()).toBe(uid);
  expect(await getUserToolPolicy(pool, "default", uid, "github")).toEqual(policy);
});

it.each([
  [401, 403],
  [403, 403],
  [500, 502],
  [429, 429],
  ["network", 502],
] as const)(
  "handles GitHub %s without creating an identity or leaking provider details",
  async (failure, expected) => {
    upstream = failure;
    const response = await link();
    expect(response.statusCode).toBe(expected);
    expect(response.body).not.toContain("private-provider-detail");
    expect((await pool.query("SELECT * FROM github_admin_identities")).rowCount).toBe(0);
  },
);

it("rejects malformed tokens and source identities without provisioning", async () => {
  expect((await link("bad token")).statusCode).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  identity = { login: "octocat" };
  expect((await link()).statusCode).toBe(502);
  expect((await pool.query("SELECT * FROM github_admin_identities")).rowCount).toBe(0);
});

it("keeps static viewers and unauthenticated requests out of administrator linking", async () => {
  for (const requestHeaders of [headers(viewer), {}]) {
    const response = await afe.app.inject({
      method: "POST",
      url: endpoint,
      headers: requestHeaders,
      payload: { token: "test-personal-token" },
    });
    expect([401, 409]).toContain(response.statusCode);
  }
  expect(fetch).not.toHaveBeenCalled();
  expect((await pool.query("SELECT * FROM github_admin_identities")).rowCount).toBe(0);
});

it("does not restore disabled identities or none policies during relinking", async () => {
  await link();
  const uid = await adminUser();
  await seedLegacyToolPolicy(pool, "default", uid, "github", { mode: "none", custom: [] });
  expect((await link()).statusCode).toBe(403);
  await setLocalUserDisabled(pool, "default", uid, true);
  expect((await link()).statusCode).toBe(403);
  expect(await adminUser()).toBe(uid);
});

it("serializes concurrent first links and isolates tenant/principal bindings", async () => {
  const responses = await Promise.all([link(), link("second-personal-token")]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  const uid = await adminUser();
  expect((await pool.query("SELECT * FROM github_admin_identities")).rowCount).toBe(1);
  expect(await toolAccounts(afe.context, "default", uid)).toHaveLength(1);
  const original = (
    await pool.query<{ principal_id: string }>("SELECT principal_id FROM github_admin_identities")
  ).rows[0]!.principal_id;
  expect(await getGitHubAdminIdentity(pool, "default", "another-principal")).toBeNull();
  expect(await getGitHubAdminIdentity(pool, "other", original)).toBeNull();
  await pool.query("INSERT INTO tenants(id,name) VALUES ('other','Other')");
  expect(await ensureGitHubAdminIdentity(pool, "other", original)).not.toBe(uid);
});

it("does not bypass a hosted identity hook returning no mapping", async () => {
  afe.context.githubUserId = async () => null;
  expect((await link()).statusCode).toBe(409);
  expect((await pool.query("SELECT * FROM github_admin_identities")).rowCount).toBe(0);
});

it("supports administrator OAuth with the existing single-use, session-bound callback", async () => {
  vi.stubEnv("AFE_USER_GITHUB_CLIENT_ID", "fixture-client");
  vi.stubEnv("AFE_USER_GITHUB_CLIENT_SECRET", "fixture-client-secret");
  await afe.app.close();
  afe = await buildAfe({
    pool,
    keys,
    logLevel: "silent",
    connectors: [],
    config: loadConfig({
      DATABASE_URL: "unused",
      AFE_ADMIN_TOKEN: admin,
      AFE_PUBLIC_URL: "https://afe.example",
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("access_token")
        ? Response.json({
            access_token: "oauth-personal-fixture",
            token_type: "bearer",
            scope: "repo read:user",
          })
        : Response.json(identity),
    ),
  );
  const login = await afe.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: admin },
  });
  const cookie = (login.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]).join("; ");
  const started = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/github/login",
    headers: { cookie, "x-afe-csrf": login.json().csrfToken },
  });
  expect(started.statusCode).toBe(200);
  const state = new URL(started.json().url).searchParams.get("state");
  const callback = `/api/profile/tools/github/callback?code=test-code&state=${state}`;
  expect((await afe.app.inject({ url: callback, headers: headers() })).statusCode).toBe(400);
  expect((await afe.app.inject({ url: callback, headers: { cookie } })).statusCode).toBe(303);
  expect((await afe.app.inject({ url: callback, headers: { cookie } })).statusCode).toBe(400);
  const profile = await afe.app.inject({ url: "/api/profile", headers: headers() });
  expect(profile.json().tools[0]).toMatchObject({ linked: true, accountName: "octocat" });
  expect(profile.body).not.toContain("oauth-personal-fixture");
});

it("isolates the same administrator principal across tenants at the API boundary", async () => {
  await link();
  const uid = await adminUser();
  const principalId = (
    await pool.query<{ principal_id: string }>("SELECT principal_id FROM github_admin_identities")
  ).rows[0]!.principal_id;
  await pool.query("INSERT INTO tenants(id,name) VALUES ('other','Other')");
  const other = await buildAfe({
    pool,
    keys,
    logLevel: "silent",
    connectors: [],
    config: loadConfig({ DATABASE_URL: "unused" }),
    authProvider: {
      authenticate: () => ({ id: principalId, tenantId: "other", roles: ["admin"], kind: "test" }),
    },
  });
  try {
    const profile = await other.app.inject({ url: "/api/profile" });
    expect(profile.json().tools[0].linked).toBe(false);
    expect(
      (
        await other.app.inject({
          method: "POST",
          url: endpoint,
          payload: { token: "other-tenant-personal-token", userId: uid },
        })
      ).statusCode,
    ).toBe(200);
    const otherId = await getGitHubAdminIdentity(pool, "other", principalId);
    expect(otherId).not.toBe(uid);
    expect((await toolAccounts(other.context, "other", otherId!))[0]!.credential_id).not.toBe(
      (await toolAccounts(afe.context, "default", uid))[0]!.credential_id,
    );
  } finally {
    await other.app.close();
  }
});

it("requires a fresh link after administrator token rotation", async () => {
  await link();
  const uid = await adminUser();
  await afe.app.close();
  const rotated = "r".repeat(40);
  afe = await buildAfe({
    pool,
    keys,
    logLevel: "silent",
    connectors: [],
    config: loadConfig({ DATABASE_URL: "unused", AFE_ADMIN_TOKEN: rotated }),
  });
  expect((await afe.app.inject({ url: "/api/profile", headers: headers() })).statusCode).toBe(401);
  const profile = await afe.app.inject({ url: "/api/profile", headers: headers(rotated) });
  expect(profile.json().tools[0].linked).toBe(false);
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: endpoint,
        headers: headers(rotated),
        payload: { token: "rotated-admin-personal-token" },
      })
    ).statusCode,
  ).toBe(200);
  const bindings = (
    await pool.query<{ user_id: string }>("SELECT user_id FROM github_admin_identities")
  ).rows;
  expect(bindings).toHaveLength(2);
  const newId = bindings.find((b) => b.user_id !== uid)!.user_id;
  expect(await getUserToolPolicy(pool, "default", newId, "github")).toEqual({
    mode: "source",
    custom: [],
  });
});
