import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type pg from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestPool, seedLegacyToolPolicy } from "@afe/db/testing";
import { createLocalUser, storeCredential, upsertConnection, revokeCredential } from "@afe/db";
import { EnvKeyProvider } from "@afe/core/security";
import type { ArgoCdApplication } from "@afe/connector-argocd";
import { buildAfe, type AfeApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { argocdActionsModule } from "../src/actions/argocd.ts";

let pool: pg.Pool,
  afe: AfeApp,
  server: http.Server,
  user: Awaited<ReturnType<typeof createLocalUser>>;
let application: ArgoCdApplication, connectionId: string, credentialId: string;
let denied: Set<string>,
  calls: { method: string; url: URL; body: unknown; token: string }[],
  failure: number | "timeout" | null,
  logs: string;
const admin = "a".repeat(40);
const target = { group: "apps", kind: "Deployment", namespace: "prod", name: "web" };
const base = () => `/api/actions/argocd/connections/${connectionId}/applications/web`;
const url = (suffix = "", ns = "argocd") => `${base()}${suffix}?appNamespace=${ns}`;
const headers = () => ({ authorization: `Bearer ${user.token}` });
function post(suffix: string, payload: Record<string, unknown>) {
  return afe.app.inject({ method: "POST", url: url(suffix), headers: headers(), payload });
}
async function prepare(action = "argocd.sync", params: Record<string, unknown> = {}) {
  const result = await post("/prepare", { action, params });
  expect(result.statusCode, result.body).toBe(200);
  return {
    action,
    params,
    version: result.json().version,
    requestId: randomUUID(),
    confirmed: true,
  };
}
const mutations = () =>
  calls.filter((c) => c.method !== "GET" || c.url.searchParams.has("refresh"));
async function policy(mode = "source") {
  await seedLegacyToolPolicy(pool, "default", user.user.id, "argocd", {
    mode: mode as "source",
    custom: [],
  });
}
beforeEach(async () => {
  pool = await createTestPool();
  denied = new Set();
  calls = [];
  failure = null;
  logs = "";
  application = {
    metadata: { name: "web", namespace: "argocd", uid: "app-uid", resourceVersion: "42" },
    spec: {
      project: "delivery",
      source: { repoURL: "https://github.com/acme/app", targetRevision: "main" },
    },
    status: {
      sync: { status: "OutOfSync", revision: "abc123" },
      health: { status: "Healthy" },
      operationState: { phase: "Succeeded", startedAt: "2026-11-07T10:00:00Z" },
      history: [{ id: 1, revision: "abc123" }],
      resources: [{ ...target, status: "OutOfSync", health: { status: "Healthy" } }],
    },
  };
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, "http://localhost");
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      method: req.method!,
      url: u,
      body: body ? JSON.parse(body) : undefined,
      token: req.headers.authorization ?? "",
    });
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "GET" || u.searchParams.has("refresh")) {
      if (failure === "timeout") {
        req.socket.destroy();
        return;
      }
      return send(
        { secret: "upstream-secret", spec: { source: { helm: { values: "sensitive-value" } } } },
        failure ?? 200,
      );
    }
    if (u.pathname.includes("/can-i/")) {
      const permission = decodeURIComponent(u.pathname.split("/")[6]!);
      return send({ value: denied.has(permission) ? "no" : "yes" });
    }
    if (u.pathname.endsWith("/resource/actions"))
      return send({
        actions: [
          { name: "restart", disabled: false },
          { name: "disabled", disabled: true },
          { name: "parametric", params: [{ name: "value" }] },
        ],
      });
    if (u.pathname.endsWith("/managed-resources"))
      return send({
        items: [
          {
            ...target,
            diff: '{"password":"sensitive-value"}',
            liveState: "sensitive-value",
            targetState: "sensitive-value",
          },
        ],
      });
    if (u.pathname === "/api/v1/applications") return send({ items: [application] });
    if (u.pathname === "/api/v1/applications/web") return send(application);
    send({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });
  afe = await buildAfe({
    pool,
    keys,
    logLevel: "info",
    logStream: new Writable({
      write(chunk, _, cb) {
        logs += String(chunk);
        cb();
      },
    }),
    config: loadConfig({
      DATABASE_URL: "unused",
      AFE_ADMIN_TOKEN: admin,
      AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "true",
      AFE_ALLOW_INSECURE_HTTP_TARGETS: "true",
    }),
    connectors: [argocdActionsModule],
  });
  user = await createLocalUser(pool, "default", "alice");
  const c = await upsertConnection(pool, "default", {
    source: "argocd",
    externalId: "argocd",
    name: "Production",
    status: "active",
    config: { serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
  });
  connectionId = c.id;
  const cred = await storeCredential(pool, keys, "default", {
    kind: "user_argocd_token",
    secret: "personal-secret",
  });
  credentialId = cred.id;
  await pool.query(
    "INSERT INTO user_tool_accounts (tenant_id,user_id,tool,account_name,credential_id,context) VALUES ('default',$1,'argocd','alice',$2,$3)",
    [user.user.id, cred.id, JSON.stringify({ connectionId, actionsEnabled: true })],
  );
  await policy();
});
afterEach(async () => {
  await afe?.app.close();
  await pool?.end();
  server?.closeAllConnections();
  await new Promise<void>((r) => server?.close(() => r()));
});
it("lists scoped applications and discovers state, health and source capabilities without observer credentials", async () => {
  expect(
    (await afe.app.inject({ url: "/api/actions/argocd/applications", headers: headers() })).json()
      .items[0].connectionId,
  ).toBe(connectionId);
  const response = await afe.app.inject({ url: url(), headers: headers() });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().health).toBe("Healthy");
  expect(response.json().context.operationId).toBe("2026-11-07T10:00:00Z");
  expect(
    response.json().capabilities.find((c: { action: string }) => c.action === "argocd.sync")
      .enabled,
  ).toBe(true);
  expect(calls.every((c) => c.token === "Bearer personal-secret")).toBe(true);
  expect(mutations()).toHaveLength(0);
});
it("prepares, confirms, records acceptance and never fabricates completion events or stores inputs", async () => {
  const intent = await prepare("argocd.sync", {
    revision: "release-1",
    prune: true,
    resources: [target],
    syncOptions: ["PruneLast=true"],
  });
  expect((await post("/execute", intent)).statusCode).toBe(202);
  expect(mutations()).toHaveLength(1);
  expect(mutations()[0]!.body).toMatchObject({
    revision: "release-1",
    resources: [target],
    syncOptions: { items: ["PruneLast=true"] },
  });
  expect((await pool.query("SELECT count(*) FROM events")).rows[0].count).toBe("0");
  const rows = await pool.query("SELECT * FROM argocd_action_requests");
  expect(rows.rows[0].actor_id).toContain(user.user.id);
  expect(JSON.stringify(rows.rows)).not.toContain("release-1");
  expect(logs).toContain("ArgoCD action request");
  expect(logs).not.toMatch(/personal-secret|upstream-secret|sensitive-value/);
});
it("requires opt-in even for refresh and rechecks exact source RBAC at execution and replay", async () => {
  const intent = await prepare();
  denied.add("sync");
  expect((await post("/execute", intent)).statusCode).toBe(403);
  denied.clear();
  expect((await post("/execute", intent)).statusCode).toBe(202);
  denied.add("sync");
  expect((await post("/execute", intent)).statusCode).toBe(403);
  denied.clear();
  await afe.app.inject({
    method: "PUT",
    url: "/api/actions/argocd/consent",
    headers: headers(),
    payload: { enabled: false },
  });
  expect((await post("/prepare", { action: "argocd.refresh", params: {} })).statusCode).toBe(403);
  expect((await post("/execute", intent)).statusCode).toBe(403);
  expect(mutations()).toHaveLength(1);
});
it("rejects unauthenticated/static admin/other tenant/wrong connection and namespace before any mutation", async () => {
  expect((await afe.app.inject({ url: url() })).statusCode).toBe(401);
  expect(
    (await afe.app.inject({ url: url(), headers: { authorization: `Bearer ${admin}` } }))
      .statusCode,
  ).toBe(403);
  await pool.query("INSERT INTO tenants(id,name) VALUES ('other','Other')");
  const other = await createLocalUser(pool, "other", "bob");
  expect(
    (await afe.app.inject({ url: url(), headers: { authorization: `Bearer ${other.token}` } }))
      .statusCode,
  ).toBe(403);
  expect(
    (await afe.app.inject({ url: url().replace(connectionId, randomUUID()), headers: headers() }))
      .statusCode,
  ).toBe(404);
  expect((await afe.app.inject({ url: url("", "other"), headers: headers() })).statusCode).toBe(
    502,
  );
  expect(mutations()).toHaveLength(0);
});
it.each(["none", "custom", "source + custom"])("fails closed for %s policy", async (mode) => {
  await policy(mode);
  expect((await post("/prepare", { action: "argocd.sync", params: {} })).statusCode).toBe(403);
  expect(calls).toHaveLength(0);
});
it("rejects inactive/agent connections and expired/changed OIDC bindings", async () => {
  await pool.query(
    "UPDATE connections SET config=config || '{\"mode\":\"agent\"}'::jsonb WHERE tenant_id='default' AND id=$1",
    [connectionId],
  );
  expect((await post("/prepare", { action: "argocd.sync", params: {} })).statusCode).toBe(409);
  await pool.query(
    "UPDATE connections SET config=config-'mode',status='disconnected' WHERE tenant_id='default' AND id=$1",
    [connectionId],
  );
  expect((await post("/prepare", { action: "argocd.sync", params: {} })).statusCode).toBe(409);
  await pool.query("UPDATE connections SET status='active' WHERE tenant_id='default' AND id=$1", [
    connectionId,
  ]);
  await pool.query(
    'UPDATE user_tool_accounts SET context=context || \'{"oidcRevision":"old","expiresAt":1}\'::jsonb WHERE tenant_id=\'default\'',
  );
  expect((await post("/prepare", { action: "argocd.sync", params: {} })).statusCode).toBe(403);
  expect(calls).toHaveLength(0);
});
it("validates strict parameters, current state, resource ownership and deployment history", async () => {
  for (const [action, params] of [
    ["argocd.sync", { manifests: ["secret"] }],
    ["argocd.sync", { syncOptions: ["Unknown=true"] }],
    ["argocd.sync", { revision: "one", revisions: ["two"] }],
    ["unknown", {}],
  ])
    expect((await post("/prepare", { action, params })).statusCode).toBe(400);
  expect(
    (
      await post("/prepare", {
        action: "argocd.sync",
        params: { resources: [{ ...target, name: "foreign" }] },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await post("/prepare", { action: "argocd.rollback", params: { id: 999 } })).statusCode,
  ).toBe(409);
  application.spec!.syncPolicy = { automated: {} };
  expect(
    (await post("/prepare", { action: "argocd.rollback", params: { id: 1 } })).statusCode,
  ).toBe(409);
  application.operation = { sync: {} };
  expect((await post("/prepare", { action: "argocd.sync", params: {} })).statusCode).toBe(409);
});
it("rejects stale resource versions and replaced application UIDs before dispatch", async () => {
  const intent = await prepare();
  application.metadata!.resourceVersion = "43";
  expect((await post("/execute", intent)).statusCode).toBe(409);
  application.metadata!.resourceVersion = "42";
  application.metadata!.uid = "replacement";
  expect((await post("/execute", intent)).statusCode).toBe(409);
  expect(mutations()).toHaveLength(0);
});
it("deduplicates concurrent submissions, all mutation variants and changed input UUID reuse", async () => {
  const intent = await prepare();
  const results = await Promise.all([post("/execute", intent), post("/execute", intent)]);
  expect(results.some((r) => r.statusCode === 202)).toBe(true);
  expect((await post("/execute", intent)).json().state).toBe("accepted");
  expect((await post("/execute", { ...intent, params: { prune: true } })).statusCode).toBe(409);
  expect((await post("/execute", { ...intent, requestId: randomUUID() })).statusCode).toBe(409);
  expect(
    (
      await post(
        "/execute",
        await prepare("argocd.delete", { cascade: false, propagationPolicy: "foreground" }),
      )
    ).statusCode,
  ).toBe(409);
  expect(mutations()).toHaveLength(1);
});
it.each([403, 429, 500, "timeout"] as const)(
  "never retries a mutation on %s; keeps sanitized receipts and explicit recovery",
  async (f) => {
    failure = f;
    const intent = await prepare();
    const result = await post("/execute", intent);
    expect(result.json().state).toBe(f === 403 || f === 429 ? "rejected" : "unknown");
    expect(result.body).not.toMatch(/upstream-secret|sensitive-value/);
    expect((await post("/execute", intent)).json().state).toBe(result.json().state);
    expect(mutations()).toHaveLength(1);
    if (result.json().state === "unknown") {
      expect((await post("/execute", { ...intent, requestId: randomUUID() })).statusCode).toBe(409);
      expect((await post("/recover", { requestId: intent.requestId })).statusCode).toBe(400);
      expect(
        (
          await post("/recover", { requestId: intent.requestId, acknowledgeDuplicateRisk: true })
        ).json().state,
      ).toBe("released");
    }
  },
);
it("waits two minutes before in-flight recovery and isolates request history by actor and target", async () => {
  const intent = await prepare();
  await post("/execute", intent);
  await pool.query("UPDATE argocd_action_requests SET state='requested' WHERE tenant_id='default'");
  expect(
    (await post("/recover", { requestId: intent.requestId, acknowledgeDuplicateRisk: true }))
      .statusCode,
  ).toBe(409);
  await pool.query(
    "UPDATE argocd_action_requests SET created_at=now()-interval '3 minutes' WHERE tenant_id='default'",
  );
  expect(
    (await post("/recover", { requestId: intent.requestId, acknowledgeDuplicateRisk: true }))
      .statusCode,
  ).toBe(200);
  expect(
    (await afe.app.inject({ url: url("/history"), headers: headers() })).json().items,
  ).toHaveLength(1);
});
it("revalidates credentials and account policies for stored receipt replays", async () => {
  const intent = await prepare();
  await post("/execute", intent);
  await revokeCredential(pool, "default", credentialId);
  expect((await post("/execute", intent)).statusCode).toBe(403);
  expect(mutations()).toHaveLength(1);
});
it("enforces CSRF, foreign-origin rejection and explicit confirmation", async () => {
  const intent = await prepare();
  expect((await post("/execute", { ...intent, confirmed: false })).statusCode).toBe(400);
  const login = await afe.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: user.token },
  });
  const cookie = (login.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]).join("; ");
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: url("/execute"),
        headers: { cookie },
        payload: intent,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: url("/execute"),
        headers: { ...headers(), origin: "https://evil.example" },
        payload: intent,
      })
    ).statusCode,
  ).toBe(403);
  expect(mutations()).toHaveLength(0);
});
it("maps multi-source revisions to source positions and resource actions to exact source permissions", async () => {
  application.spec!.sources = [
    { repoURL: "https://github.com/acme/a" },
    { repoURL: "https://github.com/acme/b" },
  ];
  expect(
    (await post("/prepare", { action: "argocd.sync", params: { revisions: ["a"] } })).statusCode,
  ).toBe(400);
  expect(
    (await post("/execute", await prepare("argocd.sync", { revisions: ["a", "b"] }))).statusCode,
  ).toBe(202);
  expect(mutations()[0]!.body).toMatchObject({
    revisions: ["a", "b"],
    sourcePositions: ["1", "2"],
  });
  application.metadata!.resourceVersion = "43";
  denied.add("action/apps/Deployment/restart");
  expect(
    (
      await post("/prepare", {
        action: "argocd.resource_action",
        params: { resource: target, name: "restart" },
      })
    ).statusCode,
  ).toBe(403);
  denied.clear();
  expect(
    (
      await post("/prepare", {
        action: "argocd.resource_action",
        params: { resource: target, name: "disabled" },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await post(
        "/execute",
        await prepare("argocd.resource_action", { resource: target, name: "restart" }),
      )
    ).statusCode,
  ).toBe(202);
  expect(mutations()[1]!.body).toBe("restart");
});
it("uses provider compare-and-swap for sync policy without returning secret spec values", async () => {
  application.spec!.source!.helm = { values: "sensitive-value" };
  const intent = await prepare("argocd.sync_policy", {
    automated: true,
    prune: false,
    selfHeal: true,
    allowEmpty: false,
  });
  expect((await post("/execute", intent)).statusCode).toBe(202);
  const mutation = mutations()[0]!;
  expect(mutation.method).toBe("PATCH");
  expect(JSON.parse((mutation.body as { patch: string }).patch)[0]).toEqual({
    op: "test",
    path: "/metadata/resourceVersion",
    value: "42",
  });
  const view = await afe.app.inject({ url: url(), headers: headers() });
  const diff = await afe.app.inject({ url: url("/diff"), headers: headers() });
  expect(diff.json().items[0].changed).toBe(true);
  expect(view.body + diff.body + logs).not.toContain("sensitive-value");
});
it.each([
  "argocd.refresh",
  "argocd.hard_refresh",
  "argocd.rollback",
  "argocd.terminate",
  "argocd.delete",
])("dispatches %s exactly once", async (action) => {
  if (action === "argocd.terminate") application.operation = { sync: {} };
  const params =
    action === "argocd.rollback"
      ? { id: 1 }
      : action === "argocd.delete"
        ? { cascade: false, propagationPolicy: "foreground" }
        : {};
  const intent = await prepare(action, params);
  expect((await post("/execute", intent)).statusCode).toBe(202);
  expect(mutations()).toHaveLength(1);
  expect((await post("/execute", intent)).json().state).toBe("accepted");
  expect(mutations()).toHaveLength(1);
});
it("purges receipts using the tenant retention policy", async () => {
  await post("/execute", await prepare());
  await pool.query(
    "UPDATE argocd_action_requests SET created_at=now()-interval '31 days' WHERE tenant_id='default'",
  );
  await afe.jobDefinitions.find((j) => j.name === "argocd-actions.purge")!.handler({});
  expect(
    (await pool.query("SELECT count(*) FROM argocd_action_requests WHERE tenant_id='default'"))
      .rows[0].count,
  ).toBe("0");
});
