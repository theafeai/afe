import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type pg from "pg";
import * as ArgoCd from "@afe/connector-argocd";
import { EnvKeyProvider } from "@afe/core/security";
import {
  createLocalUser,
  getCredentialMetadata,
  ingestEvent,
  setUserToolPolicy,
  upsertConnection,
} from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, defaultModules, loadConfig, type AfeApp } from "../src/index.ts";

const admin = "a".repeat(40);
let pool: pg.Pool, afe: AfeApp;
let user: Awaited<ReturnType<typeof createLocalUser>>;
let eventIds: string[];
const headers = (token = admin) => ({ authorization: `Bearer ${token}` });
let cookie: string, csrf: string;
beforeEach(async () => {
  pool = await createTestPool();
  vi.stubEnv("AFE_USER_GITHUB_CLIENT_ID", "test-client");
  vi.stubEnv("AFE_USER_GITHUB_CLIENT_SECRET", "test-secret");
  afe = await buildAfe({
    pool,
    logLevel: "silent",
    config: loadConfig({
      DATABASE_URL: "unused",
      AFE_ADMIN_TOKEN: admin,
      AFE_PUBLIC_URL: "https://afe.example",
    }),
    keys: new EnvKeyProvider({ keys: { k1: randomBytes(32) } }),
    connectors: defaultModules,
  });
  user = await createLocalUser(pool, "default", `u-${randomBytes(8).toString("hex")}`);
  eventIds = [];
  for (const repo of ["acme/allowed", "acme/hidden"]) {
    const result = await ingestEvent(pool, "default", {
      source: "github",
      sourceEventId: randomBytes(16).toString("hex"),
      action: "deployment.created",
      actor: { type: "user", login: "alice" },
      target: { type: "repository", id: repo, repository: repo },
      trigger: { type: "manual" },
      outcome: "succeeded",
      occurredAt: new Date(),
      observedAt: new Date(),
      observation: { method: "webhook" },
      correlation: {},
      data: {},
      rawPayload: { contentType: "application/json", body: '{"secretEvidence":true}' },
    });
    eventIds.push(result.event!.id);
  }
  const login = await afe.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: user.token },
  });
  expect(login.statusCode).toBe(201);
  cookie = (login.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]).join("; ");
  csrf = login.json().csrfToken;
});
afterEach(async () => {
  await afe.app.close();
  await pool.end();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const read = async (url: string) => afe.app.inject({ url, headers: headers(user.token) });
async function policy(
  mode: "none" | "source" | "custom" | "source + custom",
  resources = ["repository:acme/allowed"],
) {
  await setUserToolPolicy(pool, "default", user.user.id, "github", {
    mode,
    custom: resources.map((resource) => ({ resource, action: "read" })),
  });
}
it("provisions users only for admins and reveals no hashes on list", async () => {
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: headers(user.token),
        payload: { username: "x" },
      })
    ).statusCode,
  ).toBe(403);
  const result = await afe.app.inject({
    method: "POST",
    url: "/api/admin/users",
    headers: headers(),
    payload: { username: "newuser" },
  });
  expect(result.statusCode).toBe(201);
  expect(result.headers["cache-control"]).toBe("no-store");
  const list = await afe.app.inject({ url: "/api/admin/users", headers: headers() });
  expect(list.body).not.toContain(result.json().token);
  expect(list.body).not.toContain("credential_digest");
});
it("dashboard login alone grants no data or tool visibility", async () => {
  expect((await read("/api/events")).json().items).toEqual([]);
  expect((await read("/api/deployments")).json().items).toEqual([]);
  expect((await read("/api/profile")).json().tools).toEqual([]);
  expect((await read(`/api/events/${eventIds[0]}`)).statusCode).toBe(404);
  for (const url of [
    "/api/export",
    "/api/audit/verify",
    "/api/connections/github/app",
    `/api/events/${eventIds[0]}/raw`,
  ])
    expect((await read(url)).statusCode).toBe(403);
});
it("custom grants constrain lists, filters, detail, and pagination", async () => {
  await policy("custom");
  const result = (await read("/api/events?limit=1")).json();
  expect(result.items).toHaveLength(1);
  expect(result.items[0].event.target.repository).toBe("acme/allowed");
  expect(result.nextCursor).toBeNull();
  expect((await read("/api/events?repository=acme/hidden")).json().items).toEqual([]);
  expect((await read(`/api/events/${eventIds[0]}`)).statusCode).toBe(200);
  expect((await read(`/api/events/${eventIds[0]}`)).json().rawPayload).toBeNull();
  expect((await read(`/api/events/${eventIds[1]}`)).statusCode).toBe(404);
  await policy("none");
  expect((await read(`/api/events/${eventIds[0]}`)).statusCode).toBe(404);
});
it("only explicit connection grants expose connection health", async () => {
  const c = await upsertConnection(pool, "default", {
    source: "github",
    externalId: randomBytes(8).toString("hex"),
    name: "private installation",
    config: {},
  });
  expect((await read("/api/connections")).json().connections).toEqual([]);
  expect((await read(`/api/connections/${c.id}/health`)).statusCode).toBe(404);
  await policy("custom", [`connection:${c.id}`]);
  expect(
    (await read("/api/connections")).json().connections.map((v: { id: string }) => v.id),
  ).toContain(c.id);
  expect((await read(`/api/connections/${c.id}/health`)).statusCode).toBe(200);
});
it("reset and disable invalidate cookie sessions immediately", async () => {
  const reset = await afe.app.inject({
    method: "POST",
    url: `/api/admin/users/${user.user.id}/credentials`,
    headers: headers(),
  });
  expect(reset.statusCode).toBe(200);
  expect((await afe.app.inject({ url: "/api/session", headers: { cookie } })).statusCode).toBe(401);
  expect((await read("/api/session")).statusCode).toBe(401);
  const token = reset.json().token;
  expect((await afe.app.inject({ url: "/api/session", headers: headers(token) })).statusCode).toBe(
    200,
  );
  await afe.app.inject({
    method: "PATCH",
    url: `/api/admin/users/${user.user.id}`,
    headers: headers(),
    payload: { disabled: true },
  });
  expect((await afe.app.inject({ url: "/api/session", headers: headers(token) })).statusCode).toBe(
    401,
  );
});
it("profile mutation requires CSRF and source-only never uses custom grants", async () => {
  await policy("source");
  expect((await read("/api/events")).json().items).toEqual([]);
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: "/api/profile/tools/github/login",
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(403);
});
it("OAuth state is session-bound and single use; upstream revocation removes only source access", async () => {
  await policy("source + custom");
  let revoked = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(input);
      if (u.pathname === "/login/oauth/access_token")
        return new Response(JSON.stringify({ access_token: "upstream-secret" }), { status: 200 });
      if (u.pathname === "/user")
        return new Response(JSON.stringify({ id: 42, login: "alice" }), { status: 200 });
      if (u.pathname === "/user/repos")
        return new Response(
          JSON.stringify(revoked ? { error: "revoked" } : [{ full_name: "acme/hidden" }]),
          { status: revoked ? 401 : 200 },
        );
      throw new Error("Unexpected external call");
    }),
  );
  const start = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/github/login",
    headers: { cookie, "x-afe-csrf": csrf },
  });
  expect(start.statusCode).toBe(200);
  const state = new URL(start.json().url).searchParams.get("state")!;
  const callback = `/api/profile/tools/github/callback?code=test-code&state=${state}`;
  expect((await afe.app.inject({ url: callback, headers: headers(user.token) })).statusCode).toBe(
    400,
  );
  expect((await afe.app.inject({ url: callback, headers: { cookie } })).statusCode).toBe(303);
  expect((await afe.app.inject({ url: callback, headers: { cookie } })).statusCode).toBe(400);
  expect((await read("/api/events")).json().items.length).toBeGreaterThanOrEqual(2);
  const account = (
    await pool.query<{ credential_id: string }>(
      "SELECT credential_id FROM user_tool_accounts WHERE tenant_id=$1 AND user_id=$2",
      ["default", user.user.id],
    )
  ).rows[0]!;
  const profile = await read("/api/profile");
  expect(profile.body).not.toContain("upstream-secret");
  expect(profile.json().tools[0].accountName).toBe("alice");
  revoked = true;
  const remaining = (await read("/api/events")).json().items;
  expect(
    remaining.every(
      (i: { event: { target: { repository: string } } }) =>
        i.event.target.repository === "acme/allowed",
    ),
  ).toBe(true);
  const unlink = await afe.app.inject({
    method: "DELETE",
    url: "/api/profile/tools/github",
    headers: { cookie, "x-afe-csrf": csrf },
  });
  expect(unlink.statusCode).toBe(200);
  expect(
    (await getCredentialMetadata(pool, "default", account.credential_id))?.revokedAt,
  ).toBeTruthy();
});

