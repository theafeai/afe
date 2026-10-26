import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { EnvKeyProvider, Secret } from "@afe/core/security";
import { createTestPool } from "@afe/db/testing";
import { getConnection, getConnectionCredentialIds, getCredentialMetadata } from "@afe/db";
import { FakeVercelApi } from "@afe/connector-vercel/testing";
import { buildAfe, InlineJobQueue, type AfeConfig, type ServerContext } from "../src/index.ts";
import { createVercelModule, vercelReader } from "../src/connectors/vercel.ts";

const NOW = 1_800_000_000_000;
const TEAM = { id: "team_acme", slug: "acme", name: "Acme" };
const USER = { id: "usr_alice", username: "alice" };
const PUBLIC_URL = "https://afe.example.com";

function fakeApi(): FakeVercelApi {
  const api = new FakeVercelApi()
    .addUser(USER)
    .addTeam(TEAM)
    .addTeam({ id: "team_other", slug: "other" })
    .addProject(TEAM.id, { id: "prj_web", name: "web", updatedAt: 3 })
    .addProject(TEAM.id, { id: "prj_api", name: "api", updatedAt: 2 })
    .addProject(TEAM.id, { id: "prj_secret", name: "secret-lab", updatedAt: 1 });
  for (const projectId of ["prj_web", "prj_secret"]) {
    api.addDeployment(TEAM.id, {
      id: `dpl_${projectId}`,
      name: projectId,
      projectId,
      createdAt: NOW - 1000,
    });
  }
  return api;
}

