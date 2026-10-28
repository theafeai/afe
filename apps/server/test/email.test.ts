import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import type pg from "pg";
import { EnvKeyProvider } from "@afe/core/security";
import {
  authenticateLocalUser,
  createLocalUser,
  getCredential,
  getLocalUser,
  purgeEmailMetadata,
  redeemUserEmailLink,
  resetLocalCredential,
  setLocalUserDisabled,
} from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, loadConfig, type AfeApp } from "../src/index.ts";
import { emailJobs } from "../src/email.ts";

let pool: pg.Pool, afe: AfeApp, smtp: Server;
let sockets: Set<Socket>, messages: string[], rejectMail: boolean, logs: string;
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } }),
  admin = "a".repeat(40),
  headers = { authorization: `Bearer ${admin}` };
let port: number;
beforeEach(async () => {
  pool = await createTestPool();
  messages = [];
  rejectMail = false;
  logs = "";
  sockets = new Set();
  smtp = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 local test SMTP\r\n");
    let buffer = "",
      data = false,
      message = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx: number;
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
          continue;
        }
        if (/^EHLO|^HELO/.test(line)) socket.write("250-localhost\r\n250 8BITMIME\r\n");
        else if (/^MAIL|^RCPT/.test(line))
          socket.write(rejectMail ? "550 private upstream detail and password\r\n" : "250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else if (line === "STARTTLS") socket.write("502 TLS unavailable\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  port = (smtp.address() as { port: number }).port;
  afe = await build();
});
function config(extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    DATABASE_URL: "unused",
    AFE_ADMIN_TOKEN: admin,
    AFE_PUBLIC_URL: "http://localhost:8080",
    AFE_SMTP_HOST: "127.0.0.1",
    AFE_SMTP_PORT: String(port),
    AFE_SMTP_FROM: "afe@example.com",
    AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "true",
    AFE_ALLOW_INSECURE_HTTP_TARGETS: "true",
    AFE_SMTP_ALLOW_PLAINTEXT: "true",
    ...extra,
  });
}
function build(extra: NodeJS.ProcessEnv = {}) {
  return buildAfe({
    pool,
    keys,
    config: config(extra),
    logLevel: "info",
    logStream: new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    }),
  });
}
afterEach(async () => {
  await afe.app.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((r) => smtp.close(() => r()));
  await pool.end();
});
const post = (url: string, payload: Record<string, unknown>, authenticated = true) =>
  afe.app.inject({ method: "POST", url, payload, headers: authenticated ? headers : {} });
