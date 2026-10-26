import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createMemoryEventSink, type Connection, type MemoryEventSink } from "@afe/core";
import { EnvKeyProvider, Secret, signHmac } from "@afe/core/security";
import { listConnections, upsertConnection } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import type { GitHubAppConfig } from "@afe/connector-github";
import {
  fakeGitHub,
  installationFixture,
  json,
  testKeyPair,
} from "../../../packages/connector-github/test/fixtures.ts";
import { buildAfe, InlineJobQueue, type AfeApp } from "../src/index.ts";
import { createGitHubModule, type GitHubModuleOptions } from "../src/connectors/github.ts";

const WEBHOOK_SECRET = "whsec-TEST-SECRET";
const { privatePem } = testKeyPair();
const appConfig: GitHubAppConfig = {
  appId: "77",
  slug: "afe-test",
  privateKey: new Secret(privatePem),
  webhookSecret: new Secret(WEBHOOK_SECRET),
};
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });

const sender = { id: 501, login: "octocat", type: "User" };

function githubApi() {
  return fakeGitHub({
    "GET /app/installations/4242": () =>
      json(200, installationFixture({ created_at: new Date().toISOString() })),
    "GET /app/installations/5555": () =>
      json(200, installationFixture({ id: 5555, created_at: "2020-01-01T00:00:00Z" })),
    "GET /app/installations/999": () => json(404, { message: "Not Found" }),
    "POST /app/installations/4242/access_tokens": () =>
      json(201, {
        token: "ghs_INSTALLATION_TOKEN_SECRET",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { actions: "read" },
      }),
    "GET /installation/repositories": () =>
      json(200, {
        total_count: 2,
        repositories: [
          { id: 11, name: "api", full_name: "acme/api" },
          { id: 12, name: "web", full_name: "acme/web" },
        ],
      }),
  });
}