describe("vercel connector module", () => {
  let pool: pg.Pool;
  let api: FakeVercelApi;
  let app: FastifyInstance;
  let ctx: ServerContext;
  let jobs: InlineJobQueue;
  let tenant = "default";
  const logs: string[] = [];
  const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });

  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM connection_credentials");
    await pool.query("DELETE FROM connections");
    await pool.query("DELETE FROM webhook_deliveries");
    tenant = "default";
    logs.length = 0;
    api = fakeApi();
    jobs = new InlineJobQueue();
    const config: AfeConfig = {
      databaseUrl: "unused",
      host: "127.0.0.1",
      port: 0,
      logLevel: "info",
      allowPrivateNetworkTargets: false,
      allowInsecureHttpTargets: false,
      publicUrl: PUBLIC_URL,
      vercel: {
        clientId: api.clientId,
        clientSecret: new Secret(api.clientSecret),
        integrationSlug: "afe-test",
      },
    };
    const built = await buildAfe({
      pool,
      keys,
      jobs,
      config,
      logLevel: "debug",
      logStream: new Writable({
        write(chunk, _e, cb) {
          logs.push(String(chunk));
          cb();
        },
      }),
      connectors: [
        createVercelModule({ fetch: api.fetch, now: () => NOW, resolveTenant: () => tenant }),
      ],
    });
    app = built.app;
    ctx = built.context;
    jobs.register(built.jobDefinitions);
  });

  async function installViaOAuth(teamId: string | null = TEAM.id) {
    const install = await app.inject({ method: "GET", url: "/api/connections/vercel/install" });
    expect(install.statusCode).toBe(302);
    const location = new URL(install.headers.location as string);
    const cookie = String(install.headers["set-cookie"]).split(";")[0]!;
    api.oauthCodes.set("code-1", {
      code: "code-1",
      token: "oauth-token-SECRET",
      configurationId: "icfg_1",
      userId: USER.id,
      teamId,
      redirectUri: `${PUBLIC_URL}/api/connections/vercel/callback`,
    });
    const state = location.searchParams.get("state")!;
    const cb = await app.inject({
      method: "GET",
      url: `/api/connections/vercel/callback?code=code-1&configurationId=icfg_1&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    return { install, location, cookie, state, cb };
  }

  async function connectionId(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM connections");
    return rows[0]!.id;
  }

  function webhook(body: object, secret?: string) {
    return api.signedWebhook({ createdAt: NOW, ...body }, secret);
  }

  it("connects via the Vercel Integration (OAuth) and stores the token as a credential", async () => {
    const { location, install, cb } = await installViaOAuth();
    expect(location.origin + location.pathname).toBe(
      "https://vercel.com/integrations/afe-test/new",
    );
    expect(String(install.headers["set-cookie"])).toMatch(/HttpOnly.*SameSite=Lax.*Secure/);
    expect(cb.statusCode).toBe(302);
    const id = await connectionId();
    expect(cb.headers.location).toBe(`${PUBLIC_URL}/connections/vercel/${id}/projects`);

    const conn = (await getConnection(pool, "default", id))!;
    expect(conn).toMatchObject({ externalId: TEAM.id, name: "Acme", status: "active" });
    expect(conn.config).toEqual({
      mode: "integration",
      teamId: TEAM.id,
      userId: USER.id,
      configurationId: "icfg_1",
      projectSelection: { mode: "none" },
    });
    expect(JSON.stringify(conn.config)).not.toContain("SECRET");
    const creds = await getConnectionCredentialIds(pool, "default", id);
    expect((await getCredentialMetadata(pool, "default", creds.access_token!))!.kind).toBe(
      "vercel_oauth_token",
    );
    expect(logs.join("")).not.toMatch(/SECRET|client-secret-test/);
  });

  it("uses the user id as external id for personal accounts", async () => {
    await installViaOAuth(null);
    const conn = (await getConnection(pool, "default", await connectionId()))!;
    expect(conn.externalId).toBe(USER.id);
    expect(conn.name).toBe("alice");
  });

  it("rejects a callback with a bad, foreign or unbound state", async () => {
    const { state, cookie } = await installViaOAuth();
    await pool.query("DELETE FROM connection_credentials");
    await pool.query("DELETE FROM connections");
    const tampered = state.replace(/^./, (c) => (c === "e" ? "f" : "e"));
    for (const [s, c] of [
      [tampered, cookie],
      [state, undefined],
      [state, "afe_vercel_state=other-nonce"],
      ["garbage", cookie],
    ] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/api/connections/vercel/callback?code=x&state=${encodeURIComponent(s)}`,
        ...(c ? { headers: { cookie: c } } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_state");
    }
    expect((await pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
  });

  it("connects with an access token (fallback) and warns about its scope", async () => {
    api.grant("pat-token-SECRET", USER.id, [TEAM.id]);
    const res = await app.inject({
      method: "POST",
      url: "/api/connections/vercel",
      payload: { token: "pat-token-SECRET", teamId: TEAM.id },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.connection).toMatchObject({ externalId: TEAM.id, status: "active" });
    expect(body.connection.config.mode).toBe("token");
    expect(body.warnings[0]).toMatch(/cannot be limited to read-only/);
    expect(res.body).not.toContain("SECRET");

    const noTeam = await app.inject({
      method: "POST",
      url: "/api/connections/vercel",
      payload: { token: "pat-token-SECRET", teamId: "team_other" },
    });
    expect(noTeam.json().error).toBe("team_not_accessible");
    const bad = await app.inject({
      method: "POST",
      url: "/api/connections/vercel",
      payload: { token: "wrong-token-xx", teamId: TEAM.id },
    });
    expect(bad.json().error).toBe("token_rejected");
    expect(logs.join("")).not.toContain("SECRET");
  });

  it("lists projects and persists and enforces the selection", async () => {
    await installViaOAuth();
    const id = await connectionId();
    const list = await app.inject({ method: "GET", url: `/api/connections/vercel/${id}/projects` });
    expect(list.statusCode).toBe(200);
    expect(list.json().projects.map((p: { id: string }) => p.id)).toEqual([
      "prj_web",
      "prj_api",
      "prj_secret",
    ]);
    expect(list.json().projects.every((p: { selected: boolean }) => !p.selected)).toBe(true);
    expect(list.body).not.toContain("SECRET");

    const unknown = await app.inject({
      method: "PUT",
      url: `/api/connections/vercel/${id}/projects`,
      payload: { projectIds: ["prj_nope"] },
    });
    expect(unknown.statusCode).toBe(400);

    const put = await app.inject({
      method: "PUT",
      url: `/api/connections/vercel/${id}/projects`,
      payload: { projectIds: ["prj_web", "prj_api"] },
    });
    expect(put.json().selection).toEqual({ mode: "selected", projectIds: ["prj_web", "prj_api"] });
    const conn = (await getConnection(pool, "default", id))!;
    expect(conn.config.projectSelection).toEqual({
      mode: "selected",
      projectIds: ["prj_web", "prj_api"],
    });

    // Reads go only to selected projects.
    api.requests.length = 0;
    const reader = vercelReader(ctx, conn, { fetch: api.fetch });
    const deployments = await reader.listAllSelectedDeployments();
    expect(deployments.map((d) => d.uid)).toEqual(["dpl_prj_web"]);
    await expect(reader.listDeployments("prj_secret")).rejects.toThrow(/not selected/);
    expect(api.requests.some((r) => r.query.projectId === "prj_secret")).toBe(false);
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);

    // Webhooks for unselected projects are not queued.
    for (const [deliveryId, projectId] of [
      ["d1", "prj_web"],
      ["d2", "prj_secret"],
    ]) {
      const hook = webhook({
        id: deliveryId,
        type: "deployment.created",
        payload: { team: { id: TEAM.id }, project: { id: projectId }, deployment: { id: "x" } },
      });
      const res = await app.inject({ method: "POST", url: "/webhooks/vercel", ...hook });
      expect(res.statusCode).toBe(200);
    }
    expect(jobs.sent.map((j) => (j.data as { projectId: string }).projectId)).toEqual(["prj_web"]);
    await jobs.drain();

    const all = await app.inject({
      method: "PUT",
      url: `/api/connections/vercel/${id}/projects`,
      payload: { projects: "all" },
    });
    expect(all.json().selection).toEqual({ mode: "all" });
    const none = await app.inject({
      method: "PUT",
      url: `/api/connections/vercel/${id}/projects`,
      payload: { projectIds: [] },
    });
    expect(none.json().selection).toEqual({ mode: "none" });
  });

  it("does not expose another tenant's connection", async () => {
    await installViaOAuth();
    const id = await connectionId();
    tenant = "tenant-b";
    for (const [method, url] of [
      ["GET", `/api/connections/vercel/${id}/projects`],
      ["PUT", `/api/connections/vercel/${id}/projects`],
      ["DELETE", `/api/connections/vercel/${id}`],
    ] as const) {
      const res = await app.inject({ method, url, payload: { projects: "all" } });
      expect(res.statusCode).toBe(404);
    }
    expect((await getConnection(pool, "default", id))!.status).toBe("active");
  });

  it("treats 401 from Vercel as revocation (routes and health probe)", async () => {
    await installViaOAuth();
    const id = await connectionId();
    const health = createVercelModule({ fetch: api.fetch }).health!(ctx);
    expect(await health.probe((await getConnection(pool, "default", id))!)).toEqual({ ok: true });

    api.revoke("oauth-token-SECRET");
    const res = await app.inject({ method: "GET", url: `/api/connections/vercel/${id}/projects` });
    expect(res.statusCode).toBe(409);
    const conn = (await getConnection(pool, "default", id))!;
    expect(conn.status).toBe("revoked");
    expect(conn.statusReason).toMatch(/401/);
    expect(await health.probe(conn)).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("handles integration-configuration.removed by revoking the connection", async () => {
    await installViaOAuth();
    const id = await connectionId();
    const hook = webhook({
      id: "evt_rm",
      type: "integration-configuration.removed",
      payload: { team: { id: TEAM.id }, user: { id: USER.id }, configuration: { id: "icfg_1" } },
    });
    const res = await app.inject({ method: "POST", url: "/webhooks/vercel", ...hook });
    expect(res.statusCode).toBe(200);
    const conn = (await getConnection(pool, "default", id))!;
    expect(conn.status).toBe("revoked");
    expect(conn.statusReason).toMatch(/integration was removed/);
    const creds = await getConnectionCredentialIds(pool, "default", id);
    expect((await getCredentialMetadata(pool, "default", creds.access_token!))!.revokedAt).not.toBe(
      null,
    );
    expect(jobs.sent).toHaveLength(0);
  });

  it("ignores lifecycle events for another installation", async () => {
    await installViaOAuth();
    const hook = webhook({
      id: "evt_other",
      type: "integration-configuration.removed",
      payload: { team: { id: TEAM.id }, configuration: { id: "icfg_other" } },
    });
    await app.inject({ method: "POST", url: "/webhooks/vercel", ...hook });
    expect((await getConnection(pool, "default", await connectionId()))!.status).toBe("active");
  });

  it("rejects bad signatures, stale deliveries and replays", async () => {
    await installViaOAuth();
    const id = await connectionId();
    await app.inject({
      method: "PUT",
      url: `/api/connections/vercel/${id}/projects`,
      payload: { projects: "all" },
    });
    const body = {
      id: "evt_1",
      type: "deployment.succeeded",
      payload: { team: { id: TEAM.id }, project: { id: "prj_web" } },
    };
    const forged = webhook(body, "wrong-secret");
    expect(
      (await app.inject({ method: "POST", url: "/webhooks/vercel", ...forged })).statusCode,
    ).toBe(401);
    const unsigned = webhook(body);
    delete unsigned.headers["x-vercel-signature"];
    expect(
      (await app.inject({ method: "POST", url: "/webhooks/vercel", ...unsigned })).statusCode,
    ).toBe(401);
    const stale = api.signedWebhook({ ...body, createdAt: NOW - 60 * 60 * 1000 });
    expect(
      (await app.inject({ method: "POST", url: "/webhooks/vercel", ...stale })).statusCode,
    ).toBe(401);
    expect(jobs.sent).toHaveLength(0);

    const good = webhook(body);
    const first = await app.inject({ method: "POST", url: "/webhooks/vercel", ...good });
    const replay = await app.inject({ method: "POST", url: "/webhooks/vercel", ...good });
    expect(first.json().status).toBe("accepted");
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe("duplicate");
    expect(jobs.sent).toHaveLength(1);
    expect(jobs.sent[0]).toMatchObject({
      name: "vercel.webhook",
      data: { tenantId: "default", connectionId: id, deliveryId: "evt_1" },
    });
    expect(logs.join("")).not.toContain(good.headers["x-vercel-signature"]);
  });

  it("verifies account webhooks of token connections with their own secret", async () => {
    api.grant("pat-token-SECRET", USER.id, [TEAM.id]);
    const whsec = "account-webhook-secret-SECRET";
    await app.inject({
      method: "POST",
      url: "/api/connections/vercel",
      payload: { token: "pat-token-SECRET", teamId: TEAM.id, webhookSecret: whsec },
    });
    const id = await connectionId();
    await app.inject({
      method: "PUT",
      url: `/api/connections/vercel/${id}/projects`,
      payload: { projectIds: ["prj_web"] },
    });
    const body = {
      id: "evt_acct",
      type: "deployment.created",
      payload: { team: { id: TEAM.id }, project: { id: "prj_web" } },
    };
    const wrong = webhook(body); // signed with the integration secret
    expect(
      (await app.inject({ method: "POST", url: `/webhooks/vercel/${TEAM.id}`, ...wrong }))
        .statusCode,
    ).toBe(401);
    const ok = webhook(body, whsec);
    const res = await app.inject({ method: "POST", url: `/webhooks/vercel/${TEAM.id}`, ...ok });
    expect(res.json().status).toBe("accepted");
    expect(jobs.sent).toHaveLength(1);
    expect(logs.join("")).not.toContain("SECRET");
  });

  it("disconnects: removes the integration at Vercel and revokes credentials", async () => {
    await installViaOAuth();
    const id = await connectionId();
    const res = await app.inject({ method: "DELETE", url: `/api/connections/vercel/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      vercelIntegrationRemoved: true,
      connection: { status: "disconnected" },
    });
    expect(api.deletedConfigurations).toEqual(["icfg_1"]);
    const creds = await getConnectionCredentialIds(pool, "default", id);
    expect((await getCredentialMetadata(pool, "default", creds.access_token!))!.revokedAt).not.toBe(
      null,
    );
    // Only auth-lifecycle calls use methods other than GET.
    const nonGet = api.requests.filter((r) => r.method !== "GET").map((r) => r.path);
    expect(nonGet).toEqual(["/v2/oauth/access_token", "/v1/integrations/configuration/icfg_1"]);
  });

  it("returns 404 for integration routes when the integration is not configured", async () => {
    const built = await buildAfe({
      pool,
      keys,
      logLevel: "silent",
      connectors: [createVercelModule({ fetch: api.fetch })],
    });
    for (const url of ["/api/connections/vercel/install", "/api/connections/vercel/callback"]) {
      expect((await built.app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
    await built.app.close();
  });
});