it("Vercel uses the user's own token and refreshes source project access", async () => {
  await setUserToolPolicy(pool, "default", user.user.id, "vercel", { mode: "source", custom: [] });
  let visible = true;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer personal-vercel-token",
    );
    if (new URL(url).pathname === "/v2/user")
      return new Response(JSON.stringify({ user: { id: "alice", username: "alice" } }));
    if (new URL(url).pathname === "/v9/projects")
      return new Response(
        JSON.stringify({
          projects: visible ? [{ id: "prj_allowed", name: "allowed" }] : [],
          pagination: { next: null },
        }),
      );
    throw new Error("Unexpected tool call");
  });
  vi.stubGlobal("fetch", fetchMock);
  const linked = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/vercel/token",
    headers: { cookie, "x-afe-csrf": csrf },
    payload: { token: "personal-vercel-token" },
  });
  expect(linked.statusCode).toBe(200);
  await ingestEvent(pool, "default", {
    source: "vercel",
    sourceEventId: "v-source",
    action: "deployment.created",
    actor: { type: "user", id: "alice" },
    target: { type: "deployment", id: "d1", project: "prj_allowed" },
    trigger: { type: "manual" },
    outcome: "succeeded",
    occurredAt: new Date(),
    observedAt: new Date(),
    observation: { method: "webhook" },
    correlation: {},
    data: {},
  });
  expect((await read("/api/events")).json().items).toHaveLength(1);
  visible = false;
  expect((await read("/api/events")).json().items).toEqual([]);
});
it("ArgoCD source grants are limited to the linked connection", async () => {
  await setUserToolPolicy(pool, "default", user.user.id, "argocd", { mode: "source", custom: [] });
  const connection = await upsertConnection(pool, "default", {
    source: "argocd",
    externalId: "https://argo-a.example",
    name: "Argo A",
    status: "active",
    config: { serverUrl: "https://argo-a.example" },
  });
  const other = await upsertConnection(pool, "default", {
    source: "argocd",
    externalId: "https://argo-b.example",
    name: "Argo B",
    status: "active",
    config: { serverUrl: "https://argo-b.example" },
  });
  let visible = true;
  const close = vi.fn(async () => {});
  vi.spyOn(ArgoCd, "createArgoCdClient").mockImplementation((opts) => {
    expect(opts.config.serverUrl).toBe("https://argo-a.example");
    return {
      client: {
        getUserInfo: async () => ({ loggedIn: true, username: "alice" }),
        listApplications: async () => ({ items: visible ? [{ metadata: { name: "api" } }] : [] }),
      } as unknown as ArgoCd.ArgoCdClient,
      close,
    };
  });
  const linked = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/argocd/token",
    headers: { cookie, "x-afe-csrf": csrf },
    payload: { token: "personal-argo-token", connectionId: connection.id },
  });
  expect(linked.statusCode).toBe(200);
  for (const c of [connection, other])
    await ingestEvent(pool, "default", {
      source: "argocd",
      connectionId: c.id,
      sourceEventId: `argo-${c.id}`,
      action: "argocd.sync.started",
      actor: { type: "user", id: "alice" },
      target: { type: "application", id: "api", application: "api" },
      trigger: { type: "manual" },
      outcome: "succeeded",
      occurredAt: new Date(),
      observedAt: new Date(),
      observation: { method: "poll" },
      correlation: {},
      data: {},
    });
  await ingestEvent(pool, "default", {
    source: "argocd",
    connectionId: connection.id,
    sourceEventId: "argo-other-namespace",
    action: "argocd.sync.started",
    actor: { type: "user", id: "alice" },
    target: { type: "application", id: "other/api", application: "api" },
    trigger: { type: "manual" },
    outcome: "succeeded",
    occurredAt: new Date(),
    observedAt: new Date(),
    observation: { method: "poll" },
    correlation: {},
    data: {},
  });
  const result = (await read("/api/events")).json().items;
  expect(result).toHaveLength(1);
  expect(result[0].event.connectionId).toBe(connection.id);
  visible = false;
  expect((await read("/api/events")).json().items).toEqual([]);
  expect(close).toHaveBeenCalled();
});