describe("GitHub connector module", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let jobs: InlineJobQueue;
  let sink: MemoryEventSink;
  let api: ReturnType<typeof githubApi>;
  let logLines: string[];
  let deliveries = 0;

  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  async function start(options: GitHubModuleOptions = {}) {
    api = githubApi();
    jobs = new InlineJobQueue();
    sink = createMemoryEventSink();
    logLines = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    });
    afe = await buildAfe({
      pool,
      jobs,
      sink,
      keys,
      logLevel: "debug",
      logStream,
      connectors: [
        createGitHubModule({
          app: appConfig,
          http: { fetch: api.fetch, sleep: async () => {} },
          stateSecret: "state-secret",
          ...options,
        }),
      ],
    });
    jobs.register(afe.jobDefinitions);
  }

  beforeEach(async () => {
    await pool.query(
      "DELETE FROM connections; DELETE FROM webhook_deliveries; DELETE FROM github_apps",
    );
    await start();
  });
  afterEach(async () => {
    await afe.app.close();
    // Never log secrets, tokens or signatures (rules R4).
    const logs = logLines.join("");
    expect(logs).not.toContain(WEBHOOK_SECRET);
    expect(logs).not.toContain("ghs_INSTALLATION_TOKEN_SECRET");
    expect(logs).not.toContain("PRIVATE KEY");
    expect(logs).not.toMatch(/sha256=[0-9a-f]{64}/);
  });

  function send(
    event: string,
    payload: unknown,
    opts: { deliveryId?: string; signature?: string | null } = {},
  ) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.deliveryId ?? `d-${++deliveries}`,
    };
    const sig =
      opts.signature === undefined
        ? signHmac("sha256", WEBHOOK_SECRET, body, "sha256=")
        : opts.signature;
    if (sig !== null) headers["x-hub-signature-256"] = sig;
    return afe.app.inject({ method: "POST", url: "/webhooks/github", headers, payload: body });
  }

  const installed = (overrides: Record<string, unknown> = {}) => ({
    action: "created",
    installation: installationFixture(overrides),
    repositories: [{ id: 11, name: "api", full_name: "acme/api" }],
    sender,
  });

  async function only(): Promise<Connection> {
    const conns = await listConnections(pool, "default", { source: "github" });
    expect(conns).toHaveLength(1);
    return conns[0]!;
  }

  describe("webhook authenticity", () => {
    it("rejects missing, malformed and wrong signatures with 401", async () => {
      for (const signature of [null, "sha256=deadbeef", "sha256=" + "0".repeat(64), "sha1=abc"]) {
        const res = await send("installation", installed(), { signature });
        expect(res.statusCode).toBe(401);
        expect(res.body).toBe('{"error":"invalid signature"}');
      }
      const res = await send("installation", installed(), {
        signature: signHmac("sha256", "other-secret", JSON.stringify(installed()), "sha256="),
      });
      expect(res.statusCode).toBe(401);
      expect(await listConnections(pool, "default")).toHaveLength(0);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM webhook_deliveries");
      expect(rows[0].n).toBe(0);
    });

    it("rejects a replayed delivery without processing it again", async () => {
      const first = await send("installation", installed(), { deliveryId: "dup-1" });
      expect(first.statusCode).toBe(200);
      await send("installation", { ...installed(), action: "suspend" }, { deliveryId: "dup-2" });
      const replay = await send("installation", installed(), { deliveryId: "dup-1" });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ duplicate: true });
      expect((await only()).status).toBe("suspended");
      expect(sink.events("default").map((e) => e.action)).toEqual([
        "connection.created",
        "connection.suspended",
      ]);
    });

    it("answers ping and returns 503 when no App is configured", async () => {
      expect((await send("ping", { zen: "hi" })).statusCode).toBe(200);
      await afe.app.close();
      await start({ app: null });
      expect((await send("ping", {})).statusCode).toBe(503);
    });
  });

  describe("lifecycle events", () => {
    it("installation created: connection active with account, repos and permissions", async () => {
      const res = await send("installation", installed());
      expect(res.statusCode).toBe(200);
      const conn = await only();
      expect(conn).toMatchObject({
        externalId: "4242",
        name: "acme",
        status: "active",
        statusReason: null,
      });
      expect(conn.config).toMatchObject({
        installationId: 4242,
        account: { id: 9001, login: "acme", type: "Organization" },
        repositorySelection: "selected",
        repositories: [{ id: 11, fullName: "acme/api" }],
        permissionCheck: { ok: true },
      });
      const [event] = sink.events("default");
      expect(event).toMatchObject({
        source: "afe",
        action: "connection.created",
        connectionId: conn.id,
        actor: { type: "user", id: "501", login: "octocat" },
        target: { type: "connection", id: conn.id, name: "acme" },
        observation: { method: "webhook" },
      });
      expect(event!.rawPayload).not.toBeNull();
    });

    it("all-repositories installs store 'all'", async () => {
      await send("installation", {
        ...installed({ repository_selection: "all" }),
        repositories: [],
      });
      expect((await only()).config.repositories).toBe("all");
    });

    it("is ignored when adoption is off and no tenant claimed the installation", async () => {
      await afe.app.close();
      await start({ adoptInstallationsInto: null });
      const res = await send("installation", installed());
      expect(res.statusCode).toBe(202);
      expect(await listConnections(pool, "default")).toHaveLength(0);
      const { rows } = await pool.query("SELECT tenant_id FROM webhook_deliveries");
      expect(rows).toEqual([{ tenant_id: null }]);
    });

    it("deleted revokes the connection", async () => {
      await send("installation", installed());
      await send("installation", {
        action: "deleted",
        installation: installationFixture(),
        sender,
      });
      expect(await only()).toMatchObject({
        status: "revoked",
        statusReason: "GitHub App uninstalled",
      });
      expect(sink.events("default").at(-1)!.action).toBe("connection.revoked");
    });

    it("suspend and unsuspend", async () => {
      await send("installation", installed());
      await send("installation", {
        action: "suspend",
        installation: installationFixture({
          suspended_at: "2026-10-26T11:00:00Z",
          suspended_by: sender,
        }),
        sender,
      });
      expect(await only()).toMatchObject({ status: "suspended" });
      await send("installation", {
        action: "unsuspend",
        installation: installationFixture({ updated_at: "2026-10-26T12:00:00Z" }),
        sender,
      });
      const conn = await only();
      expect(conn).toMatchObject({ status: "active", statusReason: null });
      expect(conn.config.repositories).toEqual([{ id: 11, fullName: "acme/api" }]);
      expect(sink.events("default").map((e) => e.action)).toEqual([
        "connection.created",
        "connection.suspended",
        "connection.resumed",
      ]);
    });

    it("new_permissions_accepted re-checks permissions and surfaces write access", async () => {
      await send("installation", installed());
      await send("installation", {
        action: "new_permissions_accepted",
        installation: installationFixture({
          permissions: { actions: "read", deployments: "write", metadata: "read" },
          updated_at: "2026-10-26T13:00:00Z",
        }),
        sender,
      });
      const conn = await only();
      expect(conn.status).toBe("active");
      expect(conn.statusReason).toBe(
        "write access granted (Afe needs read only): deployments; missing read permission: environments",
      );
      expect(conn.config.permissionCheck).toEqual({
        ok: false,
        missing: ["environments"],
        writable: ["deployments"],
        extra: [],
      });
      const last = sink.events("default").at(-1)!;
      expect(last.action).toBe("connection.updated");
      expect(last.data).toMatchObject({ change: "permissions" });
      expect(logLines.join("")).toContain("permission check failed");
    });

    it("an install that lacks a required permission is flagged at creation", async () => {
      await send("installation", installed({ permissions: { metadata: "read", actions: "read" } }));
      const conn = await only();
      expect(conn.statusReason).toBe("missing read permission: deployments, environments");
    });

    it("installation_repositories added and removed", async () => {
      await send("installation", installed());
      await send("installation_repositories", {
        action: "added",
        installation: installationFixture(),
        repository_selection: "selected",
        repositories_added: [{ id: 12, name: "web", full_name: "acme/web" }],
        repositories_removed: [],
        sender,
      });
      expect((await only()).config.repositories).toEqual([
        { id: 11, fullName: "acme/api" },
        { id: 12, fullName: "acme/web" },
      ]);
      await send("installation_repositories", {
        action: "removed",
        installation: installationFixture(),
        repository_selection: "selected",
        repositories_added: [],
        repositories_removed: [{ id: 11, name: "api", full_name: "acme/api" }],
        sender,
      });
      expect((await only()).config.repositories).toEqual([{ id: 12, fullName: "acme/web" }]);
      const updates = sink.events("default").filter((e) => e.action === "connection.updated");
      expect(updates.map((e) => e.data)).toMatchObject([
        { change: "repositories", added: ["acme/web"], removed: [] },
        { change: "repositories", added: [], removed: ["acme/api"] },
      ]);
    });
  });

  describe("repository events", () => {
    it("enqueue a github.webhook job per active connection (processed by AFE-7)", async () => {
      await send("installation", installed());
      const conn = await only();
      jobs.sent.length = 0;
      const payload = { action: "completed", installation: { id: 4242 }, workflow_run: { id: 1 } };
      const res = await send("workflow_run", payload, { deliveryId: "run-1" });
      expect(res.statusCode).toBe(202);
      expect(jobs.sent).toHaveLength(1);
      expect(jobs.sent[0]).toMatchObject({
        name: "github.webhook",
        data: {
          tenantId: "default",
          connectionId: conn.id,
          installationId: 4242,
          deliveryId: "run-1",
          event: "workflow_run",
          action: "completed",
          payload,
          rawBody: JSON.stringify(payload),
        },
      });
      expect(JSON.stringify(jobs.sent)).not.toContain(WEBHOOK_SECRET);
      await jobs.drain(); // placeholder handler: no-op
      expect((await send("workflow_run", payload, { deliveryId: "run-1" })).json()).toMatchObject({
        duplicate: true,
      });
      expect(jobs.sent).toHaveLength(0);
    });

    it("are not enqueued for unknown installations", async () => {
      const res = await send("deployment", { action: "created", installation: { id: 1 } });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ queued: 0 });
      expect(jobs.sent).toHaveLength(0);
    });

    it("pass jobs to the AFE-7 processor when one is configured", async () => {
      await afe.app.close();
      const seen: string[] = [];
      await start({ processWebhook: async (job) => void seen.push(job.event) });
      await send("installation", installed());
      await send("deployment_status", { action: "created", installation: { id: 4242 } });
      await jobs.drain();
      expect(seen).toEqual(["deployment_status"]);
    });
  });

  describe("install flow", () => {
    async function startInstall() {
      const res = await afe.app.inject({ method: "GET", url: "/api/connections/github/install" });
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.origin + location.pathname).toBe(
        "https://github.com/apps/afe-test/installations/new",
      );
      const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
      expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Lax/);
      return { state: location.searchParams.get("state")!, cookie };
    }

    it("redirects to GitHub and connects the installation on setup", async () => {
      const { state, cookie } = await startInstall();
      const res = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/setup?installation_id=4242&setup_action=install&state=${encodeURIComponent(state)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().connection).toMatchObject({
        name: "acme",
        status: "active",
        repositories: [
          { id: 11, fullName: "acme/api" },
          { id: 12, fullName: "acme/web" },
        ],
      });
      const conn = await only();
      expect(conn.externalId).toBe("4242");
      expect(sink.events("default").map((e) => e.action)).toEqual(["connection.created"]);
      // The later installation.created webhook does not create a second event.
      await send("installation", installed());
      expect(sink.events("default")).toHaveLength(1);
      // Token was narrowed to read permissions.
      const mint = api.requests.find((r) => r.method === "POST");
      expect(mint?.body).toEqual({
        permissions: {
          actions: "read",
          deployments: "read",
          environments: "read",
          metadata: "read",
        },
      });
    });

    it("rejects a bad, forged or cookie-less state", async () => {
      const { state, cookie } = await startInstall();
      const cases = [
        { q: "state=garbage", cookie },
        { q: `state=${encodeURIComponent(state.slice(0, -2) + "xx")}`, cookie },
        { q: `state=${encodeURIComponent(state)}`, cookie: undefined },
        { q: `state=${encodeURIComponent(state)}`, cookie: "afe_github_flow=someone-else" },
      ];
      for (const c of cases) {
        const res = await afe.app.inject({
          method: "GET",
          url: `/api/connections/github/setup?installation_id=4242&${c.q}`,
          headers: c.cookie ? { cookie: c.cookie } : {},
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid or expired state" });
      }
      expect(await listConnections(pool, "default")).toHaveLength(0);
    });

    it("requires a state when adoption is off, and rejects unknown installations", async () => {
      await afe.app.close();
      await start({ adoptInstallationsInto: null });
      const res = await afe.app.inject({
        method: "GET",
        url: "/api/connections/github/setup?installation_id=4242",
      });
      expect(res.statusCode).toBe(400);
      const { state, cookie } = await startInstall();
      const unknown = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/setup?installation_id=999&state=${encodeURIComponent(state)}`,
        headers: { cookie },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toEqual({ error: "unknown installation" });
      // An installation created before the flow started cannot be claimed with it.
      const old = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/setup?installation_id=5555&state=${encodeURIComponent(state)}`,
        headers: { cookie },
      });
      expect(old.statusCode).toBe(400);
      expect(old.json()).toEqual({ error: "installation predates this install flow" });
    });

    it("keeps tenants apart: another tenant's installation cannot be claimed", async () => {
      await pool.query(
        "INSERT INTO tenants (id, name) VALUES ('tenant-b', 'B') ON CONFLICT DO NOTHING",
      );
      const other = await upsertConnection(pool, "tenant-b", {
        source: "github",
        externalId: "4242",
        name: "acme",
        status: "active",
      });
      const { state, cookie } = await startInstall();
      const res = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/setup?installation_id=4242&state=${encodeURIComponent(state)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      expect(await listConnections(pool, "default")).toHaveLength(0);
      // Its webhooks are routed to tenant-b only.
      await send("workflow_run", { action: "completed", installation: { id: 4242 } });
      expect(jobs.sent.map((j) => (j.data as { tenantId: string }).tenantId)).toEqual(["tenant-b"]);
      expect(jobs.sent[0]!.data).toMatchObject({ connectionId: other.id });
    });

    it("redirects a browser to the web UI after setup", async () => {
      const html = { accept: "text/html,application/xhtml+xml" };
      const { state, cookie } = await startInstall();
      const res = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/setup?installation_id=4242&setup_action=install&state=${encodeURIComponent(state)}`,
        headers: { cookie, ...html },
      });
      expect(res.statusCode).toBe(303);
      const conn = await only();
      expect(res.headers.location).toMatch(
        new RegExp(`/connections/${conn.id}\\?connected=github$`),
      );
      const bad = await afe.app.inject({
        method: "GET",
        url: "/api/connections/github/setup?installation_id=4242&state=garbage",
        headers: { cookie, ...html },
      });
      expect(bad.statusCode).toBe(303);
      expect(bad.headers.location).toMatch(
        /\/connections\/github\?error=invalid%20or%20expired%20state$/,
      );
      const second = await startInstall();
      const pending = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/setup?setup_action=request&state=${encodeURIComponent(second.state)}`,
        headers: { cookie: second.cookie, ...html },
      });
      expect(pending.statusCode).toBe(303);
      expect(pending.headers.location).toMatch(/\/connections\/github\?status=pending_approval$/);
    });

    it("tells the UI whether the App is configured, without secrets", async () => {
      const res = await afe.app.inject({ method: "GET", url: "/api/connections/github/app" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        configured: true,
        slug: "afe-test",
        installUrl: "/api/connections/github/install",
        manifestFlow: { available: false },
      });
      expect(res.body).not.toMatch(/PRIVATE KEY|secret/i);
    });

    it("reports installs awaiting org-owner approval", async () => {
      const { state, cookie } = await startInstall();
      const res = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/setup?setup_action=request&state=${encodeURIComponent(state)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(202);
    });
  });

  describe("manifest flow (self-host)", () => {
    it("registers an App and stores its credentials encrypted", async () => {
      await afe.app.close();
      const conversion = {
        id: 88,
        slug: "afe-self",
        name: "Afe self",
        client_id: "Iv1.abc",
        client_secret: "CLIENT-SECRET",
        webhook_secret: "MANIFEST-WEBHOOK-SECRET",
        pem: privatePem,
        html_url: "https://github.com/apps/afe-self",
        owner: { id: 1, login: "acme", type: "Organization" },
      };
      const gh = fakeGitHub({
        "POST /app-manifests/code123/conversions": () => json(201, conversion),
      });
      jobs = new InlineJobQueue();
      afe = await buildAfe({
        pool,
        jobs,
        sink,
        keys,
        logLevel: "silent",
        connectors: [
          createGitHubModule({
            env: {},
            http: { fetch: gh.fetch },
            publicUrl: "https://afe.example.com",
            stateSecret: "state-secret",
          }),
        ],
      });

      const page = await afe.app.inject({
        method: "GET",
        url: "/api/connections/github/manifest?org=acme",
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain(
        'action="https://github.com/organizations/acme/settings/apps/new?state=',
      );
      expect(page.body).toContain("https://afe.example.com/webhooks/github");
      const cookie = String(page.headers["set-cookie"]).split(";")[0]!;
      const state = decodeURIComponent(
        /state=([^"&]+)/.exec(page.body)![1]!.replace(/&amp;/g, "&"),
      );

      const bad = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/manifest/callback?code=code123&state=nope`,
        headers: { cookie },
      });
      expect(bad.statusCode).toBe(400);

      const done = await afe.app.inject({
        method: "GET",
        url: `/api/connections/github/manifest/callback?code=code123&state=${encodeURIComponent(state)}`,
        headers: { cookie },
      });
      expect(done.statusCode).toBe(200);
      expect(done.body).not.toContain("SECRET");
      expect(done.body).not.toContain("PRIVATE KEY");
      const { rows } = await pool.query("SELECT app_id, slug FROM github_apps");
      expect(rows).toEqual([{ app_id: "88", slug: "afe-self" }]);
      const creds = await pool.query("SELECT kind FROM credentials ORDER BY kind");
      expect(creds.rows.map((r) => r.kind)).toEqual([
        "github_app_client_secret",
        "github_app_private_key",
        "github_webhook_secret",
      ]);

      // The stored App is now used: install redirects to its slug, webhooks verify with its secret.
      const install = await afe.app.inject({
        method: "GET",
        url: "/api/connections/github/install",
      });
      expect(install.headers.location).toMatch(/^https:\/\/github\.com\/apps\/afe-self\//);
      const body = JSON.stringify({ zen: "x" });
      const ping = await afe.app.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-github-delivery": "p-1",
          "x-hub-signature-256": signHmac("sha256", "MANIFEST-WEBHOOK-SECRET", body, "sha256="),
        },
        payload: body,
      });
      expect(ping.statusCode).toBe(200);
      // Once an App exists the manifest flow is closed.
      const again = await afe.app.inject({
        method: "GET",
        url: "/api/connections/github/manifest",
      });
      expect(again.statusCode).toBe(409);
    });
  });

  describe("health probe", () => {
    it("ok for a live installation, revoked when uninstalled", async () => {
      await send("installation", installed());
      const conn = await only();
      const mod = createGitHubModule({
        app: appConfig,
        http: { fetch: api.fetch, sleep: async () => {} },
      });
      const hooks = mod.health!(afe.context);
      expect(await hooks.probe(conn)).toEqual({ ok: true });
      expect(await hooks.probe({ ...conn, externalId: "999" })).toMatchObject({
        ok: false,
        reason: "revoked",
      });
    });
  });
});
