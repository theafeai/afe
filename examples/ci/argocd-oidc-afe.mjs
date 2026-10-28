/** Built server + real PostgreSQL/pg-boss + local OIDC/ArgoCD fakes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
const { fetch } = globalThis;
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { generateKeyPair, exportJWK, SignJWT } = await import(require.resolve("jose"));
const root = fileURLToPath(new URL("../../", import.meta.url));
const database = process.env.AFE_SMOKE_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!database) throw new Error("Set a disposable local *_test or *_e2e database URL");
const db = new URL(database);
if (!["127.0.0.1", "localhost", "[::1]"].includes(db.hostname) || !/_(test|e2e)$/.test(db.pathname))
  throw new Error("Requires a disposable local test database");
const signing = await generateKeyPair("RS256");
let issuer, nonce, challenge, identityToken;
let exchanges = 0;
const provider = createServer(async (req, res) => {
  const json = (data, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (req.url === "/issuer/.well-known/openid-configuration")
    return json({
      issuer,
      authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token",
      jwks_uri: issuer + "/keys",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  if (req.url === "/issuer/keys")
    return json({
      keys: [{ ...(await exportJWK(signing.publicKey)), kid: "local", alg: "RS256", use: "sig" }],
    });
  if (req.url === "/issuer/token") {
    exchanges++;
    let raw = "";
    for await (const chunk of req) raw += chunk.toString();
    const body = new URLSearchParams(raw);
    if (
      body.get("code") !== "local-code" ||
      createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url") !== challenge
    )
      return json({ error: "invalid_grant" }, 400);
    identityToken = await new SignJWT({ nonce })
      .setSubject("alice")
      .setIssuer(issuer)
      .setAudience("afe-client")
      .setIssuedAt()
      .setExpirationTime("5 minutes")
      .setProtectedHeader({ alg: "RS256", kid: "local" })
      .sign(signing.privateKey);
    return json({ id_token: identityToken });
  }
  if (req.url === "/api/version") return json({ Version: "v2.13.0" });
  if (req.url?.startsWith("/api/v1/session/userinfo"))
    return json({
      loggedIn: true,
      username:
        req.headers.authorization === `Bearer ${identityToken}` ? "alice" : "readonly-service",
      iss: issuer,
    });
  if (req.url?.startsWith("/api/v1/account/can-i/")) return json({ value: "no" });
  if (req.url?.startsWith("/api/v1/applications")) return json({ items: [] });
  return json({}, 404);
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
issuer = `http://127.0.0.1:${provider.address().port}/issuer`;
const port = Number(process.env.AFE_OIDC_SMOKE_PORT ?? 8090),
  base = `http://127.0.0.1:${port}`,
  admin = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  DATABASE_URL: database,
  AFE_HOST: "127.0.0.1",
  AFE_PORT: String(port),
  AFE_ADMIN_TOKEN: admin,
  AFE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  AFE_PUBLIC_URL: "https://afe.example",
  AFE_LOG_LEVEL: "silent",
  AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "true",
  AFE_ALLOW_INSECURE_HTTP_TARGETS: "true",
};
for (const k of Object.keys(env))
  if (
    k.startsWith("AFE_SMTP_") ||
    [
      "DATABASE_URL_FILE",
      "AFE_ADMIN_TOKEN_FILE",
      "AFE_VIEWER_TOKEN",
      "AFE_VIEWER_TOKEN_FILE",
      "AFE_ENCRYPTION_KEY_FILE",
    ].includes(k)
  )
    delete env[k];
const server = spawn(process.execPath, ["apps/server/dist/cli.js", "all"], {
  cwd: root,
  env,
  stdio: "ignore",
});
const exited = once(server, "exit");
let spawnError;
server.on("error", (err) => (spawnError = err));
async function call(method, url, body, auth = { authorization: `Bearer ${admin}` }) {
  return fetch(base + url, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  });
}
async function json(method, url, body, auth) {
  const r = await call(method, url, body, auth);
  assert(r.ok, `${method} ${url}: ${r.status}`);
  return r.json();
}
const check = (label) => process.stdout.write(`PASS: ${label}\n`);
try {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (spawnError || server.exitCode !== null) throw new Error("Built server exited");
    try {
      if ((await call("GET", "/healthz")).ok) break;
    } catch {
      /* startup */
    }
    if (Date.now() > deadline) throw new Error("Startup timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
  const connected = await json("POST", "/api/connections/argocd", {
    url: issuer.replace("/issuer", ""),
    token: "local-readonly-service-token",
    name: "Local SSO ArgoCD",
  });
  const id = connected.connection.id;
  await json("PUT", `/api/connections/argocd/${id}/oidc`, {
    issuer,
    clientId: "afe-client",
    authMethod: "none",
    scopes: ["openid", "profile", "email", "groups"],
  });
  check("production bundle validates per-connection OIDC discovery");
  const created = await json("POST", "/api/admin/users", {
    username: `oidc-${randomBytes(5).toString("hex")}`,
  });
  await json("PUT", `/api/admin/users/${created.user.id}/permissions/argocd`, {
    mode: "source",
    custom: [],
  });
  const login = await call("POST", "/api/session", { token: created.token }, {});
  assert.equal(login.status, 201);
  const session = await login.json(),
    auth = {
      cookie: login.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
      "x-afe-csrf": session.csrfToken,
    };
  const profile = await json("GET", "/api/profile", undefined, auth);
  assert(profile.tools.find((t) => t.tool === "argocd").oidcConnections.some((c) => c.id === id));
  const start = await json("POST", "/api/profile/tools/argocd/login", { connectionId: id }, auth);
  const url = new URL(start.url);
  nonce = url.searchParams.get("nonce");
  challenge = url.searchParams.get("code_challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  check("managed profile starts session-bound sign-in with S256 PKCE");
  const callback = `/api/profile/tools/argocd/callback?state=${url.searchParams.get("state")}&code=local-code`;
  assert.equal((await call("GET", callback, undefined, auth)).status, 303);
  assert.equal((await call("GET", callback, undefined, auth)).status, 400);
  assert.equal(exchanges, 1);
  const linked = (await json("GET", "/api/profile", undefined, auth)).tools.find(
    (t) => t.tool === "argocd",
  );
  assert.equal(linked.accountName, "alice");
  assert.equal(linked.linked, true);
  assert.deepEqual((await json("GET", "/api/events", undefined, auth)).items, []);
  check("ArgoCD accepts the signed ID token and callback replay is rejected");
  await json("DELETE", "/api/profile/tools/argocd", undefined, auth);
  assert.equal(
    (await json("GET", "/api/profile", undefined, auth)).tools.find((t) => t.tool === "argocd")
      .linked,
    false,
  );
  check("unlink removes the account while preserving dashboard login");
} finally {
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
}
