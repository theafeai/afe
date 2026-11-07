import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type pg from "pg";
import { createTestPool, seedLegacyToolPolicy } from "@afe/db/testing";
import { createLocalUser, deleteLocalUser, storeCredential, upsertConnection } from "@afe/db";
import { EnvKeyProvider } from "@afe/core/security";
import { VERCEL_OPERATIONS } from "@afe/core";
import { buildAfe, type AfeApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { vercelActionsModule } from "../src/actions/vercel.ts";
let pool: pg.Pool, afe: AfeApp, user: Awaited<ReturnType<typeof createLocalUser>>;
let root: string, connectionId: string;
let state: string,
  role: string,
  production: string,
  failure: number | "network" | null,
  readFailure: number | null,
  actionUser: string;
let calls: { method: string; path: string; token: string; body: unknown; team: string | null }[];
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });
const auth = () => ({ authorization: `Bearer ${user.token}` });
const inject = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path = "",
  payload?: Record<string, unknown>,
) =>
  afe.app.inject({
    method,
    url: root + path,
    headers: auth(),
    ...(payload === undefined ? {} : { payload }),
  });
const enable = (actions: string[] = VERCEL_OPERATIONS.map(([a]) => a)) =>
  inject("PUT", "/credential", { token: "action-secret", actions });
