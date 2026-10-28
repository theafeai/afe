import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type pg from "pg";
import { createTestPool } from "@afe/db/testing";
import {
  createLocalUser,
  upsertConnection,
  ingestEvent,
  setUserToolPolicy,
  storeCredential,
} from "@afe/db";
import { EnvKeyProvider } from "@afe/core/security";
import { buildAfe, type AfeApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { githubActionsModule } from "../src/actions/github.ts";
let pool: pg.Pool, afe: AfeApp, user: Awaited<ReturnType<typeof createLocalUser>>;
let eventId: string, connectionId: string;
let write = true,
  attempt = 1,
  status = "completed",
  failure: number | "network" | null = null;
let requests: { method: string; path: string }[];
const admin = "a".repeat(40);
const url = () => `/api/actions/github/events/${eventId}`;
const headers = () => ({ authorization: `Bearer ${user.token}` });
async function policy(mode: "none" | "source" | "source + custom" = "source + custom") {
  await setUserToolPolicy(pool, "default", user.user.id, "github", {
    mode,
    custom: ["github.cancel", "github.rerun", "github.rerun_failed"].map((action) => ({
      resource: "repository:acme/app",
      action,
    })),
  });
}
function post(
  payload = {
    action: "github.rerun",
    expectedAttempt: 1,
    requestId: randomUUID(),
    confirmed: true,
  },
) {
  return afe.app.inject({ method: "POST", url: url(), headers: headers(), payload });
}
beforeEach(async () => {
  pool = await createTestPool();
  requests = [];
  write = true;
  attempt = 1;
  status = "completed";
  failure = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ method: init.method!, path });
    if (init.method === "POST") {
      if (failure === "network") throw new Error("upstream secret must not leak");
      return new Response(failure ? '{"secret":"do not expose"}' : null, {
        status: failure ?? 201,
      });
    }
    if (path === "/repos/acme/app") return Response.json({ permissions: { push: write } });
    if (path === "/repos/acme/app/actions/runs/123")
      return Response.json({
        id: 123,
        run_attempt: attempt,
        repository: { full_name: "acme/app" },
        status,
        conclusion: status === "completed" ? "failure" : null,
      });
    throw new Error(`Unexpected request ${path}`);
  });
  const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });
  afe = await buildAfe({
    pool,
    logLevel: "silent",
    keys,
    config: loadConfig({ DATABASE_URL: "unused", AFE_ADMIN_TOKEN: admin }),
    connectors: [githubActionsModule],
  });
  user = await createLocalUser(pool, "default", "alice");
  const c = await upsertConnection(pool, "default", {
    source: "github",
    externalId: "9",
    name: "acme",
    status: "active",
    config: {},
  });
  connectionId = c.id;
  const result = await ingestEvent(pool, "default", {
    source: "github",
    sourceEventId: "run:123",
    connectionId: c.id,
    action: "workflow_run.completed",
    actor: { type: "user", login: "alice" },
    target: { type: "workflow_run", id: "acme/app/actions/runs/123", repository: "acme/app" },
    trigger: { type: "manual" },
    outcome: "failed",
    occurredAt: new Date(),
    observedAt: new Date(),
    observation: { method: "webhook" },
    correlation: { runIds: ["github:123"] },
    data: {},
  });
  eventId = result.event!.id;
  const credential = await storeCredential(pool, keys, "default", {
    kind: "user_github_token",
    secret: "user-secret",
  });
  await pool.query(
    "INSERT INTO user_tool_accounts (tenant_id,user_id,tool,account_name,credential_id,context) VALUES ($1,$2,'github','alice',$3,'{}')",
    ["default", user.user.id, credential.id],
  );
  await policy();
});
afterEach(async () => {
  await afe?.app.close();
  await pool?.end();
  vi.unstubAllGlobals();
});
it("discovers current state and accepts a confirmed rerun without fabricating a deployment event", async () => {
  const controls = await afe.app.inject({ url: url(), headers: headers() });
  expect(controls.statusCode).toBe(200);
  expect(controls.json().context).toEqual({
    connectionId,
    repository: "acme/app",
    runId: 123,
    runAttempt: 1,
  });
  expect(controls.json().capabilities.filter((c: { enabled: boolean }) => c.enabled)).toHaveLength(
    2,
  );
  expect((await post()).statusCode).toBe(202);
  expect(requests.filter((r) => r.method === "POST")).toEqual([
    { method: "POST", path: "/repos/acme/app/actions/runs/123/rerun" },
  ]);
  expect((await pool.query("SELECT count(*) FROM events")).rows[0].count).toBe("1");
});
it("requires explicit grants plus current upstream write access", async () => {
  await policy("source");
  expect((await post()).statusCode).toBe(403);
  await policy();
  write = false;
  expect((await post()).statusCode).toBe(403);
  write = true;
  await policy("none");
  expect((await post()).statusCode).toBe(404);
  expect(requests.every((r) => r.method === "GET")).toBe(true);
});
it("rejects other tenants, unauthenticated callers and legacy admin tokens", async () => {
  expect((await afe.app.inject({ url: url() })).statusCode).toBe(401);
  expect(
    (await afe.app.inject({ url: url(), headers: { authorization: `Bearer ${admin}` } }))
      .statusCode,
  ).toBe(403);
  await pool.query("INSERT INTO tenants (id,name) VALUES ('other','Other')");
  const other = await createLocalUser(pool, "other", "bob");
  expect(
    (await afe.app.inject({ url: url(), headers: { authorization: `Bearer ${other.token}` } }))
      .statusCode,
  ).toBe(404);
  expect(requests).toHaveLength(0);
});
it("rejects stale attempts, wrong state, missing confirmation and unknown actions", async () => {
  attempt = 2;
  expect((await post()).statusCode).toBe(409);
  attempt = 1;
  status = "in_progress";
  expect((await post()).statusCode).toBe(409);
  expect(
    (
      await post({
        action: "github.cancel",
        expectedAttempt: 1,
        requestId: randomUUID(),
        confirmed: false,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await post({ action: "delete", expectedAttempt: 1, requestId: randomUUID(), confirmed: true }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await post({
        action: "github.cancel",
        expectedAttempt: 1,
        requestId: randomUUID(),
        confirmed: true,
      })
    ).statusCode,
  ).toBe(202);
});
it("deduplicates concurrent and replayed reruns across both rerun variants", async () => {
  const payload = {
    action: "github.rerun",
    expectedAttempt: 1,
    requestId: randomUUID(),
    confirmed: true,
  };
  const results = await Promise.all([post(payload), post(payload)]);
  expect(results.some((r) => r.statusCode === 202)).toBe(true);
  expect((await post(payload)).json().state).toBe("accepted");
  expect(
    (await post({ ...payload, action: "github.rerun_failed", requestId: randomUUID() })).statusCode,
  ).toBe(409);
  expect((await post({ ...payload, action: "github.cancel" })).statusCode).toBe(409);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
});
it.each([403, 500, "network"] as const)(
  "does not retry uncertain or rejected mutations (%s)",
  async (f) => {
    failure = f;
    const payload = {
      action: "github.rerun",
      expectedAttempt: 1,
      requestId: randomUUID(),
      confirmed: true,
    };
    const r = await post(payload);
    expect(r.json().state).toBe(f === 403 ? "rejected" : "unknown");
    expect(r.body).not.toContain("secret");
    expect((await post(payload)).json().state).toBe(f === 403 ? "rejected" : "unknown");
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  },
);
it("requires CSRF for cookie requests and denies foreign origins", async () => {
  const login = await afe.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: user.token },
  });
  const cookie = (login.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]).join("; ");
  const payload = {
    action: "github.rerun",
    expectedAttempt: 1,
    requestId: randomUUID(),
    confirmed: true,
  };
  expect(
    (await afe.app.inject({ method: "POST", url: url(), headers: { cookie }, payload })).statusCode,
  ).toBe(403);
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: url(),
        headers: { ...headers(), origin: "https://evil.example" },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(requests).toHaveLength(0);
});
it("does not treat read or wrong-repository grants as action permission", async () => {
  await setUserToolPolicy(pool, "default", user.user.id, "github", {
    mode: "source + custom",
    custom: [
      { resource: "repository:acme/app", action: "read" },
      { resource: "repository:acme/other", action: "github.rerun" },
    ],
  });
  expect((await post()).statusCode).toBe(403);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
});
it("rejects an inactive connection", async () => {
  await pool.query(
    "UPDATE connections SET status='disconnected' WHERE tenant_id='default' AND id=$1",
    [connectionId],
  );
  expect((await post()).statusCode).toBe(409);
  expect(requests).toHaveLength(0);
});
it("allows an action on the new attempt without reusing the old receipt", async () => {
  expect((await post()).statusCode).toBe(202);
  attempt = 2;
  expect(
    (
      await post({
        action: "github.rerun_failed",
        expectedAttempt: 2,
        requestId: randomUUID(),
        confirmed: true,
      })
    ).statusCode,
  ).toBe(202);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(2);
});
it("accepts exact GitHub action grants through admin policy API and rejects broad or cross-tool grants", async () => {
  const target = `/api/admin/users/${user.user.id}/permissions/`;
  const policy = {
    mode: "source + custom",
    custom: [{ resource: "repository:acme/app", action: "github.cancel" }],
  };
  expect(
    (
      await afe.app.inject({
        method: "PUT",
        url: target + "github",
        headers: { authorization: `Bearer ${admin}` },
        payload: policy,
      })
    ).statusCode,
  ).toBe(200);
  for (const [tool, resource] of [
    ["vercel", "repository:acme/app"],
    ["github", "connection:c"],
    ["github", "repository:Acme/App"],
  ])
    expect(
      (
        await afe.app.inject({
          method: "PUT",
          url: target + tool,
          headers: { authorization: `Bearer ${admin}` },
          payload: { ...policy, custom: [{ resource, action: "github.cancel" }] },
        })
      ).statusCode,
    ).toBe(400);
});
it("denies revoked credentials and revoked action grants even when replaying a stored receipt", async () => {
  const payload = {
    action: "github.rerun",
    expectedAttempt: 1,
    requestId: randomUUID(),
    confirmed: true,
  };
  expect((await post(payload)).statusCode).toBe(202);
  await policy("source");
  expect((await post(payload)).statusCode).toBe(403);
  await policy();
  await pool.query("DELETE FROM user_tool_accounts WHERE tenant_id='default' AND user_id=$1", [
    user.user.id,
  ]);
  expect((await post(payload)).statusCode).toBe(403);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
});
it("purges receipts within the tenant retention window", async () => {
  expect((await post()).statusCode).toBe(202);
  await pool.query(
    "UPDATE github_action_requests SET created_at=now()-interval '31 days' WHERE tenant_id='default'",
  );
  await afe.jobDefinitions.find((j) => j.name === "github-actions.purge")!.handler({});
  expect(
    (await pool.query("SELECT count(*) FROM github_action_requests WHERE tenant_id='default'"))
      .rows[0].count,
  ).toBe("0");
});
