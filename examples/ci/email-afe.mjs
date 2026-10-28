/** Built server + pg-boss + PostgreSQL + local SMTP acceptance. No external email. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
const { fetch } = globalThis;
const root = fileURLToPath(new URL("../../", import.meta.url));
const database = process.env.AFE_SMOKE_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!database) throw new Error("Set a disposable local *_test or *_e2e database URL.");
const db = new URL(database);
if (!["127.0.0.1", "localhost", "[::1]"].includes(db.hostname) || !/_(test|e2e)$/.test(db.pathname))
  throw new Error("Requires a disposable local *_test or *_e2e database.");
const messages = [],
  sockets = new Set();
const smtp = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.write("220 local SMTP\r\n");
  let buffer = "",
    data = false,
    message = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (data) {
        if (line === ".") {
          messages.push(message);
          message = "";
          data = false;
          socket.write("250 accepted\r\n");
        } else message += line + "\r\n";
      } else if (/^EHLO|^HELO/.test(line)) socket.write("250-localhost\r\n250 8BITMIME\r\n");
      else if (line === "DATA") {
        data = true;
        socket.write("354 send\r\n");
      } else if (line === "QUIT") socket.end("221 bye\r\n");
      else socket.write("250 ok\r\n");
    }
  });
});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
const port = Number(process.env.AFE_EMAIL_SMOKE_PORT ?? 8089),
  base = `http://127.0.0.1:${port}`,
  admin = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  DATABASE_URL: database,
  AFE_HOST: "127.0.0.1",
  AFE_PORT: String(port),
  AFE_ADMIN_TOKEN: admin,
  AFE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  AFE_LOG_LEVEL: "silent",
  AFE_WEB_DIR: path.join(root, "apps/web/dist"),
  AFE_PUBLIC_URL: base,
  AFE_SMTP_HOST: "127.0.0.1",
  AFE_SMTP_PORT: String(smtp.address().port),
  AFE_SMTP_FROM: "afe@example.com",
  AFE_SMTP_ALLOW_PLAINTEXT: "true",
  AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "true",
  AFE_ALLOW_INSECURE_HTTP_TARGETS: "true",
};
for (const k of [
  "DATABASE_URL_FILE",
  "AFE_ADMIN_TOKEN_FILE",
  "AFE_VIEWER_TOKEN",
  "AFE_VIEWER_TOKEN_FILE",
  "AFE_ENCRYPTION_KEY_FILE",
  "AFE_SMTP_PASSWORD_FILE",
  "AFE_SMTP_PASSWORD",
  "AFE_SMTP_USERNAME",
  "AFE_SMTP_SECURE",
])
  delete env[k];
const server = spawn(process.execPath, ["apps/server/dist/cli.js", "all"], {
  cwd: root,
  env,
  stdio: "ignore",
});
const exited = once(server, "exit");
let spawnError;
server.on("error", (err) => (spawnError = err));
async function call(method, url, body, token) {
  return fetch(base + url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function until(test, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError || server.exitCode !== null) throw new Error("Built server exited");
    try {
      const result = await test();
      if (result) return result;
    } catch {
      /* startup */
    }
    await setTimeout(200);
  }
  throw new Error("Timed out waiting for local SMTP acceptance");
}
const check = (label) => process.stdout.write(`PASS: ${label}\n`);
try {
  await until(async () => (await call("GET", "/healthz")).ok);
  for (const route of ["/account/accept", "/account/reset"])
    assert((await call("GET", route)).headers.get("content-type").includes("text/html"));
  check("production bundle migrates and serves account email pages");
  const suffix = randomBytes(6).toString("hex");
  const invited = await call(
    "POST",
    "/api/admin/users/invite",
    { username: `invited-${suffix}`, email: `invited-${suffix}@example.com` },
    admin,
  );
  assert.equal(invited.status, 201);
  assert.equal((await invited.json()).token, undefined);
  await until(() => messages.find((m) => m.includes(`invited-${suffix}@example.com`)));
  check("pg-boss worker delivers invitation to a local SMTP sink");
  const raw = messages
    .find((m) => m.includes(`invited-${suffix}@example.com`))
    .replace(/=\r\n/g, "");
  const token = raw.match(/#(afe_email\.[A-Za-z0-9._-]+)/)[1];
  const redeemed = await call("POST", "/api/account/redeem", { token });
  assert.equal(redeemed.status, 200);
  const credential = (await redeemed.json()).token;
  assert.equal((await call("POST", "/api/account/redeem", { token })).status, 400);
  const login = await call("POST", "/api/session", { token: credential });
  assert.equal(login.status, 201);
  check("email link issues a working credential once");
  const profile = await call("GET", "/api/profile", undefined, credential);
  assert.deepEqual((await profile.json()).tools, []);
  check("email activation grants no tool permissions");
  const test = await call(
    "POST",
    "/api/admin/email/test",
    { email: `test-${suffix}@example.com` },
    admin,
  );
  assert.equal(test.status, 202);
  await until(() => messages.find((m) => m.includes(`test-${suffix}@example.com`)));
  const state = await call("GET", "/api/admin/email", undefined, admin);
  assert((await state.json()).deliveries.some((d) => d.state === "sent"));
  check("test delivery and administrator status work through the production bundle");
} finally {
  server.kill("SIGTERM");
  const kill = setTimeout(5000).then(() => {
    if (server.exitCode === null) server.kill("SIGKILL");
  });
  await exited;
  void kill;
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => smtp.close(r));
}
