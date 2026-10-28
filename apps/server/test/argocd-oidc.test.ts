import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Writable } from "node:stream";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { beforeEach, afterEach, expect, it } from "vitest";
import type pg from "pg";
import { EnvKeyProvider } from "@afe/core/security";
import {
  authenticateLocalUser,
  createLocalUser,
  getConnectionCredentialIds,
  getCredential,
  getCredentialMetadata,
  getUserToolPolicy,
  setUserToolPolicy,
  upsertConnection,
} from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, loadConfig, type AfeApp } from "../src/index.ts";
import { argocdOidcJobs } from "../src/auth/argocd-oidc.ts";
let pool: pg.Pool,
  afe: AfeApp,
  provider: Server,
  issuer: string,
  connectionId: string,
  otherConnectionId: string,
  cookie: string,
  csrf: string,
  userId: string,
  userToken: string,
  logs: string;
let nonce: string,
  challenge: string,
  codeCalls: number,
  acceptedToken: string,
  revoked: boolean,
  bad: string,
  authMethod: string,
  capturedBody: URLSearchParams,
  authorization: string;
const admin = "a".repeat(40),
  headers = { authorization: `Bearer ${admin}` },
  keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });
let pauseToken: (() => Promise<void>) | undefined;
let signing: Awaited<ReturnType<typeof generateKeyPair>>,
  wrongSigning: Awaited<ReturnType<typeof generateKeyPair>>;
