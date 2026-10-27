import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { LightMyRequestResponse } from "fastify";
import type { AuthProvider, CanonicalEventInputLike } from "@afe/core";
import { EnvKeyProvider } from "@afe/core/security";
import { getConnection, ingestEvent, upsertConnection } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, defaultModules, loadConfig, type AfeApp } from "../src/index.ts";
import { ADMIN_READ_ROUTES, defaultRouteAccess } from "../src/auth/index.ts";
import { ensureAdminToken, isLoopbackHost, StartupAuthError } from "../src/auth/startup.ts";
import { tokenMapAuth } from "./helpers/auth.ts";

const ADMIN_TOKEN = `adm_${"a1".repeat(20)}`;
const VIEWER_TOKEN = `view_${"b2".repeat(20)}`;
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });

function event(n: number): CanonicalEventInputLike {
  return {
    source: "github",
    sourceEventId: `auth:${n}`,
    action: "deployment.created",
    actor: { type: "user", id: "1", login: "octocat" },
    target: { type: "environment", id: "acme/api:production", environment: "production" },
    trigger: { type: "manual" },
    outcome: "succeeded",
    occurredAt: new Date(Date.UTC(2026, 9, 1, 10, n)),
    observedAt: new Date(Date.UTC(2026, 9, 1, 10, n, 30)),
    observation: { method: "webhook", deliveryId: `auth-d-${n}` },
    correlation: {},
    rawPayload: { contentType: "application/json", body: `{"n":${n}}` },
  };
}

