/** Built Afe + real PostgreSQL acceptance. Uses only disposable local test databases. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
const { fetch } = globalThis;
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const database = process.env.AFE_SMOKE_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!database)
  throw new Error("Set AFE_SMOKE_DATABASE_URL to a disposable local *_test or *_e2e database.");
const databaseUrl = new URL(database);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname) ||
  !/_(test|e2e)$/.test(databaseUrl.pathname)
) {
  throw new Error("Acceptance requires a disposable local *_test or *_e2e database.");
}
const port = Number(process.env.AFE_USER_SMOKE_PORT ?? 8088);
const base = `http://127.0.0.1:${port}`;
const admin = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  DATABASE_URL: database,
  AFE_HOST: "127.0.0.1",
  AFE_PORT: String(port),
  AFE_ADMIN_TOKEN: admin,
  AFE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  AFE_LOG_LEVEL: "silent",
  AFE_WEB_DIR: path.join(root, "apps/web/dist"),
};
for (const key of [
  "DATABASE_URL_FILE",
  "AFE_ADMIN_TOKEN_FILE",
  "AFE_ENCRYPTION_KEY_FILE",
  "AFE_PUBLIC_URL",
  "AFE_VIEWER_TOKEN",
  "AFE_VIEWER_TOKEN_FILE",
])
  delete env[key];
const server = spawn(process.execPath, ["apps/server/dist/cli.js", "all"], {
  cwd: root,
  env,
  stdio: ["ignore", "ignore", "ignore"],
});
const exited = once(server, "exit");
let spawnError;
server.on("error", (error) => {
  spawnError = error;
});
const checks = [];
const check = (label) => {
  checks.push(label);
  process.stdout.write(`PASS: ${label}\n`);
};
async function call(method, url, token, body, extra = {}) {
  const response = await fetch(base + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "content-type": "application/json",
          },
        }),
    ...extra,
  });
  return response;
}
async function json(method, url, token, body) {
  const response = await call(method, url, token, body);
  assert(response.ok, `${method} ${url}: HTTP ${response.status}`);
  return response.json();
}
async function until(test) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError || server.exitCode !== null)
      throw new Error("Built server exited before acceptance completed.");
    try {
      const result = await test();
      if (result) return result;
    } catch {
      /* The server may still be migrating or processing the report. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for built server acceptance condition.");
}
try {
  await until(async () => (await call("GET", "/healthz")).ok);
  check("production bundle starts and migrates PostgreSQL");
  for (const route of ["/users", "/profile"])
    assert((await call("GET", route)).headers.get("content-type")?.includes("text/html"));
  check("built Users and Profile client routes are served");
  const suffix = randomBytes(6).toString("hex");
  const alice = await json("POST", "/api/admin/users", admin, { username: `alice-${suffix}` });
  const bob = await json("POST", "/api/admin/users", admin, { username: `bob-${suffix}` });
  assert.equal((await json("GET", "/api/profile", bob.token)).tools.length, 0);
  assert.deepEqual((await json("GET", "/api/events", bob.token)).items, []);
  const session = await call("POST", "/api/session", undefined, { token: alice.token });
  assert.equal(session.status, 201);
  const cookie = session.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  check("admins provision users without email and users can sign in");
  const connection = await json("POST", "/api/connections/terraform", admin, {
    workspace: `permissions-${suffix}`,
  });
  const grant = {
    mode: "custom",
    custom: [{ resource: `connection:${connection.connection.id}`, action: "read" }],
  };
  await json("PUT", `/api/admin/users/${alice.user.id}/permissions/terraform`, admin, grant);
  const report = {
    version: 1,
    runId: randomUUID(),
    operation: "plan",
    phase: "completed",
    exitCode: 0,
    sentAt: new Date().toISOString(),
    occurredAt: new Date().toISOString(),
    trigger: "manual",
  };
  const body = JSON.stringify(report);
  const signature = `sha256=${createHmac("sha256", connection.secret).update(body).digest("hex")}`;
  const accepted = await call("POST", connection.reportPath, undefined, undefined, {
    headers: { "content-type": "application/json", "x-afe-signature": signature },
    body,
  });
  assert.equal(accepted.status, 202);
  const visible = await until(async () =>
    (await json("GET", "/api/events", alice.token)).items.find(
      (i) => i.event.connectionId === connection.connection.id,
    ),
  );
  check("signed source report travels through the real queue into the permitted user's timeline");
  assert.equal((await json("GET", "/api/events", bob.token)).items.length, 0);
  assert.equal((await call("GET", `/api/events/${visible.event.id}`, bob.token)).status, 404);
  assert.equal((await call("GET", `/api/events/${visible.event.id}`, alice.token)).status, 200);
  assert.equal((await call("GET", `/api/events/${visible.event.id}/raw`, alice.token)).status, 403);
  assert.equal((await call("GET", "/api/admin/users", alice.token)).status, 403);
  check(
    "ungranted users cannot list or guess source records; evidence and admin routes stay protected",
  );
  await json("PUT", `/api/admin/users/${alice.user.id}/permissions/terraform`, admin, {
    mode: "none",
    custom: grant.custom,
  });
  assert.deepEqual((await json("GET", "/api/events", alice.token)).items, []);
  await json("PUT", `/api/admin/users/${alice.user.id}/permissions/terraform`, admin, {
    ...grant,
    mode: "source + custom",
  });
  assert(
    (await json("GET", "/api/events", alice.token)).items.some(
      (i) => i.event.id === visible.event.id,
    ),
  );
  check("none revokes access immediately; combined mode retains independent custom grants");
  const reset = await json("POST", `/api/admin/users/${alice.user.id}/credentials`, admin);
  assert.equal((await call("GET", "/api/session", alice.token)).status, 401);
  assert.equal(
    (await call("GET", "/api/session", undefined, undefined, { headers: { cookie } })).status,
    401,
  );
  assert.equal((await call("GET", "/api/session", reset.token)).status, 200);
  await json("PATCH", `/api/admin/users/${alice.user.id}`, admin, { disabled: true });
  assert.equal((await call("GET", "/api/session", reset.token)).status, 401);
  check("credential reset revokes bearer and cookie access; disabling revokes the new credential");
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      checks: checks.length,
      providers: "signed local Terraform reports; no real OAuth consent",
    }) + "\n",
  );
} finally {
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}