const intent = (
  action = "vercel.redeploy",
  params: Record<string, unknown> = { deploymentId: "dpl_old", target: "preview" },
) => ({ action, params });
async function prepare(i = intent()) {
  const res = await inject("POST", "/prepare", i);
  expect(res.statusCode, res.body).toBe(200);
  return { ...i, fingerprint: res.json().fingerprint, requestId: randomUUID(), confirmed: true };
}
beforeEach(async () => {
  pool = await createTestPool();
  calls = [];
  state = "READY";
  role = "OWNER";
  production = "dpl_live";
  failure = null;
  readFailure = null;
  actionUser = "user_alice";
  vi.stubGlobal("fetch", async (value: string, init: RequestInit) => {
    const url = new URL(value),
      path = url.pathname,
      token = new Headers(init.headers).get("authorization")!;
    calls.push({
      method: init.method!,
      path,
      token,
      body: init.body ? JSON.parse(String(init.body)) : null,
      team: url.searchParams.get("teamId"),
    });
    if (init.method !== "GET") {
      if (failure === "network") throw new Error("must-not-leak secret");
      return failure
        ? Response.json({ secret: "must-not-leak" }, { status: failure })
        : Response.json({ id: "dpl_new", env: { PRIVATE: "must-not-leak" } }, { status: 200 });
    }
    if (readFailure) return Response.json({}, { status: readFailure });
    if (path === "/v2/user")
      return Response.json({
        user: {
          id: token.includes("action-secret") ? actionUser : "user_alice",
          username: "alice",
        },
      });
    if (path === "/v2/teams/team_acme")
      return Response.json({ id: "team_acme", slug: "acme", membership: { role } });
    const project = {
      id: "prj_app",
      accountId: "team_acme",
      name: "app",
      updatedAt: 100,
      link: { type: "github", repoId: 123 },
      targets: { production: { id: production } },
    };
    if (path === "/v9/projects") return Response.json({ projects: [project] });
    if (path === "/v9/projects/prj_app") return Response.json(project);
    if (path.endsWith("/domains"))
      return Response.json({ domains: [{ name: "app.example.com", verified: true }] });
    if (path.endsWith("/aliases")) return Response.json({ aliases: [] });
    const d = {
      id: "dpl_old",
      projectId: "prj_app",
      name: "app",
      readyState: state,
      target: "production",
      createdAt: 100,
      isRollbackCandidate: true,
    };
    if (path === "/v13/deployments/dpl_old") return Response.json(d);
    if (path === "/v13/deployments/dpl_foreign")
      return Response.json({ ...d, id: "dpl_foreign", projectId: "prj_other" });
    if (path === "/v6/deployments")
      return Response.json({ deployments: [{ ...d, uid: d.id }], pagination: { next: null } });
    throw new Error(`Unexpected GET ${path}`);
  });
  afe = await buildAfe({
    pool,
    keys,
    logLevel: "silent",
    config: loadConfig({ DATABASE_URL: "unused", AFE_ADMIN_TOKEN: "a".repeat(40) }),
    connectors: [vercelActionsModule],
  });
  user = await createLocalUser(pool, "default", "alice");
  const c = await upsertConnection(pool, "default", {
    source: "vercel",
    externalId: "team_acme",
    name: "acme",
    status: "active",
    config: { teamId: "team_acme", userId: "user_alice", projectSelection: { mode: "all" } },
  });
  connectionId = c.id;
  root = `/api/actions/vercel/connections/${c.id}/projects/prj_app`;
  const credential = await storeCredential(pool, keys, "default", {
    kind: "user_vercel_token",
    secret: "read-secret",
  });
  await pool.query(
    "INSERT INTO user_tool_accounts (tenant_id,user_id,tool,account_name,credential_id,context) VALUES ('default',$1,'vercel','alice',$2,$3)",
    [user.user.id, credential.id, { teamId: "team_acme" }],
  );
  await seedLegacyToolPolicy(pool, "default", user.user.id, "vercel", {
    mode: "source",
    custom: [],
  });
});
afterEach(async () => {
  await afe?.app.close();
  await pool?.end();
  vi.unstubAllGlobals();
});
it("discovers only selected tenant projects, and observation never enables writes", async () => {
  const resources = await afe.app.inject({ url: "/api/actions/vercel/resources", headers: auth() });
  expect(resources.json().items).toEqual([
    { connectionId, projectId: "prj_app", name: "app", connectionName: "acme" },
  ]);
  const view = await inject("GET", "?deploymentId=dpl_old");
  expect(view.statusCode, view.body).toBe(200);
  expect(view.json().capabilities.every((c: { enabled: boolean }) => !c.enabled)).toBe(true);
  expect((await inject("POST", "/prepare", intent())).statusCode).toBe(403);
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});
it("executes using only the action credential, replays the UUID without a second dispatch, and stores sanitized evidence", async () => {
  expect((await enable()).statusCode).toBe(200);
  const b = await prepare();
  const result = await inject("POST", "", b);
  expect(result.statusCode, result.body).toBe(202);
  expect(result.json()).toMatchObject({ state: "accepted", deploymentId: "dpl_new" });
  expect(result.json().targetDeploymentId).toBe("dpl_old");
  expect((await inject("POST", "", b)).statusCode).toBe(200);
  const mutations = calls.filter((c) => c.method !== "GET");
  expect(mutations).toEqual([
    {
      method: "POST",
      path: "/v13/deployments",
      token: "Bearer action-secret",
      team: "team_acme",
      body: {
        name: "app",
        project: "prj_app",
        deploymentId: "dpl_old",
        target: "preview",
        withLatestCommit: false,
      },
    },
  ]);
  const rows = await pool.query("SELECT * FROM vercel_action_requests");
  expect(JSON.stringify(rows.rows)).not.toMatch(/secret|target.*preview/);
  expect((await pool.query("SELECT count(*) FROM events")).rows[0].count).toBe("0");
});
it.each([
  ["vercel.deploy", { ref: "a".repeat(40), target: "preview" }, "POST", "/v13/deployments"],
  ["vercel.cancel", { deploymentId: "dpl_old" }, "PATCH", "/v12/deployments/dpl_old/cancel"],
  ["vercel.promote", { deploymentId: "dpl_old" }, "POST", "/v10/projects/prj_app/promote/dpl_old"],
  ["vercel.rollback", { deploymentId: "dpl_old" }, "POST", "/v1/projects/prj_app/rollback/dpl_old"],
  [
    "vercel.alias_assign",
    { deploymentId: "dpl_old", domain: "app.example.com" },
    "POST",
    "/v2/deployments/dpl_old/aliases",
  ],
  ["vercel.delete", { deploymentId: "dpl_old" }, "DELETE", "/v13/deployments/dpl_old"],
  [
    "vercel.configure",
    { autoAssignCustomDomains: false, previewDeploymentsDisabled: true },
    "PATCH",
    "/v9/projects/prj_app",
  ],
])(
  "routes %s through the same prepared execution contract",
  async (action, params, method, path) => {
    await enable();
    if (action === "vercel.cancel") state = "BUILDING";
    const b = await prepare(intent(action, params));
    expect((await inject("POST", "", b)).statusCode).toBe(202);
    expect(calls.filter((c) => c.method !== "GET")).toMatchObject([{ method, path }]);
  },
);
it("rejects stale source state and missing confirmation without a mutation", async () => {
  await enable();
  const b = await prepare();
  state = "BUILDING";
  expect((await inject("POST", "", b)).statusCode).toBe(409);
  state = "READY";
  production = "dpl_changed";
  expect((await inject("POST", "", b)).statusCode).toBe(409);
  expect((await inject("POST", "", { ...b, confirmed: false })).statusCode).toBe(400);
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});
it("enforces current consent, source roles, identity and policy on execution and replay", async () => {
  await enable(["vercel.redeploy"]);
  const b = await prepare();
  role = "VIEWER";
  expect((await inject("POST", "", b)).statusCode).toBe(403);
  role = "OWNER";
  actionUser = "user_bob";
  expect((await inject("POST", "", b)).statusCode).toBe(403);
  actionUser = "user_alice";
  await seedLegacyToolPolicy(pool, "default", user.user.id, "vercel", {
    mode: "source + custom",
    custom: [],
  });
  expect((await inject("POST", "", b)).statusCode).toBe(403);
});
it("requires owner authority for configuration and verified project domain membership", async () => {
  await enable();
  role = "DEVELOPER";
  expect(
    (
      await inject(
        "POST",
        "/prepare",
        intent("vercel.configure", {
          autoAssignCustomDomains: false,
          previewDeploymentsDisabled: true,
        }),
      )
    ).statusCode,
  ).toBe(409);
  role = "OWNER";
  expect(
    (
      await inject(
        "POST",
        "/prepare",
        intent("vercel.alias_assign", { deploymentId: "dpl_old", domain: "foreign.example.com" }),
      )
    ).statusCode,
  ).toBe(403);
});
it("rejects foreign tenants, bootstrap admin, unselected projects and foreign deployments", async () => {
  await enable();
  expect(
    (await inject("POST", "/prepare", intent("vercel.delete", { deploymentId: "dpl_foreign" })))
      .statusCode,
  ).toBe(404);
  expect(
    (await afe.app.inject({ url: root, headers: { authorization: `Bearer ${"a".repeat(40)}` } }))
      .statusCode,
  ).toBe(403);
  await pool.query("INSERT INTO tenants (id,name) VALUES ('other','Other')");
  const other = await createLocalUser(pool, "other", "bob");
  calls = [];
  expect(
    (await afe.app.inject({ url: root, headers: { authorization: `Bearer ${other.token}` } }))
      .statusCode,
  ).toBe(404);
  expect(calls).toEqual([]);
  await pool.query(
    "UPDATE connections SET config=jsonb_set(config,'{projectSelection}','{\"mode\":\"none\"}') WHERE tenant_id='default' AND id=$1",
    [connectionId],
  );
  expect((await inject("GET")).statusCode).toBe(403);
});
it.each([400, 403, 429, 500, "network"] as const)(
  "never retries mutation failure %s and holds uncertainty",
  async (code) => {
    await enable();
    const b = await prepare();
    failure = code;
    const res = await inject("POST", "", b);
    expect(res.statusCode).toBe(202);
    expect(res.json().state).toBe(typeof code === "number" && code < 500 ? "rejected" : "unknown");
    expect(res.body).not.toContain("must-not-leak");
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
    expect((await inject("POST", "", b)).json().state).toBe(res.json().state);
    if (res.json().state === "unknown")
      expect((await inject("POST", "", { ...b, requestId: randomUUID() })).statusCode).toBe(409);
  },
);
it("locks concurrent submissions and requires the actor's explicit uncertainty recovery", async () => {
  await enable();
  const b = await prepare();
  failure = "network";
  const [a, second] = await Promise.all([
    inject("POST", "", b),
    inject("POST", "", { ...b, requestId: randomUUID() }),
  ]);
  expect([a.statusCode, second.statusCode].sort()).toEqual([202, 409]);
  const id = a.statusCode === 202 ? b.requestId : second.json().requestId;
  expect((await inject("POST", `/requests/${id}/release`, {})).statusCode).toBe(400);
  expect(
    (await inject("POST", `/requests/${id}/release`, { acknowledgeDuplicateRisk: true })).json()
      .state,
  ).toBe("released");
});
it("fails closed on provider read failure, validates schemas and blocks deleting production", async () => {
  await enable();
  expect(
    (
      await inject(
        "POST",
        "/prepare",
        intent("vercel.redeploy", { deploymentId: "dpl_old", env: { SECRET: "bad" } }),
      )
    ).statusCode,
  ).toBe(400);
  production = "dpl_old";
  expect(
    (await inject("POST", "/prepare", intent("vercel.delete", { deploymentId: "dpl_old" })))
      .statusCode,
  ).toBe(409);
  readFailure = 429;
  expect((await inject("GET")).statusCode).toBe(429);
  expect((await inject("DELETE", "/credential")).statusCode).toBe(200);
  expect((await pool.query("SELECT count(*) FROM vercel_action_credentials")).rows[0].count).toBe(
    "0",
  );
});
it("revokes separate action credentials when deleting a user", async () => {
  await enable();
  const result = await deleteLocalUser(pool, "default", user.user.id);
  expect(result).toBe("deleted");
  expect((await pool.query("SELECT count(*) FROM vercel_action_credentials")).rows[0].count).toBe(
    "0",
  );
});
it("enforces browser-session CSRF for credential and execution routes", async () => {
  const login = await afe.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: user.token },
  });
  expect(login.statusCode).toBe(201);
  const cookies = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const blocked = await afe.app.inject({
    method: "PUT",
    url: root + "/credential",
    headers: { cookie: cookies },
    payload: { token: "action-secret", actions: ["vercel.cancel"] },
  });
  expect(blocked.statusCode).toBe(403);
  const accepted = await afe.app.inject({
    method: "PUT",
    url: root + "/credential",
    headers: { cookie: cookies, "x-afe-csrf": login.json().csrfToken },
    payload: { token: "action-secret", actions: ["vercel.cancel"] },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
});
it("denies receipts after consent removal and binds UUIDs to the original actor and intent", async () => {
  await enable();
  const b = await prepare();
  await inject("POST", "", b);
  expect(
    (await inject("POST", "", { ...b, params: { deploymentId: "dpl_old", target: "production" } }))
      .statusCode,
  ).toBe(409);
  await inject("DELETE", "/credential");
  expect((await inject("POST", "", b)).statusCode).toBe(403);
});
it("keeps requested recovery locked for two minutes and purges receipts without any events", async () => {
  await enable();
  const b = await prepare();
  failure = "network";
  await inject("POST", "", b);
  await pool.query("UPDATE vercel_action_requests SET state='requested' WHERE tenant_id='default'");
  expect(
    (await inject("POST", `/requests/${b.requestId}/release`, { acknowledgeDuplicateRisk: true }))
      .statusCode,
  ).toBe(409);
  await pool.query(
    "UPDATE vercel_action_requests SET created_at=now()-interval '3 minutes' WHERE tenant_id='default'",
  );
  expect(
    (await inject("POST", `/requests/${b.requestId}/release`, { acknowledgeDuplicateRisk: true }))
      .statusCode,
  ).toBe(200);
  await pool.query(
    "UPDATE vercel_action_requests SET created_at=now()-interval '61 days' WHERE tenant_id='default'",
  );
  await afe.jobDefinitions.find((j) => j.name === "vercel-actions.purge")!.handler({});
  expect((await pool.query("SELECT count(*) FROM vercel_action_requests")).rows[0].count).toBe("0");
});
it("rejects reusing the Profile read credential as an action credential", async () => {
  expect(
    (await inject("PUT", "/credential", { token: "read-secret", actions: ["vercel.cancel"] }))
      .statusCode,
  ).toBe(400);
  expect((await pool.query("SELECT count(*) FROM vercel_action_credentials")).rows[0].count).toBe(
    "0",
  );
});