beforeEach(async () => {
  pool = await createTestPool();
  signing = await generateKeyPair("RS256");
  wrongSigning = await generateKeyPair("RS256");
  logs = "";
  codeCalls = 0;
  revoked = false;
  bad = "";
  authMethod = "none";
  nonce = "";
  challenge = "";
  pauseToken = undefined;
  provider = createServer(async (req, res) => {
    const respond = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/issuer/.well-known/openid-configuration")
      return respond({
        issuer: bad === "issuer_discovery" ? "https://wrong.example" : issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: bad === "unsafe_jwks" ? "http://169.254.169.254/keys" : `${issuer}/keys`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_basic",
          "client_secret_post",
        ],
      });
    if (req.url === "/issuer/keys")
      return respond({
        keys: [{ ...(await exportJWK(signing.publicKey)), kid: "key1", use: "sig", alg: "RS256" }],
      });
    if (req.url === "/issuer/token") {
      codeCalls++;
      if (pauseToken) await pauseToken();
      let body = "";
      for await (const c of req) body += c.toString();
      capturedBody = new URLSearchParams(body);
      authorization = String(req.headers.authorization ?? "");
      if (
        capturedBody.get("code") !== "valid-code" ||
        createHash("sha256")
          .update(capturedBody.get("code_verifier") ?? "")
          .digest("base64url") !== challenge
      )
        return respond({ error: "bad PKCE and provider secret" }, 400);
      if (bad === "provider_error")
        return respond({ error_description: "provider-secret-not-for-logs" }, 400);
      let token = await new SignJWT({
        nonce: bad === "nonce" ? "wrong" : nonce,
        ...(bad === "azp" ? { azp: "wrong" } : {}),
        ...(bad === "multi_audience" ? { aud: ["afe-client", "other"] } : {}),
      })
        .setProtectedHeader({ alg: "RS256", kid: "key1" })
        .setSubject("human-subject")
        .setIssuer(bad === "issuer" ? "https://wrong.example" : issuer)
        .setAudience(
          bad === "audience"
            ? "wrong-client"
            : bad === "multi_audience"
              ? ["afe-client", "other"]
              : "afe-client",
        )
        .setIssuedAt()
        .setExpirationTime(bad === "expired" ? Math.floor(Date.now() / 1000) - 60 : "5 minutes")
        .sign(bad === "signature" ? wrongSigning.privateKey : signing.privateKey);
      if (bad === "malformed") token = "not-a-jwt";
      acceptedToken = token;
      return respond({ id_token: token, access_token: "never-use-this-access-token" });
    }
    if (req.url?.startsWith("/api/v1/")) {
      if (
        req.headers.authorization !== `Bearer ${acceptedToken}` ||
        revoked ||
        bad === "argo_reject"
      )
        return respond({ error: "private response" }, 401);
      if (req.url.startsWith("/api/v1/session/userinfo"))
        return respond({ loggedIn: true, username: "alice@org.example", iss: issuer });
      if (req.url.startsWith("/api/v1/applications"))
        return respond({ items: [{ metadata: { name: "allowed-app", namespace: "argocd" } }] });
    }
    return respond({}, 404);
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}/issuer`;
  const c = await upsertConnection(pool, "default", {
    source: "argocd",
    name: "Production",
    externalId: issuer + "/argo",
    status: "active",
    config: { serverUrl: issuer.replace("/issuer", "") },
  });
  connectionId = c.id;
  otherConnectionId = (
    await upsertConnection(pool, "default", {
      source: "argocd",
      name: "Other",
      externalId: issuer + "/other",
      status: "active",
      config: { serverUrl: issuer.replace("/issuer", "") },
    })
  ).id;
  const u = await createLocalUser(pool, "default", "alice");
  userId = u.user.id;
  userToken = u.token;
  await setUserToolPolicy(pool, "default", userId, "argocd", { mode: "source", custom: [] });
  afe = await buildAfe({
    pool,
    keys,
    config: loadConfig({
      DATABASE_URL: "unused",
      AFE_ADMIN_TOKEN: admin,
      AFE_PUBLIC_URL: "https://afe.example",
      AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "true",
      AFE_ALLOW_INSECURE_HTTP_TARGETS: "true",
    }),
    logStream: new Writable({
      write(c, _enc, done) {
        logs += c.toString();
        done();
      },
    }),
  });
  const login = await afe.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: userToken },
  });
  cookie = (login.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]).join("; ");
  csrf = login.json().csrfToken;
  expect((await configure()).statusCode).toBe(200);
});
afterEach(async () => {
  await afe.app.close();
  provider.closeAllConnections();
  await new Promise<void>((r) => provider.close(() => r()));
  await pool.end();
});
const configure = (extra: Record<string, unknown> = {}) =>
  afe.app.inject({
    method: "PUT",
    url: `/api/connections/argocd/${connectionId}/oidc`,
    headers,
    payload: {
      issuer,
      clientId: "afe-client",
      scopes: ["openid", "profile", "email", "groups"],
      authMethod,
      ...extra,
    },
  });
async function start(id = connectionId) {
  const r = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/argocd/login",
    headers: { cookie, "x-afe-csrf": csrf },
    payload: { connectionId: id },
  });
  expect(r.statusCode).toBe(200);
  const url = new URL(r.json().url);
  nonce = url.searchParams.get("nonce")!;
  challenge = url.searchParams.get("code_challenge")!;
  return url;
}
const callback = (url: URL, extra = "", sentCookie = cookie) =>
  afe.app.inject({
    url: `/api/profile/tools/argocd/callback?state=${url.searchParams.get("state")}&code=valid-code${extra}`,
    headers: { cookie: sentCookie },
  });
it("uses encrypted single-use PKCE, validates identity in ArgoCD, and limits grants to the chosen connection", async () => {
  const url = await start();
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")).toBe("openid profile email groups");
  const stateRow = (await pool.query("SELECT * FROM user_argocd_oidc_states")).rows[0];
  expect(JSON.stringify(stateRow)).not.toContain(nonce);
  expect(JSON.stringify(stateRow)).not.toContain(url.searchParams.get("state"));
  const flow = await getCredential(pool, keys, "default", stateRow.credential_id);
  expect(flow).not.toBeNull();
  const verifier = JSON.parse(flow!.secret.reveal()).verifier;
  expect(verifier).not.toBe(challenge);
  expect(await getCredential(pool, keys, "other", stateRow.credential_id)).toBeNull();
  const done = await callback(url);
  expect(done.statusCode).toBe(303);
  expect(done.headers.location).toBe("/profile?linked=argocd");
  expect((await callback(url)).statusCode).toBe(400);
  expect(codeCalls).toBe(1);
  expect(await getCredential(pool, keys, "default", stateRow.credential_id)).toBeNull();
  const account = (
    await pool.query("SELECT * FROM user_tool_accounts WHERE tenant_id='default' AND user_id=$1", [
      userId,
    ])
  ).rows[0];
  expect(account.context).toMatchObject({ connectionId });
  const { sourceAccess } = await import("../src/auth/tool-accounts.ts");
  const access = await sourceAccess(afe.context, "default", account);
  expect(access).toEqual([
    {
      source: "argocd",
      resource: "application:allowed-app",
      connectionId,
      targetId: "argocd/allowed-app",
    },
  ]);
  expect(access.some((a) => a.connectionId === otherConnectionId)).toBe(false);
  revoked = true;
  await expect(sourceAccess(afe.context, "default", account)).rejects.toThrow();
  for (const secret of [verifier, nonce, acceptedToken, url.searchParams.get("state")!])
    expect(logs).not.toContain(secret);
  expect(await authenticateLocalUser(pool, "default", userToken)).not.toBeNull();
});
it("rejects signature, issuer, audience, authorized party, nonce, expiry and malformed tokens", async () => {
  for (const value of [
    "signature",
    "issuer",
    "audience",
    "azp",
    "multi_audience",
    "nonce",
    "expired",
    "malformed",
    "argo_reject",
  ]) {
    bad = value;
    const url = await start();
    expect((await callback(url)).statusCode, value).toBe(502);
    expect((await pool.query("SELECT * FROM user_tool_accounts")).rowCount).toBe(0);
    expect((await callback(url)).statusCode).toBe(400);
  }
});
it("binds callbacks to the user session, tool, tenant and connection configuration", async () => {
  const url = await start();
  const login = await afe.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: userToken },
  });
  const otherCookie = (login.headers["set-cookie"] as string[])
    .map((c) => c.split(";")[0])
    .join("; ");
  expect((await callback(url, "", otherCookie)).statusCode).toBe(400);
  expect(
    (
      await afe.app.inject({
        url: `/api/profile/tools/github/callback?state=${url.searchParams.get("state")}&code=valid-code`,
        headers: { cookie },
      })
    ).statusCode,
  ).toBeGreaterThanOrEqual(400);
  await configure();
  expect((await callback(url)).statusCode).toBe(400);
  expect(codeCalls).toBe(0);
  const next = await start();
  await afe.app.inject({
    method: "DELETE",
    url: "/api/profile/tools/argocd",
    headers: { cookie, "x-afe-csrf": csrf },
  });
  expect((await callback(next)).statusCode).toBe(400);
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: "/api/profile/tools/argocd/login",
        headers: { cookie, "x-afe-csrf": csrf },
        payload: { connectionId: randomUUID() },
      })
    ).statusCode,
  ).toBe(404);
});
it("consumes denied consent, rejects expired state and cleans encrypted flow credentials", async () => {
  const first = await start();
  expect((await callback(first, "&error=access_denied")).statusCode).toBe(400);
  expect((await callback(first)).statusCode).toBe(400);
  expect(codeCalls).toBe(0);
  const second = await start();
  const row = (await pool.query("SELECT credential_id FROM user_argocd_oidc_states")).rows[0];
  await pool.query("UPDATE user_argocd_oidc_states SET expires_at=now()-interval '1 minute'");
  expect((await callback(second)).statusCode).toBe(400);
  await argocdOidcJobs(afe.context)[0]!.handler({});
  expect((await pool.query("SELECT * FROM user_argocd_oidc_states")).rowCount).toBe(0);
  expect(await getCredential(pool, keys, "default", row.credential_id)).toBeNull();
});
it("stores confidential client secrets write-only and supports Basic and POST exchanges", async () => {
  for (const method of ["client_secret_basic", "client_secret_post"]) {
    authMethod = method;
    const configured = await configure({ clientSecret: "operator-client-secret" });
    expect(configured.statusCode).toBe(200);
    const read = await afe.app.inject({
      url: `/api/connections/argocd/${connectionId}/oidc`,
      headers,
    });
    expect(read.json().clientSecretConfigured).toBe(true);
    expect(read.body).not.toContain("operator-client-secret");
    const url = await start();
    expect((await callback(url)).statusCode).toBe(303);
    if (method === "client_secret_basic")
      expect(authorization).toBe(
        `Basic ${Buffer.from("afe-client:operator-client-secret").toString("base64")}`,
      );
    else expect(capturedBody.get("client_secret")).toBe("operator-client-secret");
  }
  expect((await configure({ clientId: "different-client" })).statusCode).toBe(400);
  const ids = await getConnectionCredentialIds(pool, "default", connectionId);
  expect(
    (await getCredentialMetadata(pool, "default", ids.user_oidc_client_secret!))?.revokedAt,
  ).toBeNull();
  expect(logs).not.toContain("operator-client-secret");
  expect(logs).not.toContain(Buffer.from("afe-client:operator-client-secret").toString("base64"));
});
it("denies none/custom policies, unconfigured connections, unsafe discovery and rejected provider calls", async () => {
  for (const mode of ["none", "custom"] as const) {
    await setUserToolPolicy(pool, "default", userId, "argocd", { mode, custom: [] });
    expect(
      (
        await afe.app.inject({
          method: "POST",
          url: "/api/profile/tools/argocd/login",
          headers: { cookie, "x-afe-csrf": csrf },
          payload: { connectionId },
        })
      ).statusCode,
    ).toBe(403);
    const profile = await afe.app.inject({ url: "/api/profile", headers: { cookie } });
    expect(profile.body).not.toContain("Production");
  }
  await setUserToolPolicy(pool, "default", userId, "argocd", {
    mode: "source + custom",
    custom: [],
  });
  expect((await getUserToolPolicy(pool, "default", userId, "argocd")).mode).toBe("source + custom");
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: "/api/profile/tools/argocd/login",
        headers: { cookie, "x-afe-csrf": csrf },
        payload: { connectionId: otherConnectionId },
      })
    ).statusCode,
  ).toBe(409);
  bad = "unsafe_jwks";
  expect((await configure()).statusCode).toBe(400);
  bad = "issuer_discovery";
  expect((await configure()).statusCode).toBe(400);
  bad = "provider_error";
  const url = await start();
  expect((await callback(url)).statusCode).toBe(502);
  expect(logs).not.toContain("provider-secret-not-for-logs");
});

it("prevents an in-flight callback from relinking after explicit unlink", async () => {
  const url = await start();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  pauseToken = () => {
    entered();
    return new Promise<void>((r) => (release = r));
  };
  const result = callback(url);
  await started;
  expect(
    (
      await afe.app.inject({
        method: "DELETE",
        url: "/api/profile/tools/argocd",
        headers: { cookie, "x-afe-csrf": csrf },
      })
    ).statusCode,
  ).toBe(200);
  release();
  expect((await result).statusCode).toBe(502);
  expect((await pool.query("SELECT * FROM user_tool_accounts")).rowCount).toBe(0);
});
it("rejects other users/tenants and drops SSO grants on expiry or configuration removal", async () => {
  const url = await start();
  await pool.query("INSERT INTO tenants(id,name)VALUES('other','Other')");
  for (const tid of ["default", "other"]) {
    const other = await createLocalUser(pool, tid, "bob");
    await setUserToolPolicy(pool, tid, other.user.id, "argocd", { mode: "source", custom: [] });
    const login = await afe.app.inject({
      method: "POST",
      url: "/api/session",
      payload: { token: other.token },
    });
    const sentCookie = (login.headers["set-cookie"] as string[])
      .map((c) => c.split(";")[0])
      .join("; ");
    expect((await callback(url, "", sentCookie)).statusCode).toBe(400);
  }
  expect((await callback(url)).statusCode).toBe(303);
  const account = (
    await pool.query("SELECT * FROM user_tool_accounts WHERE tenant_id='default' AND user_id=$1", [
      userId,
    ])
  ).rows[0];
  const { sourceAccess } = await import("../src/auth/tool-accounts.ts");
  expect(
    await sourceAccess(afe.context, "default", {
      ...account,
      context: { ...account.context, expiresAt: 1 },
    }),
  ).toEqual([]);
  expect(
    (
      await afe.app.inject({
        method: "DELETE",
        url: `/api/connections/argocd/${connectionId}/oidc`,
        headers,
      })
    ).statusCode,
  ).toBe(200);
  expect(await sourceAccess(afe.context, "default", account)).toEqual([]);
});

it("preserves OIDC configuration atomically when reconnecting the collection account", async () => {
  const { getConnection } = await import("@afe/db");
  const before = await getConnection(pool, "default", connectionId);
  await upsertConnection(pool, "default", {
    source: "argocd",
    externalId: issuer + "/argo",
    name: "Reconnected",
    status: "active",
    config: { serverUrl: issuer.replace("/issuer", "") },
    preserveConfigKeys: ["userOidc"],
  });
  expect((await getConnection(pool, "default", connectionId))?.config.userOidc).toEqual(
    before?.config.userOidc,
  );
  const wrongTenant = await afe.app.inject({
    method: "PUT",
    url: `/api/connections/argocd/${randomUUID()}/oidc`,
    headers,
    payload: { issuer, clientId: "afe-client", authMethod: "none", scopes: ["openid"] },
  });
  expect(wrongTenant.statusCode).toBe(404);
  for (const value of [
    "https://user:password@afe.example",
    "https://afe.example/path",
    "https://afe.example#",
  ]) {
    afe.context.config.publicUrl = value;
    expect((await configure()).statusCode).toBe(409);
    expect(
      (
        await afe.app.inject({
          method: "POST",
          url: "/api/profile/tools/argocd/login",
          headers: { cookie, "x-afe-csrf": csrf },
          payload: { connectionId },
        })
      ).statusCode,
    ).toBe(409);
  }
});
