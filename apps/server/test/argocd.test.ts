import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { DEFAULT_TENANT_ID } from "@afe/core";
import { randomBytes } from "node:crypto";
import { EnvKeyProvider } from "@afe/core/security";
import { createTestPool } from "@afe/db/testing";
import {
  getConnection,
  getConnectionCredentialIds,
  getCredentialMetadata,
  listCredentials,
} from "@afe/db";
import { TEST_CA_PEM, startFakeArgoCd, type FakeArgoCd } from "@afe/connector-argocd/testing";
import { buildAfe, loadConfig, type ServerContext } from "../src/index.ts";
import { createArgoCdModule } from "../src/connectors/argocd.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const TOKEN = "afe-readonly-token-SECRET";
const ADMIN = "admin-token-SECRET";

describe("ArgoCD connector module", () => {
  let pool: pg.Pool;
  let fake: FakeArgoCd;
  let app: FastifyInstance;
  let ctx: ServerContext;
  const logs: string[] = [];
  const module = createArgoCdModule({ retries: 0 });

  async function build(allowPrivate: boolean) {
    const keys = new EnvKeyProvider({ keys: { default: randomBytes(32) } });
    return buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "debug",
      logStream: new Writable({
        write(chunk, _e, cb) {
          logs.push(String(chunk));
          cb();
        },
      }),
      keys,
      config: loadConfig({
        DATABASE_URL: "unused",
        AFE_ALLOW_PRIVATE_NETWORK_TARGETS: allowPrivate ? "true" : "false",
      }),
      connectors: [module],
    });
  }

  beforeAll(async () => {
    pool = await createTestPool();
    fake = await startFakeArgoCd({
      applications: [{ metadata: { name: "guestbook" }, spec: { project: "default" } }],
      accounts: {
        [TOKEN]: { username: "afe" },
        [ADMIN]: { username: "admin", can: () => true },
      },
    });
    const built = await build(true);
    app = built.app;
    ctx = built.context;
  });
  afterAll(async () => {
    await app.close();
    await fake.close();
    await pool.end();
  });

  const connect = (payload: object) =>
    app.inject({ method: "POST", url: "/api/connections/argocd", payload });

  let connectionId = "";

  it("connects a read-only token, stores it encrypted and never returns it", async () => {
    const res = await connect({
      url: fake.url + "/",
      token: TOKEN,
      caPem: TEST_CA_PEM,
      name: "lab",
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("SECRET");
    const body = res.json();
    expect(body).toMatchObject({
      connection: { source: "argocd", name: "lab", externalId: fake.url, status: "active" },
      account: { username: "afe" },
      readOnlyCheck: { status: "verified" },
    });
    expect(body.connection.caCertificates[0].subject).toContain("Afe Test ArgoCD CA");
    connectionId = body.connection.id;

    const conn = await getConnection(pool, DEFAULT_TENANT_ID, connectionId);
    expect(JSON.stringify(conn!.config)).not.toContain("SECRET");
    expect(conn!.config).toMatchObject({ serverUrl: fake.url, account: "afe" });
    const ids = await getConnectionCredentialIds(pool, DEFAULT_TENANT_ID, connectionId);
    expect((await getCredentialMetadata(pool, DEFAULT_TENANT_ID, ids.api_token!))?.kind).toBe(
      "argocd_api_token",
    );
  });

  it("lists connections and tests a stored connection", async () => {
    const list = await app.inject({ method: "GET", url: "/api/connections/argocd" });
    expect(list.json().connections).toHaveLength(1);
    const res = await app.inject({
      method: "POST",
      url: `/api/connections/argocd/${connectionId}/test`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, account: { username: "afe" } });
  });

  it("health probe succeeds for the stored connection", async () => {
    const conn = await getConnection(pool, DEFAULT_TENANT_ID, connectionId);
    expect(await module.health!(ctx).probe(conn!)).toEqual({ ok: true });
  });

  it("reconnecting the same instance replaces and revokes the old token", async () => {
    const before = await getConnectionCredentialIds(pool, DEFAULT_TENANT_ID, connectionId);
    const res = await connect({ url: fake.url, token: TOKEN, caPem: TEST_CA_PEM });
    expect(res.statusCode).toBe(201);
    expect(res.json().connection.id).toBe(connectionId);
    const after = await getConnectionCredentialIds(pool, DEFAULT_TENANT_ID, connectionId);
    expect(after.api_token).not.toBe(before.api_token);
    expect(
      (await getCredentialMetadata(pool, DEFAULT_TENANT_ID, before.api_token!))?.revokedAt,
    ).not.toBeNull();
  });

  it("rejects a bad token", async () => {
    const res = await connect({ url: fake.url, token: "nope-SECRET", caPem: TEST_CA_PEM });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "connection_failed", kind: "unauthorized" });
  });

  it("rejects a sync-capable token", async () => {
    const res = await connect({ url: fake.url, token: ADMIN, caPem: TEST_CA_PEM });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("token_not_read_only");
    expect(res.json().writeCapabilities).toContain("applications/sync on *");
  });

  it("rejects an untrusted certificate when no CA is configured", async () => {
    const res = await connect({ url: fake.url, token: TOKEN });
    expect(res.statusCode).toBe(422);
    expect(res.json().kind).toBe("tls");
  });

  it("rejects invalid input: bad URL, CA with a private key", async () => {
    expect((await connect({ url: "not a url", token: TOKEN })).statusCode).toBe(400);
    const res = await connect({
      url: fake.url,
      token: TOKEN,
      caPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
    });
    expect(res.statusCode).toBe(400);
  });

  it("blocks private network targets unless the operator allows them", async () => {
    const strict = await build(false);
    try {
      const res = await strict.app.inject({
        method: "POST",
        url: "/api/connections/argocd",
        payload: { url: fake.url, token: TOKEN, caPem: TEST_CA_PEM },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/private/);
    } finally {
      await strict.app.close();
    }
  });

  it("disconnects: revokes the credential and the probe reports it", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/connections/argocd/${connectionId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connection.status).toBe("disconnected");
    expect(await listCredentials(pool, DEFAULT_TENANT_ID)).toHaveLength(0);
    const conn = await getConnection(pool, DEFAULT_TENANT_ID, connectionId);
    const probe = await module.health!(ctx).probe(conn!);
    expect(probe.ok).toBe(false);
    const missing = await app.inject({
      method: "DELETE",
      url: "/api/connections/argocd/00000000-0000-4000-8000-000000000000",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("only issued GET requests to ArgoCD and never logged a token", () => {
    expect(new Set(fake.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(logs.join("")).not.toMatch(/SECRET/);
  });
});