it("Vercel OAuth is bound to its provider and never installs a mismatched identity", async () => {
  vi.stubEnv("AFE_USER_VERCEL_CLIENT_ID", "vercel-client");
  vi.stubEnv("AFE_USER_VERCEL_CLIENT_SECRET", "vercel-client-secret");
  vi.stubEnv("AFE_USER_VERCEL_INTEGRATION_SLUG", "afe-personal");
  await setUserToolPolicy(pool, "default", user.user.id, "vercel", { mode: "source", custom: [] });
  let mismatched = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/v2/oauth/access_token")
        return new Response(
          JSON.stringify({
            access_token: "vercel-oauth-token",
            installation_id: "icfg_personal",
            user_id: "alice",
            team_id: "team_personal",
          }),
        );
      if (path === "/v2/user")
        return new Response(
          JSON.stringify({ user: { id: mismatched ? "other" : "alice", username: "alice" } }),
        );
      if (path === "/v9/projects")
        return new Response(JSON.stringify({ projects: [], pagination: { next: null } }));
      throw new Error("Unexpected provider request");
    }),
  );
  const start = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/vercel/login",
    headers: { cookie, "x-afe-csrf": csrf },
  });
  expect(start.statusCode).toBe(200);
  const url = new URL(start.json().url);
  expect(url.origin).toBe("https://vercel.com");
  const state = url.searchParams.get("state")!;
  const callback = `/api/profile/tools/vercel/callback?state=${state}&code=vercel-code`;
  await policy("source");
  expect(
    (
      await afe.app.inject({
        url: `/api/profile/tools/github/callback?state=${state}&code=vercel-code`,
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(400);
  expect((await afe.app.inject({ url: callback, headers: headers(user.token) })).statusCode).toBe(
    400,
  );
  expect((await afe.app.inject({ url: callback, headers: { cookie } })).statusCode).toBe(303);
  expect((await afe.app.inject({ url: callback, headers: { cookie } })).statusCode).toBe(400);
  expect(
    (await read("/api/profile")).json().tools.find((t: { tool: string }) => t.tool === "vercel")
      .accountName,
  ).toBe("alice");
  const again = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/vercel/login",
    headers: { cookie, "x-afe-csrf": csrf },
  });
  mismatched = true;
  const state2 = new URL(again.json().url).searchParams.get("state");
  expect(
    (
      await afe.app.inject({
        url: `/api/profile/tools/vercel/callback?state=${state2}&code=bad`,
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(502);
  expect((await read("/api/profile")).body).not.toContain("vercel-oauth-token");
});
it("Terraform has its own default-deny policy and custom workspace grants", async () => {
  await ingestEvent(pool, "default", {
    source: "terraform",
    sourceEventId: "tf-custom",
    action: "terraform.plan.completed",
    actor: { type: "user", id: "alice" },
    target: { type: "workflow_run", id: "run1", project: "production" },
    trigger: { type: "manual" },
    outcome: "succeeded",
    occurredAt: new Date(),
    observedAt: new Date(),
    observation: { method: "webhook" },
    correlation: {},
    data: {},
  });
  expect((await read("/api/events?source=terraform")).json().items).toEqual([]);
  await setUserToolPolicy(pool, "default", user.user.id, "terraform", {
    mode: "source",
    custom: [{ resource: "project:production", action: "read" }],
  });
  expect((await read("/api/events?source=terraform")).json().items).toEqual([]);
  await setUserToolPolicy(pool, "default", user.user.id, "terraform", {
    mode: "source + custom",
    custom: [{ resource: "project:production", action: "read" }],
  });
  expect((await read("/api/events?source=terraform")).json().items).toHaveLength(1);
});
it("denies mixed-tool summaries even when a user has a repository grant", async () => {
  await policy("custom");
  for (const route of afe.routes.filter(
    (r) =>
      r.method === "GET" && /^\/api\/(environments|journeys|drift|mapping|containment)/.test(r.url),
  )) {
    const url = route.url.replace(/:[A-Za-z]+/g, "hidden");
    expect((await read(url)).statusCode, route.url).toBe(403);
  }
});
