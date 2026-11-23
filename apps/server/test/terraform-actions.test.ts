import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import type pg from "pg";
import { createTestPool, seedLegacyToolPolicy } from "@afe/db/testing";
import {
  createLocalUser,
  upsertConnection,
  storeCredential,
  revokeCredential,
  setUserToolPolicy,
} from "@afe/db";
import { EnvKeyProvider } from "@afe/core/security";
import type { TerraformOperationInput } from "@afe/core";
import { buildAfe, type AfeApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { terraformActionsModule } from "../src/actions/terraform.ts";
import { terraformModule } from "../src/connectors/terraform.ts";
import { terraformScope, terraformSourceAccess } from "../src/actions/terraform-identity.ts";

let pool: pg.Pool, afe: AfeApp, user: Awaited<ReturnType<typeof createLocalUser>>, server: Server;
let origin: string, connectionId: string, credentialId: string;
let allow = true,
  actionsEnabled = true,
  runWorkspace = "ws-alpha",
  state = "planned",
  locked = false;
let mutationStatus: number | "disconnect" = 204,
  readStatus = 200,
  policyStatus = "soft_failed",
  mutateOnRead = false;
let permissionOverrides: Record<string, boolean> = {};
let posts: { path: string; body: unknown }[] = [],
  logs: string[] = [];
const admin = "a".repeat(40);
const root = () => `/api/actions/terraform/connections/${connectionId}`;
const headers = () => ({ authorization: `Bearer ${user.token}` });
const permissions = () => ({
  ...Object.fromEntries(
    [
      "can-queue-run",
      "can-lock",
      "can-unlock",
      "can-apply",
      "can-discard",
      "can-cancel",
      "can-force-cancel",
      "can-override-policy-check",
      "can-override",
    ].map((p) => [p, allow]),
  ),
  ...permissionOverrides,
});
const workspace = () => ({
  id: "ws-alpha",
  type: "workspaces",
  attributes: {
    name: "production",
    locked,
    "execution-mode": "remote",
    permissions: permissions(),
  },
  relationships: { organization: { data: { id: "acme" } } },
});
const run = (id = "run-alpha") => ({
  id,
  type: "runs",
  attributes: {
    status: state,
    permissions: permissions(),
    actions: {
      "is-confirmable": state === "planned",
      "is-discardable": true,
      "is-cancelable": state === "applying",
      "is-force-cancelable": state === "applying",
    },
    variables: [{ key: "secret", value: "PROVIDER_SECRET" }],
  },
  relationships: {
    workspace: { data: { id: runWorkspace } },
    plan: { data: { id: "plan-alpha" } },
    apply: { data: { id: "apply-alpha" } },
  },
});
const policy = () => ({
  id: "polchk-alpha",
  type: "policy-checks",
  attributes: {
    status: policyStatus,
    permissions: permissions(),
    actions: { "is-overridable": true },
  },
  relationships: { run: { data: { id: "run-alpha" } } },
});
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = req.url!.split("?")[0]!;
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/vnd.api+json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== "Bearer PERSONAL_TOKEN")
      return json({ secret: "PROVIDER_SECRET" }, 401);
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      posts.push({
        path,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
      });
      if (mutationStatus === "disconnect") {
        req.socket.destroy();
        return;
      }
      if (mutationStatus === 429) res.setHeader("retry-after", "7");
      if (mutationStatus !== 204) return json({ secret: "PROVIDER_SECRET" }, mutationStatus);
      if (path === "/api/v2/runs") return json({ data: run("run-created") }, 201);
      res.writeHead(204);
      res.end();
      return;
    }
    if (readStatus !== 200) return json({ secret: "PROVIDER_SECRET" }, readStatus);
    if (path === "/api/v2/account/details")
      return json({ data: { id: "user-alice", type: "users", attributes: { username: "alice" } } });
    if (path === "/api/v2/workspaces/ws-alpha") {
      const ws = workspace();
      if (mutateOnRead) {
        locked = !locked;
        mutateOnRead = false;
      }
      return json({ data: ws });
    }
    if (path === "/api/v2/workspaces/ws-alpha/runs")
      return json({ data: [run()], meta: { pagination: { "next-page": null } } });
    if (path === "/api/v2/plans/plan-alpha")
      return json({
        data: {
          id: "plan-alpha",
          type: "plans",
          attributes: {
            "resource-additions": 2,
            "resource-changes": 1,
            "resource-destructions": 0,
            "log-read-url": "https://secret.example/log",
          },
        },
      });
    if (path === "/api/v2/runs/run-alpha") return json({ data: run() });
    if (path === "/api/v2/runs/run-alpha/policy-checks") return json({ data: [policy()] });
    if (path === "/api/v2/policy-checks/polchk-alpha") return json({ data: policy() });
    return json({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  pool = await createTestPool();
  posts = [];
  logs = [];
  allow = true;
  permissionOverrides = {};
  actionsEnabled = true;
  runWorkspace = "ws-alpha";
  state = "planned";
  locked = false;
  mutationStatus = 204;
  readStatus = 200;
  policyStatus = "soft_failed";
  mutateOnRead = false;
  const keys = new EnvKeyProvider({ keys: { k: randomBytes(32) } });
  afe = await buildAfe({
    pool,
    keys,
    config: loadConfig({
      DATABASE_URL: "unused",
      AFE_ADMIN_TOKEN: admin,
      AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "true",
      AFE_ALLOW_INSECURE_HTTP_TARGETS: "true",
    }),
    connectors: [terraformActionsModule, terraformModule],
    logLevel: "info",
    logStream: new Writable({
      write(chunk, _e, cb) {
        logs.push(String(chunk));
        cb();
      },
    }),
  });
  user = await createLocalUser(pool, "default", "alice");
  await setUserToolPolicy(pool, "default", user.user.id, "terraform", {
    mode: "source",
    custom: [],
  });
  connectionId = (
    await upsertConnection(pool, "default", {
      source: "terraform",
      externalId: "remote-test",
      name: "acme/production",
      status: "active",
      config: { serverUrl: origin, organization: "acme", workspaceId: "ws-alpha" },
    })
  ).id;
  credentialId = (
    await storeCredential(pool, keys, "default", {
      kind: "user_terraform_token",
      secret: "PERSONAL_TOKEN",
    })
  ).id;
  await pool.query(
    "INSERT INTO user_tool_accounts (tenant_id,user_id,tool,account_name,credential_id,context) VALUES ('default',$1,'terraform','alice',$2,$3)",
    [
      user.user.id,
      credentialId,
      JSON.stringify({ serverUrl: origin, accountId: "user-alice", actionsEnabled }),
    ],
  );
});
afterEach(async () => {
  await afe.app.close();
  await pool.end();
});
async function prepare(
  operation: TerraformOperationInput = { action: "terraform.apply", runId: "run-alpha" },
) {
  const res = await afe.app.inject({
    method: "POST",
    url: `${root()}/prepare`,
    headers: headers(),
    payload: operation,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { operation, version: res.json().version, requestId: randomUUID(), confirmed: true };
}
const execute = (payload: object) =>
  afe.app.inject({ method: "POST", url: `${root()}/execute`, headers: headers(), payload });
it("uses the shared catalog, reads plan metadata and records a sanitized confirmed outcome", async () => {
  const res = await afe.app.inject({ url: root(), headers: headers() });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.json().runs[0]).toMatchObject({
    id: "run-alpha",
    planId: "plan-alpha",
    applyId: "apply-alpha",
    changes: { additions: 2, changes: 1, destructions: 0 },
  });
  expect(res.body).not.toContain("PROVIDER_SECRET");
  expect(res.body).not.toContain("secret.example");
  const input = await prepare();
  const result = await execute(input);
  expect(result.statusCode, result.body).toBe(202);
  expect(result.json().state).toBe("accepted");
  expect(posts).toEqual([{ path: "/api/v2/runs/run-alpha/actions/apply", body: null }]);
  expect((await execute(input)).json().state).toBe("accepted");
  expect(posts).toHaveLength(1);
  expect((await pool.query("SELECT count(*) FROM events")).rows[0].count).toBe("0");
  const evidence = (await pool.query("SELECT * FROM terraform_action_requests")).rows;
  expect(JSON.stringify(evidence) + logs.join("")).not.toMatch(
    /PERSONAL_TOKEN|PROVIDER_SECRET|secret.example/,
  );
});
it("queues speculative plans and confirmable runs with auto-apply and destroy disabled", async () => {
  for (const action of ["terraform.plan", "terraform.run"] as const) {
    const res = await execute(await prepare({ action }));
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().resultRunId).toBe("run-created");
  }
  expect(posts.map((p) => (p.body as { data: { attributes: unknown } }).data.attributes)).toEqual([
    { "plan-only": true, "auto-apply": false, "is-destroy": false },
    { "plan-only": false, "auto-apply": false, "is-destroy": false },
  ]);
});
it("requires opt-in, a linked personal identity, Source mode and current action permissions", async () => {
  const input = await prepare();
  allow = false;
  expect((await execute(input)).statusCode).toBe(403);
  allow = true;
  await pool.query(
    "UPDATE user_tool_accounts SET context=context || '{\"actionsEnabled\":false}'::jsonb",
  );
  expect((await execute(input)).statusCode).toBe(403);
  await pool.query(
    "UPDATE user_tool_accounts SET context=context || '{\"actionsEnabled\":true}'::jsonb",
  );
  await seedLegacyToolPolicy(pool, "default", user.user.id, "terraform", {
    mode: "source + custom",
    custom: [],
  });
  expect((await execute(input)).statusCode).toBe(403);
  await setUserToolPolicy(pool, "default", user.user.id, "terraform", {
    mode: "source",
    custom: [],
  });
  await revokeCredential(pool, "default", credentialId);
  expect((await execute(input)).statusCode).toBe(403);
  expect(posts).toHaveLength(0);
});
it("rechecks permission on receipt replay and binds request IDs to actors and exact inputs", async () => {
  const input = await prepare();
  expect((await execute(input)).statusCode).toBe(202);
  expect(
    (await execute({ ...input, operation: { action: "terraform.discard", runId: "run-alpha" } }))
      .statusCode,
  ).toBe(409);
  allow = false;
  expect((await execute(input)).statusCode).toBe(403);
  expect(posts).toHaveLength(1);
});
it("isolates tenants, connections, workspaces, local reporters and static credentials", async () => {
  await pool.query("INSERT INTO tenants(id,name) VALUES ('other','Other')");
  const other = await createLocalUser(pool, "other", "bob");
  expect(
    (await afe.app.inject({ url: root(), headers: { authorization: `Bearer ${other.token}` } }))
      .statusCode,
  ).toBe(404);
  expect(
    (await afe.app.inject({ url: root(), headers: { authorization: `Bearer ${admin}` } }))
      .statusCode,
  ).toBe(403);
  runWorkspace = "ws-other";
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: `${root()}/prepare`,
        headers: headers(),
        payload: { action: "terraform.apply", runId: "run-alpha" },
      })
    ).statusCode,
  ).toBe(404);
  const local = await upsertConnection(pool, "default", {
    source: "terraform",
    externalId: randomUUID(),
    name: "local",
    status: "active",
    config: { workspace: "production" },
  });
  await expect(
    terraformScope(afe.context, "default", user.user.id, local.id),
  ).rejects.toMatchObject({ statusCode: 404 });
  runWorkspace = "ws-alpha";
  expect(await terraformSourceAccess(afe.context, "default", user.user.id)).toEqual([
    { source: "terraform", resource: `connection:${connectionId}`, connectionId },
  ]);
  expect(posts).toHaveLength(0);
});
it("validates schemas, confirmation, source versions and source changes after locking", async () => {
  const input = await prepare();
  for (const payload of [
    { ...input, confirmed: false },
    { ...input, unexpected: "x" },
    { ...input, operation: { action: "terraform.run", variables: { secret: "x" } } },
    { ...input, operation: { action: "terraform.apply", runId: "../elsewhere" } },
    { ...input, version: "bad" },
  ])
    expect((await execute(payload)).statusCode).toBe(400);
  locked = true;
  expect((await execute(input)).statusCode).toBe(409);
  locked = false;
  mutateOnRead = true;
  expect((await execute(input)).statusCode).toBe(409);
  expect(posts).toHaveLength(0);
});
it.each([429, 403, 500, "disconnect"] as const)(
  "does not retry provider mutation failure %s and preserves uncertain locks",
  async (failure) => {
    const input = await prepare();
    mutationStatus = failure;
    const res = await execute(input);
    expect(res.statusCode).toBe(failure === 429 ? 429 : failure === 403 ? 409 : 502);
    expect(res.json().state).toBe(failure === 429 || failure === 403 ? "rejected" : "unknown");
    expect(res.body).not.toContain("PROVIDER_SECRET");
    expect(posts).toHaveLength(1);
    await execute(input);
    expect(posts).toHaveLength(1);
    if (failure === 429) expect(res.headers["retry-after"]).toBe("7");
    if (failure === 500 || failure === "disconnect") {
      expect((await execute({ ...input, requestId: randomUUID() })).statusCode).toBe(409);
      const url = `${root()}/requests/${input.requestId}/recover`;
      expect(
        (
          await afe.app.inject({
            method: "POST",
            url,
            headers: headers(),
            payload: { confirmed: true },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await afe.app.inject({
            method: "POST",
            url,
            headers: headers(),
            payload: { confirmed: true, acknowledgeDuplicateRisk: true },
          })
        ).statusCode,
      ).toBe(200);
      mutationStatus = 204;
      expect((await execute({ ...input, requestId: randomUUID() })).statusCode).toBe(202);
    }
  },
);
it("serializes concurrent requests for a run", async () => {
  const input = await prepare();
  const results = await Promise.all([
    execute(input),
    execute({ ...input, requestId: randomUUID() }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
  expect(posts).toHaveLength(1);
});
it("validates policy ownership and permissions separately from apply approval", async () => {
  state = "policy_override";
  const input = await prepare({
    action: "terraform.policy_override",
    runId: "run-alpha",
    policyCheckId: "polchk-alpha",
  });
  policyStatus = "hard_failed";
  expect((await execute(input)).statusCode).toBe(409);
  policyStatus = "soft_failed";
  expect((await execute(input)).statusCode).toBe(202);
  expect(posts[0]?.path).toBe("/api/v2/policy-checks/polchk-alpha/actions/override");
});
it("links only a verified personal token and defaults operation opt-in off", async () => {
  const res = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/terraform/token",
    headers: headers(),
    payload: { connectionId, token: "PERSONAL_TOKEN" },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(
    (
      await pool.query(
        "SELECT context FROM user_tool_accounts WHERE tenant_id='default' AND user_id=$1",
        [user.user.id],
      )
    ).rows[0].context.actionsEnabled,
  ).toBe(false);
  const controls = await afe.app.inject({ url: root(), headers: headers() });
  expect(controls.json().capabilities.every((c: { enabled: boolean }) => !c.enabled)).toBe(true);
  expect(
    (await afe.app.inject({ url: "/api/profile", headers: headers() }))
      .json()
      .tools.find((t: { tool: string }) => t.tool === "terraform").sourceAvailable,
  ).toBe(true);
});
it("validates remote origins and handles provider read outages without mutations", async () => {
  const adminHeaders = { authorization: `Bearer ${admin}` };
  for (const serverUrl of [
    "https://user:password@example.com",
    "https://example.com/path",
    "https://169.254.169.254",
  ])
    expect(
      (
        await afe.app.inject({
          method: "POST",
          url: "/api/connections/terraform/remote",
          headers: adminHeaders,
          payload: { serverUrl, organization: "acme", workspaceId: "ws-alpha" },
        })
      ).statusCode,
    ).toBe(400);
  readStatus = 429;
  expect((await afe.app.inject({ url: root(), headers: headers() })).statusCode).toBe(429);
  expect(posts).toHaveLength(0);
});

it.each([
  ["terraform.discard", "planned", false, "/api/v2/runs/run-alpha/actions/discard"],
  ["terraform.cancel", "applying", false, "/api/v2/runs/run-alpha/actions/cancel"],
  ["terraform.force_cancel", "applying", false, "/api/v2/runs/run-alpha/actions/force-cancel"],
  ["terraform.lock", "planned", false, "/api/v2/workspaces/ws-alpha/actions/lock"],
  ["terraform.unlock", "planned", true, "/api/v2/workspaces/ws-alpha/actions/unlock"],
] as const)(
  "executes %s only against the checked source target",
  async (action, status, isLocked, path) => {
    state = status;
    locked = isLocked;
    const operation: TerraformOperationInput =
      action === "terraform.lock" || action === "terraform.unlock"
        ? { action }
        : { action, runId: "run-alpha" };
    expect((await execute(await prepare(operation))).statusCode).toBe(202);
    expect(posts).toEqual([{ path, body: null }]);
  },
);
it("never infers apply authority from plan/queue access", async () => {
  permissionOverrides = { "can-apply": false };
  const view = await afe.app.inject({ url: root(), headers: headers() });
  expect(
    view.json().capabilities.find((c: { action: string }) => c.action === "terraform.plan").enabled,
  ).toBe(true);
  expect(
    view.json().runs[0].capabilities.find((c: { action: string }) => c.action === "terraform.apply")
      .enabled,
  ).toBe(false);
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: `${root()}/prepare`,
        headers: headers(),
        payload: { action: "terraform.apply", runId: "run-alpha" },
      })
    ).statusCode,
  ).toBe(403);
  expect(posts).toHaveLength(0);
});
it("requires the original actor and minimum pending age for recovery", async () => {
  const input = await prepare();
  mutationStatus = 500;
  await execute(input);
  const url = `${root()}/requests/${input.requestId}/recover`,
    payload = { confirmed: true, acknowledgeDuplicateRisk: true };
  await pool.query(
    "UPDATE terraform_action_requests SET state='requested' WHERE tenant_id='default' AND request_id=$1",
    [input.requestId],
  );
  expect(
    (await afe.app.inject({ method: "POST", url, headers: headers(), payload })).statusCode,
  ).toBe(409);
  await pool.query(
    "UPDATE terraform_action_requests SET created_at=now()-interval '3 minutes',actor_id='another-actor' WHERE tenant_id='default' AND request_id=$1",
    [input.requestId],
  );
  expect(
    (await afe.app.inject({ method: "POST", url, headers: headers(), payload })).statusCode,
  ).toBe(409);
  await pool.query(
    "UPDATE terraform_action_requests SET actor_id=$2 WHERE tenant_id='default' AND request_id=$1",
    [input.requestId, `local:${user.user.id}`],
  );
  expect(
    (await afe.app.inject({ method: "POST", url, headers: headers(), payload })).json().state,
  ).toBe("released");
  expect(posts).toHaveLength(1);
});
it("records the administrator actor when selecting a remote connection", async () => {
  const response = await afe.app.inject({
    method: "POST",
    url: "/api/connections/terraform/remote",
    headers: { authorization: `Bearer ${admin}` },
    payload: { serverUrl: origin, organization: "acme", workspaceId: "ws-alpha" },
  });
  expect(response.statusCode, response.body).toBe(201);
  const events = (
    await pool.query(
      "SELECT actor,action FROM events WHERE tenant_id='default' AND connection_id=$1",
      [response.json().connection.id],
    )
  ).rows;
  expect(events).toHaveLength(1);
  expect(events[0].action).toBe("connection.created");
  expect(events[0].actor.id).toMatch(/^admin-token:/);
});