/** `Cookie` header value from a response's Set-Cookie headers. */
function cookiesOf(res: LightMyRequestResponse): string {
  const set = res.headers["set-cookie"];
  const list = Array.isArray(set) ? set : set ? [String(set)] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

function setCookie(res: LightMyRequestResponse, name: string): string {
  const set = res.headers["set-cookie"];
  const list = Array.isArray(set) ? set : set ? [String(set)] : [];
  return list.find((c) => c.startsWith(`${name}=`)) ?? "";
}

describe("API authentication (AFE-27)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let now = Date.UTC(2026, 9, 27, 12);
  let webDir: string;

  async function build(
    env: Record<string, string> = {},
    extra: { authProvider?: AuthProvider; webDir?: string } = {},
  ) {
    return buildAfe({
      pool,
      keys,
      logLevel: "silent",
      config: loadConfig({
        DATABASE_URL: "unused",
        AFE_ADMIN_TOKEN: ADMIN_TOKEN,
        AFE_VIEWER_TOKEN: VIEWER_TOKEN,
        ...env,
      }),
      connectors: defaultModules,
      clock: () => now,
      ...extra,
    });
  }

  beforeAll(async () => {
    pool = await createTestPool();
    webDir = await mkdtemp(path.join(tmpdir(), "afe-auth-web-"));
    await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>Afe</title>");
    afe = await build({}, { webDir });
  });
  afterAll(async () => {
    await afe.app.close();
    await pool.end();
    await rm(webDir, { recursive: true, force: true });
  });

  const fill = (url: string, id: string = randomUUID()) => url.replace(/:[A-Za-z]+/g, id);
  const apiRoutes = () => afe.routes.filter((r) => r.url.startsWith("/api/"));
  const call = (method: string, url: string, headers: Record<string, string> = {}) =>
    afe.app.inject({
      method: method as "GET",
      url,
      headers: {
        ...(["POST", "PUT", "PATCH", "DELETE"].includes(method)
          ? { "content-type": "application/json" }
          : {}),
        ...headers,
      },
      ...(["POST", "PUT", "PATCH"].includes(method) ? { payload: "{}" } : {}),
    });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  describe("route policy", () => {
    it("registers many /api routes, and only login/logout are public", () => {
      expect(apiRoutes().length).toBeGreaterThan(20);
      const pub = apiRoutes()
        .filter((r) => r.access === "public")
        .map((r) => `${r.method} ${r.url}`);
      expect(pub.sort()).toEqual(["DELETE /api/session", "POST /api/session"]);
      // Webhooks, /healthz and the UI stay public.
      for (const r of afe.routes.filter((r) => !r.url.startsWith("/api/"))) {
        expect(r.access, `${r.method} ${r.url}`).toBe("public");
      }
      expect(afe.routes.some((r) => r.url === "/webhooks/github")).toBe(true);
    });

    it("classifies reads as viewer, writes and flow/key routes as admin", () => {
      expect(defaultRouteAccess("GET", "/api/events")).toBe("viewer");
      expect(defaultRouteAccess("POST", "/api/connections/argocd")).toBe("admin");
      expect(defaultRouteAccess("DELETE", "/api/connections/vercel/:id")).toBe("admin");
      expect(defaultRouteAccess("GET", "/api/connections/github/install")).toBe("admin");
      expect(defaultRouteAccess("POST", "/webhooks/github")).toBe("public");
      expect(defaultRouteAccess("GET", "/healthz")).toBe("public");
      // Every listed admin read exists, so a renamed route cannot silently become viewer.
      for (const url of ADMIN_READ_ROUTES) {
        const r = afe.routes.find((x) => x.url === url && x.method === "GET");
        expect(r?.access, url).toBe("admin");
      }
    });
  });

  describe("unauthenticated", () => {
    it("every /api route answers 401 (enumerated from the registered routes)", async () => {
      for (const r of apiRoutes().filter((r) => r.access !== "public")) {
        const res = await call(r.method, fill(r.url));
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
        if (r.method !== "HEAD") expect(res.json()).toMatchObject({ error: "unauthorized" });
      }
    });

    it("rejects wrong, malformed and cookie-smuggled credentials", async () => {
      for (const headers of <Record<string, string>[]>[
        bearer("nope"),
        bearer(`${ADMIN_TOKEN}x`),
        bearer(ADMIN_TOKEN.slice(0, -1)),
        { authorization: ADMIN_TOKEN },
        { authorization: `Basic ${Buffer.from(`x:${ADMIN_TOKEN}`).toString("base64")}` },
        { cookie: `afe_session=${ADMIN_TOKEN}` },
        { "x-afe-tenant": "default" },
      ]) {
        expect((await call("GET", "/api/events", headers)).statusCode).toBe(401);
      }
      expect((await call("GET", "/api/does-not-exist")).statusCode).toBe(401);
    });

    it("sends a browser navigation to the login page and back", async () => {
      const url = "/api/connections/github/setup?installation_id=1&state=x";
      const res = await call("GET", url, { accept: "text/html" });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
      // The login page itself is the SPA.
      expect((await call("GET", "/login", { accept: "text/html" })).statusCode).toBe(200);
    });

    it("keeps webhooks, /healthz and the UI public", async () => {
      expect((await call("GET", "/healthz")).statusCode).toBe(200);
      expect((await call("GET", "/")).statusCode).toBe(200);
      expect((await call("GET", "/events")).statusCode).toBe(200);
      // Webhooks reach their handler (which verifies signatures), not the auth hook.
      const gh = await call("POST", "/webhooks/github");
      expect(gh.json()).toEqual({ error: "GitHub App is not configured" });
      const vc = await call("POST", "/webhooks/vercel");
      expect(vc.json()).toEqual({ error: "vercel_integration_not_configured" });
      expect(gh.headers["www-authenticate"]).toBeUndefined();
    });
  });

  describe("roles", () => {
    it("the admin token reaches every /api route", async () => {
      for (const r of apiRoutes().filter((r) => r.access !== "public")) {
        const res = await call(r.method, fill(r.url), bearer(ADMIN_TOKEN));
        expect([401, 403], `${r.method} ${r.url}: ${res.statusCode}`).not.toContain(res.statusCode);
      }
    });

    it("the viewer token can read but not change anything", async () => {
      for (const r of apiRoutes().filter((r) => r.access !== "public")) {
        const res = await call(r.method, fill(r.url), bearer(VIEWER_TOKEN));
        if (r.access === "admin") {
          expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
        } else {
          expect([401, 403], `${r.method} ${r.url}`).not.toContain(res.statusCode);
        }
      }
      expect((await call("GET", "/api/events", bearer(VIEWER_TOKEN))).statusCode).toBe(200);
      const create = await call("POST", "/api/connections/argocd", bearer(VIEWER_TOKEN));
      expect(create.json()).toMatchObject({ error: "forbidden" });
    });

    it("tells the caller who it is", async () => {
      const res = await call("GET", "/api/session", bearer(VIEWER_TOKEN));
      expect(res.json().principal).toMatchObject({
        tenantId: "default",
        roles: ["viewer"],
        kind: "token",
      });
      expect(JSON.stringify(res.json())).not.toContain(VIEWER_TOKEN);
    });
  });

  describe("web UI sessions", () => {
    async function login(token = ADMIN_TOKEN) {
      return afe.app.inject({
        method: "POST",
        url: "/api/session",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token }),
      });
    }

    it("logs in with a token and sets hardened cookies", async () => {
      expect((await login("wrong")).statusCode).toBe(401);
      const res = await login();
      expect(res.statusCode).toBe(201);
      const session = setCookie(res, "afe_session");
      expect(session).toMatch(/; Path=\/api; Max-Age=43200; HttpOnly; SameSite=Lax$/);
      expect(session).not.toContain(ADMIN_TOKEN);
      const csrf = setCookie(res, "afe_csrf");
      expect(csrf).toMatch(/; Path=\/; Max-Age=43200; SameSite=Lax$/);
      expect(csrf).not.toContain("HttpOnly");
      expect(res.json()).toMatchObject({
        principal: { tenantId: "default", roles: ["admin"], kind: "session" },
      });
      expect(res.json().csrfToken).toBe(csrf.split(";")[0]!.split("=")[1]);

      const cookie = cookiesOf(res);
      expect((await call("GET", "/api/events", { cookie })).statusCode).toBe(200);
      const me = await call("GET", "/api/session", { cookie });
      expect(me.json()).toMatchObject({ csrfToken: res.json().csrfToken });
    });

    it("sets Secure cookies when the public URL is https", async () => {
      const https = await build({ AFE_PUBLIC_URL: "https://afe.example.com" });
      const res = await https.app.inject({
        method: "POST",
        url: "/api/session",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: ADMIN_TOKEN }),
      });
      expect(setCookie(res, "afe_session")).toMatch(/; Secure$/);
      expect(setCookie(res, "afe_csrf")).toMatch(/; Secure$/);
      await https.app.close();
    });

    it("requires the CSRF token on mutating requests made with the cookie", async () => {
      const res = await login();
      const cookie = cookiesOf(res);
      const csrfToken = res.json().csrfToken as string;
      const noHeader = await call("POST", "/api/connections/argocd", { cookie });
      expect(noHeader.statusCode).toBe(403);
      expect(noHeader.json()).toMatchObject({ error: "csrf_failed" });
      const wrong = await call("DELETE", fill("/api/connections/argocd/:id"), {
        cookie,
        "x-afe-csrf": `${csrfToken.slice(0, -2)}xx`,
      });
      expect(wrong.statusCode).toBe(403);
      // A token from another session does not work either.
      const other = (await login()).json().csrfToken as string;
      expect(
        (await call("POST", "/api/connections/argocd", { cookie, "x-afe-csrf": other })).statusCode,
      ).toBe(403);
      // With the header the request reaches the handler (which validates the body).
      const ok = await call("POST", "/api/connections/argocd", { cookie, "x-afe-csrf": csrfToken });
      expect(ok.statusCode).toBe(400);
      // Reads need no CSRF token; bearer clients need none.
      expect((await call("GET", "/api/connections", { cookie })).statusCode).toBe(200);
      expect((await call("POST", "/api/connections/argocd", bearer(ADMIN_TOKEN))).statusCode).toBe(
        400,
      );
    });

    it("rejects cross-origin mutating requests", async () => {
      const res = await call("POST", "/api/connections/argocd", {
        ...bearer(ADMIN_TOKEN),
        origin: "https://evil.example",
        host: "localhost:80",
      });
      expect(res.statusCode).toBe(403);
      const login = await afe.app.inject({
        method: "POST",
        url: "/api/session",
        headers: { "content-type": "application/json", origin: "null" },
        payload: JSON.stringify({ token: ADMIN_TOKEN }),
      });
      expect(login.statusCode).toBe(403);
      const same = await call("POST", "/api/connections/argocd", {
        ...bearer(ADMIN_TOKEN),
        origin: "http://localhost:80",
        host: "localhost:80",
      });
      expect(same.statusCode).toBe(400);
    });

    it("rejects tampered, expired and logged-out sessions", async () => {
      const res = await login(VIEWER_TOKEN);
      const value = setCookie(res, "afe_session").split(";")[0]!.slice("afe_session=".length);
      const [v, payload, sig] = value.split(".");
      const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
      const escalated = Buffer.from(JSON.stringify({ ...decoded, roles: ["admin"] })).toString(
        "base64url",
      );
      for (const forged of [
        `${v}.${escalated}.${sig}`,
        `${v}.${payload}.${sig!.slice(0, -2)}AA`,
        `${v}.${payload}`,
        "garbage",
      ]) {
        expect(
          (await call("GET", "/api/events", { cookie: `afe_session=${forged}` })).statusCode,
        ).toBe(401);
      }
      const cookie = cookiesOf(res);
      expect((await call("GET", "/api/events", { cookie })).statusCode).toBe(200);
      // Viewer sessions stay viewers.
      expect(
        (
          await call("POST", "/api/connections/argocd", {
            cookie,
            "x-afe-csrf": res.json().csrfToken,
          })
        ).statusCode,
      ).toBe(403);

      const logout = await call("DELETE", "/api/session", { cookie });
      expect(logout.statusCode).toBe(200);
      expect(setCookie(logout, "afe_session")).toMatch(/^afe_session=; Path=\/api; Max-Age=0/);
      expect(setCookie(logout, "afe_csrf")).toMatch(/^afe_csrf=; Path=\/; Max-Age=0/);

      const saved = now;
      now += 12 * 3600_000 + 1;
      expect((await call("GET", "/api/events", { cookie })).statusCode).toBe(401);
      now = saved;
    });

    it("rotating the token ends existing sessions", async () => {
      const cookie = cookiesOf(await login());
      const rotated = await build({ AFE_ADMIN_TOKEN: `${ADMIN_TOKEN}-rotated` });
      const res = await rotated.app.inject({
        method: "GET",
        url: "/api/events",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(401);
      // Even with a fixed AFE_SESSION_SECRET, the old token's principal is no longer active.
      const secret = "s".repeat(40);
      const a = await build({ AFE_SESSION_SECRET: secret });
      const b = await build({ AFE_SESSION_SECRET: secret, AFE_ADMIN_TOKEN: `${ADMIN_TOKEN}-2` });
      const sa = await a.app.inject({
        method: "POST",
        url: "/api/session",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: ADMIN_TOKEN }),
      });
      const c = cookiesOf(sa);
      expect(
        (await a.app.inject({ method: "GET", url: "/api/events", headers: { cookie: c } }))
          .statusCode,
      ).toBe(200);
      expect(
        (await b.app.inject({ method: "GET", url: "/api/events", headers: { cookie: c } }))
          .statusCode,
      ).toBe(401);
      await Promise.all([rotated.app.close(), a.app.close(), b.app.close()]);
    });
  });

  describe("tenant isolation (R9)", () => {
    let mt: AfeApp;
    const ids: Record<string, string> = {};
    const A = bearer("tenant-a-token");
    const B = bearer("tenant-b-token");

    beforeAll(async () => {
      await pool.query(
        "INSERT INTO tenants (id, name) VALUES ('other', 'Other') ON CONFLICT DO NOTHING",
      );
      const ev = await ingestEvent(pool, "default", event(1));
      ids.event = ev.event!.id;
      ids.argocd = (
        await upsertConnection(pool, "default", {
          source: "argocd",
          externalId: "https://argocd.example.com",
          name: "argo",
          status: "active",
          config: { serverUrl: "https://argocd.example.com" },
        })
      ).id;
      ids.vercel = (
        await upsertConnection(pool, "default", {
          source: "vercel",
          externalId: "team_1",
          name: "acme",
          status: "active",
          config: { mode: "token", teamId: "team_1", userId: "u1", configurationId: null },
        })
      ).id;
      ids.github = (
        await upsertConnection(pool, "default", {
          source: "github",
          externalId: "4242",
          name: "acme",
          status: "active",
          config: {},
        })
      ).id;
      mt = await build(
        {},
        {
          authProvider: tokenMapAuth({
            "tenant-a-token": { tenantId: "default", roles: ["admin"] },
            "tenant-b-token": { tenantId: "other", roles: ["admin"] },
          }),
        },
      );
    });
    afterAll(async () => {
      await mt.app.close();
    });

    const idFor = (url: string) =>
      url.startsWith("/api/events/")
        ? ids.event!
        : url.startsWith("/api/connections/argocd/")
          ? ids.argocd!
          : url.startsWith("/api/connections/vercel/")
            ? ids.vercel!
            : ids.github!;

    const inject = (method: string, url: string, headers: Record<string, string>) =>
      mt.app.inject({
        method: method as "GET",
        url,
        headers: {
          ...(["POST", "PUT", "DELETE"].includes(method)
            ? { "content-type": "application/json" }
            : {}),
          ...headers,
        },
        ...(["POST", "PUT"].includes(method) ? { payload: '{"projects":"all"}' } : {}),
      });

    it("every route with an id answers 404 for another tenant's resource", async () => {
      const byId = mt.routes.filter((r) => r.url.startsWith("/api/") && r.url.includes("/:"));
      expect(byId.length).toBeGreaterThanOrEqual(8);
      for (const r of byId) {
        const res = await inject(r.method, fill(r.url, idFor(r.url)), B);
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      }
      // Nothing of tenant A was changed by tenant B's deletes.
      for (const id of [ids.argocd!, ids.vercel!]) {
        expect((await getConnection(pool, "default", id))?.status).toBe("active");
      }
      // The owner sees them.
      for (const url of ["/api/events/:id", "/api/events/:id/raw", "/api/connections/:id/health"]) {
        const res = await inject("GET", fill(url, idFor(url)), A);
        expect(res.statusCode, url).toBe(200);
      }
    });

    it("lists only the caller's tenant", async () => {
      const lists = [
        "/api/events",
        "/api/deployments",
        "/api/connections",
        "/api/connections/argocd",
      ];
      for (const url of lists) {
        const b = await inject("GET", url, B);
        expect(b.statusCode, url).toBe(200);
        for (const id of Object.values(ids)) expect(b.body, url).not.toContain(id);
      }
      const a = await inject("GET", "/api/connections", A);
      expect(a.body).toContain(ids.argocd);
      expect((await inject("GET", "/api/events", A)).body).toContain(ids.event);
    });
  });
});