async function invite(username = "alice", email = "alice@example.com") {
  const r = await post("/api/admin/users/invite", { username, email });
  expect(r.statusCode).toBe(201);
  return r.json().user as { id: string };
}
async function pendingToken(tenantId = "default") {
  const { rows } = await pool.query(
    `SELECT credential_id FROM email_outbox WHERE tenant_id=$1 AND state='pending' ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  const payload = await getCredential(pool, keys, tenantId, rows[0].credential_id);
  const text = JSON.parse(payload!.secret.reveal()).text as string;
  return text.match(/#(afe_email\.[A-Za-z0-9._-]+)/)![1]!;
}
async function deliver() {
  await emailJobs(afe.context)[0]!.handler({});
}
it("delivers invitations over SMTP, keeps payloads encrypted, and redeems exactly once", async () => {
  const user = await invite(),
    token = await pendingToken();
  const queued = await pool.query("SELECT * FROM email_outbox");
  expect(JSON.stringify(queued.rows)).not.toContain(token);
  expect(
    (await pool.query("SELECT token_digest FROM user_email_links")).rows[0].token_digest,
  ).toMatch(/^[a-f0-9]{64}$/);
  await deliver();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("To: alice@example.com");
  const out = (await pool.query("SELECT state,credential_id FROM email_outbox")).rows[0];
  expect(out.state).toBe("sent");
  expect(await getCredential(pool, keys, "default", out.credential_id)).toBeNull();
  const responses = await Promise.all([
    post("/api/account/redeem", { token }, false),
    post("/api/account/redeem", { token }, false),
  ]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  const issued = responses.find((r) => r.statusCode === 200)!.json().token;
  expect((await authenticateLocalUser(pool, "default", issued))?.id).toBe(user.id);
  expect(logs).not.toContain(token);
  expect(logs).not.toContain(issued);
  expect(logs).not.toContain("alice@example.com");
});
it("resending, expiry, manual reset, disabling and email changes invalidate links", async () => {
  const u = await invite();
  let token = await pendingToken();
  expect((await post(`/api/admin/users/${u.id}/email`, { purpose: "invitation" })).statusCode).toBe(
    202,
  );
  expect(await redeemUserEmailLink(pool, token)).toBeNull();
  token = await pendingToken();
  await pool.query("UPDATE user_email_links SET expires_at=now()-interval '1 second'");
  expect(await redeemUserEmailLink(pool, token)).toBeNull();
  await post(`/api/admin/users/${u.id}/email`, { purpose: "reset" });
  token = await pendingToken();
  await resetLocalCredential(pool, "default", u.id);
  expect(await redeemUserEmailLink(pool, token)).toBeNull();
  await post(`/api/admin/users/${u.id}/email`, { purpose: "reset" });
  token = await pendingToken();
  await setLocalUserDisabled(pool, "default", u.id, true);
  await setLocalUserDisabled(pool, "default", u.id, false);
  expect(await redeemUserEmailLink(pool, token)).toBeNull();
  await post(`/api/admin/users/${u.id}/email`, { purpose: "reset" });
  token = await pendingToken();
  await afe.app.inject({
    method: "PATCH",
    url: `/api/admin/users/${u.id}`,
    headers,
    payload: { email: "new@example.com" },
  });
  expect(await redeemUserEmailLink(pool, token)).toBeNull();
  await deliver();
  expect(messages).toHaveLength(0);
});
it("reset requests do not enumerate accounts, are throttled, and preserve the credential until redemption", async () => {
  const u = await createLocalUser(pool, "default", "alice");
  await pool.query(
    "UPDATE users SET email='alice@example.com' WHERE tenant_id='default' AND id=$1",
    [u.user.id],
  );
  const login = await post("/api/session", { token: u.token }, false);
  const cookie = (login.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]).join("; ");
  const known = await post("/api/account/reset", { email: "ALICE@example.com" }, false),
    unknown = await post("/api/account/reset", { email: "unknown@example.com" }, false);
  expect(known.statusCode).toBe(202);
  expect(known.body).toBe(unknown.body);
  await post("/api/account/reset", { email: "alice@example.com" }, false);
  expect((await pool.query("SELECT count(*)::int AS n FROM email_outbox")).rows[0].n).toBe(1);
  expect(await authenticateLocalUser(pool, "default", u.token)).not.toBeNull();
  const token = await pendingToken();
  await post("/api/account/redeem", { token }, false);
  expect(await authenticateLocalUser(pool, "default", u.token)).toBeNull();
  expect((await afe.app.inject({ url: "/api/session", headers: { cookie } })).statusCode).toBe(401);
  for (let n = 0; n < 10; n++)
    await post("/api/account/reset", { email: "unknown@example.com" }, false);
  expect((await post("/api/account/reset", { email: "alice@example.com" }, false)).statusCode).toBe(
    429,
  );
});
it("retries safely, hides provider errors, stops after five attempts, and erases failed mail", async () => {
  await invite();
  const token = await pendingToken();
  rejectMail = true;
  for (let n = 0; n < 5; n++) {
    await deliver();
    await pool.query("UPDATE email_outbox SET next_attempt_at=now()");
  }
  const row = (await pool.query("SELECT state,attempts,credential_id FROM email_outbox")).rows[0];
  expect(row).toMatchObject({ state: "failed", attempts: 5 });
  expect(await getCredential(pool, keys, "default", row.credential_id)).toBeNull();
  expect(logs).not.toContain("private upstream detail");
  expect(logs).not.toContain(token);
  expect((await afe.app.inject({ url: "/api/admin/email", headers })).body).not.toContain(
    "alice@example.com",
  );
});
it("requires TLS by default and refuses private networks without operator opt-in", async () => {
  await afe.app.close();
  afe = await build({ AFE_SMTP_ALLOW_PLAINTEXT: "false" });
  await invite();
  await deliver();
  expect(messages).toHaveLength(0);
  await afe.app.close();
  afe = await build({
    AFE_SMTP_ALLOW_PLAINTEXT: "false",
    AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "false",
    AFE_PUBLIC_URL: "https://afe.example",
  });
  await pool.query("UPDATE email_outbox SET next_attempt_at=now()");
  await deliver();
  expect(messages).toHaveLength(0);
});
it("scopes links, emails and public recovery to their tenant and denies cross-origin requests", async () => {
  const u = await invite();
  const token = await pendingToken();
  await pool.query("INSERT INTO tenants(id,name) VALUES('other','Other')");
  expect(await getLocalUser(pool, "other", u.id)).toBeNull();
  expect(await redeemUserEmailLink(pool, token.replace("ZGVmYXVsdA", "b3RoZXI"))).toBeNull();
  expect(
    await redeemUserEmailLink(pool, token.replace(/.$/, token.endsWith("a") ? "b" : "a")),
  ).toBeNull();
  const foreign = await afe.app.inject({
    method: "POST",
    url: "/api/account/redeem",
    headers: { origin: "https://evil.example" },
    payload: { token },
  });
  expect(foreign.statusCode).toBe(403);
  const missing = await post(`/api/admin/users/${randomUUID()}/email`, { purpose: "reset" });
  expect(missing.statusCode).toBe(404);
});
it("supports no-SMTP manual provisioning and rejects malformed configuration without echoing secrets", async () => {
  await afe.app.close();
  afe = await buildAfe({
    pool,
    config: loadConfig({ DATABASE_URL: "unused", AFE_ADMIN_TOKEN: admin }),
    logLevel: "silent",
  });
  expect((await post("/api/admin/users", { username: "manual" })).statusCode).toBe(201);
  expect(
    (await post("/api/admin/users/invite", { username: "invited", email: "x@example.com" }))
      .statusCode,
  ).toBe(503);
  expect((await afe.app.inject({ url: "/api/account/email" })).json()).toEqual({ enabled: false });
  expect(() => config({ AFE_SMTP_FROM: "bad\r\nBcc:evil@example.com" })).toThrow("AFE_SMTP_FROM");
  expect(() => config({ AFE_SMTP_PASSWORD: "secret-value" })).toThrow("must be set together");
  expect(() => config({ AFE_SMTP_PORT: "0" })).toThrow("1..65535");
  expect(() => config({ AFE_PUBLIC_URL: "https://afe.example/path" })).toThrow("origin");
});

it("discards expired mail, destroys its payload, and purges old metadata only within its tenant", async () => {
  await invite();
  const row = (await pool.query("SELECT credential_id FROM email_outbox")).rows[0];
  await pool.query("UPDATE email_outbox SET expires_at=now()-interval '8 days'");
  await pool.query("UPDATE user_email_links SET expires_at=now()-interval '8 days'");
  await purgeEmailMetadata(pool, "other");
  expect((await pool.query("SELECT count(*)::int AS n FROM email_outbox")).rows[0].n).toBe(1);
  await deliver();
  expect(messages).toHaveLength(0);
  expect(await getCredential(pool, keys, "default", row.credential_id)).toBeNull();
  expect((await pool.query("SELECT count(*)::int AS n FROM email_outbox")).rows[0].n).toBe(0);
  expect((await pool.query("SELECT count(*)::int AS n FROM user_email_links")).rows[0].n).toBe(0);
});