describe("startup safety", () => {
  const cfg = (env: Record<string, string>) => loadConfig({ DATABASE_URL: "unused", ...env });

  it("refuses to start without an admin token unless bound to loopback", () => {
    expect(() => ensureAdminToken(cfg({}))).toThrow(StartupAuthError); // default 0.0.0.0
    expect(() => ensureAdminToken(cfg({ AFE_HOST: "10.0.0.5" }))).toThrow(/AFE_ADMIN_TOKEN/);
    expect(() => ensureAdminToken(cfg({ AFE_HOST: "::" }))).toThrow(StartupAuthError);
  });

  it("on loopback generates a one-time token, printed once", () => {
    const lines: string[] = [];
    const config = cfg({ AFE_HOST: "127.0.0.1" });
    const token = ensureAdminToken(config, (l) => lines.push(l));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(config.auth?.adminToken?.reveal()).toBe(token);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(token);
  });

  it("keeps a configured token", () => {
    const print = (l: string) => {
      throw new Error(`printed ${l}`);
    };
    expect(ensureAdminToken(cfg({ AFE_ADMIN_TOKEN: ADMIN_TOKEN }), print)).toBeNull();
  });

  it("validates the auth settings", async () => {
    expect(() => cfg({ AFE_VIEWER_TOKEN: VIEWER_TOKEN })).toThrow(/requires AFE_ADMIN_TOKEN/);
    expect(() => cfg({ AFE_ADMIN_TOKEN: ADMIN_TOKEN, AFE_SESSION_SECRET: "short" })).toThrow(
      /AFE_SESSION_SECRET/,
    );
    expect(() => cfg({ AFE_SESSION_TTL: "10s" })).toThrow(/AFE_SESSION_TTL/);
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    await expect(
      buildAfe({
        pool,
        logLevel: "silent",
        config: cfg({ AFE_ADMIN_TOKEN: "too-short" }),
      }),
    ).rejects.toThrow(/at least 32 characters/);
    await expect(
      buildAfe({
        pool,
        logLevel: "silent",
        config: cfg({ AFE_ADMIN_TOKEN: ADMIN_TOKEN, AFE_VIEWER_TOKEN: ADMIN_TOKEN }),
      }),
    ).rejects.toThrow(/must differ/);
  });

  it("without any token configured, every /api request is rejected", async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const { app } = await buildAfe({
      pool,
      logLevel: "silent",
      config: cfg({}),
    });
    expect((await app.inject({ method: "GET", url: "/api/session" })).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    expect(login.statusCode).toBe(401);
    await app.close();
  });

  it("recognises loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of [
      "0.0.0.0",
      "::",
      "10.0.0.1",
      "192.168.1.1",
      "example.com",
      "::ffff:10.0.0.1",
    ]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});
