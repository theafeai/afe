/**
 * API authentication and authorisation (AFE-27, ADR 0006).
 *
 * - Every `/api/*` request is authenticated in an `onRequest` hook, before
 *   routing to a handler: first by the `AuthProvider` (Bearer token, or
 *   whatever a hosted provider reads), then by Afe's signed session cookie
 *   (web UI). The hook sets `req.principal` and `req.tenantId` (from the
 *   `TenantResolver`); handlers read the tenant only via `requestTenant(req)`.
 * - Each route has an access level: `public`, `viewer` or `admin`. It is
 *   taken from the route's `config.access`, else from `defaultRouteAccess`
 *   (reads are `viewer`, everything else `admin`, a fixed list of reads that
 *   start flows or touch secrets is `admin`). Routes outside `/api/` are
 *   public (webhooks verify signatures, `/healthz`, the static UI). Unknown
 *   `/api/*` paths also require authentication, so 404s do not reveal routes.
 * - CSRF (cookie sessions only): mutating requests must send the session's
 *   CSRF token in `X-Afe-CSRF` (it is also in the readable `afe_csrf` cookie).
 *   In addition, any mutating `/api/*` request that carries an `Origin`
 *   header must come from Afe's own origin.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  constantTimeEqual,
  hasRole,
  type AuthProvider,
  type Principal,
  type TenantResolver,
} from "@afe/core";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_COOKIE_PATH,
  parseCookies,
  serializeCookie,
  sessionPrincipal,
  type SessionCodec,
} from "./session.ts";

export type RouteAccess = "public" | "viewer" | "admin";

declare module "fastify" {
  interface FastifyRequest {
    /** Authenticated caller of an `/api/*` request (set by the auth hook). */
    principal?: Principal;
    /** Tenant of the authenticated caller. Read it with `requestTenant(req)`. */
    tenantId?: string;
  }
  interface FastifyContextConfig {
    /** Access level of the route; defaults to `defaultRouteAccess(method, url)`. */
    access?: RouteAccess;
  }
}

export const SESSION_ROUTE = "/api/session";

/**
 * Reads that are admin-only: they start install/OAuth flows (and their
 * callbacks, which must come from the admin who started them), list a
 * source's projects for selection, or concern export signing keys.
 */
export const ADMIN_READ_ROUTES: ReadonlySet<string> = new Set([
  "/api/connections/github/install",
  "/api/connections/github/setup",
  "/api/connections/github/manifest",
  "/api/connections/github/manifest/callback",
  "/api/connections/vercel/install",
  "/api/connections/vercel/callback",
  "/api/connections/vercel/:id/projects",
  "/api/export/public-key",
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Access level of a route that does not set `config.access`. */
export function defaultRouteAccess(method: string, url: string): RouteAccess {
  if (url !== "/api" && !url.startsWith("/api/")) return "public";
  if (READ_METHODS.has(method.toUpperCase())) {
    return ADMIN_READ_ROUTES.has(url) ? "admin" : "viewer";
  }
  return "admin";
}

export interface RegisteredRoute {
  method: string;
  url: string;
  access: RouteAccess;
}

/** The tenant of the authenticated request. Throws (401) if the auth hook did not run. */
export function requestTenant(req: FastifyRequest): string {
  if (!req.tenantId || !req.principal) {
    throw Object.assign(new Error("authentication required"), { statusCode: 401 });
  }
  return req.tenantId;
}

export interface AuthOptions {
  provider: AuthProvider;
  tenantResolver: TenantResolver;
  sessions: SessionCodec;
  /** AFE_PUBLIC_URL: origin check and Secure cookies. */
  publicUrl?: string;
  /** When the web UI is served, unauthenticated browser navigations go to `/login`. */
  uiEnabled: boolean;
}

function isMutating(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase());
}

function headerString(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** True when an `Origin` header names a different origin than this Afe. */
function foreignOrigin(req: FastifyRequest, publicUrl: string | undefined): boolean {
  const origin = headerString(req.headers.origin);
  if (origin === undefined) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return true; // includes "null" (sandboxed/opaque origins)
  }
  if (publicUrl) return o.origin !== new URL(publicUrl).origin;
  return o.host !== headerString(req.headers.host);
}

function wantsHtml(req: FastifyRequest): boolean {
  return String(req.headers.accept ?? "").includes("text/html");
}

function secureCookies(req: FastifyRequest, publicUrl: string | undefined): boolean {
  return Boolean(publicUrl?.startsWith("https://")) || req.protocol === "https";
}

/**
 * Installs the access policy and the auth hook, and the session routes.
 * Must run before any route is registered. Returns the live list of
 * registered routes (with their access level), e.g. for tests.
 */
export function registerAuth(app: FastifyInstance, options: AuthOptions): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  const { provider, tenantResolver, sessions, publicUrl } = options;

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const url = route.url ?? route.path;
    const explicit = route.config?.access;
    // One access level per route; HEAD inherits from its GET.
    const access = explicit ?? defaultRouteAccess(methods[0] ?? "GET", url);
    route.config = { ...route.config, access };
    for (const method of methods) routes.push({ method, url, access });
  });

  const unauthenticated = (req: FastifyRequest, reply: FastifyReply) => {
    if (options.uiEnabled && req.method === "GET" && wantsHtml(req)) {
      // A browser following a link or an install/OAuth redirect: log in, then come back.
      const next = encodeURIComponent(req.url);
      return reply.redirect(`${publicUrl ?? ""}/login?next=${next}`, 303);
    }
    return reply
      .code(401)
      .header("www-authenticate", 'Bearer realm="afe"')
      .send({ error: "unauthorized", message: "Authentication required." });
  };

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    const routeUrl = req.routeOptions.url;
    const access: RouteAccess =
      routeUrl !== undefined
        ? (req.routeOptions.config.access ?? defaultRouteAccess(req.method, routeUrl))
        : defaultRouteAccess(req.method, path);
    if (path.startsWith("/api/") && isMutating(req.method) && foreignOrigin(req, publicUrl)) {
      req.log.warn(
        { origin: headerString(req.headers.origin)?.slice(0, 200) },
        "cross-origin API request rejected",
      );
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Cross-origin request rejected." });
    }
    if (access === "public") return;

    const cookies = parseCookies(req.headers.cookie);
    let principal = await provider.authenticate({ headers: req.headers, cookies });
    if (!principal && !req.headers.authorization) {
      const session = sessions.verify(cookies[SESSION_COOKIE]);
      if (session) {
        const p = sessionPrincipal(session);
        const active = provider.isActive
          ? await provider.isActive({ ...p, id: session.sub, kind: session.via })
          : true;
        if (active) {
          if (isMutating(req.method)) {
            const sent = headerString(req.headers[CSRF_HEADER]);
            if (!sent || !constantTimeEqual(sent, session.csrf)) {
              req.log.warn("csrf token missing or wrong");
              return reply
                .code(403)
                .send({ error: "csrf_failed", message: "Missing or invalid CSRF token." });
            }
          }
          principal = p;
        }
      }
    }
    if (!principal) return unauthenticated(req, reply);

    let tenantId: string;
    try {
      tenantId = await tenantResolver.resolveTenant({ headers: req.headers, principal });
    } catch {
      return reply.code(403).send({ error: "forbidden", message: "No tenant for this principal." });
    }
    if (access === "admin" && !hasRole(principal, "admin")) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "This action requires the admin role." });
    }
    if (access === "viewer" && !hasRole(principal, "viewer")) {
      return reply.code(403).send({ error: "forbidden", message: "Not allowed." });
    }
    req.principal = principal;
    req.tenantId = tenantId;
  });

  // --- Web UI sessions ------------------------------------------------------

  const cookieHeaders = (req: FastifyRequest, value: { session: string; csrf: string } | null) => {
    const secure = secureCookies(req, publicUrl);
    const maxAgeSec = value ? Math.floor(sessions.ttlMs / 1000) : 0;
    return [
      serializeCookie(SESSION_COOKIE, value?.session ?? "", {
        path: SESSION_COOKIE_PATH,
        maxAgeSec,
        httpOnly: true,
        secure,
      }),
      // Readable by the UI's JavaScript (double-submit CSRF token); worthless without the session.
      serializeCookie(CSRF_COOKIE, value?.csrf ?? "", {
        path: "/",
        maxAgeSec,
        httpOnly: false,
        secure,
      }),
    ];
  };

  const principalView = (p: Principal) => ({
    id: p.id,
    tenantId: p.tenantId,
    roles: p.roles,
    kind: p.kind,
    name: p.name ?? null,
  });

  // Log in with a token: exchanges it for a session cookie.
  app.post<{ Body: { token?: unknown } }>(
    SESSION_ROUTE,
    { config: { access: "public" }, bodyLimit: 4096 },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const token = req.body?.token;
      if (typeof token !== "string" || token.length === 0 || token.length > 1024) {
        return reply.code(400).send({ error: "invalid_token", message: "Enter an access token." });
      }
      const principal = await provider.authenticate({
        headers: { authorization: `Bearer ${token}` },
        cookies: {},
      });
      if (!principal) {
        req.log.warn("login rejected");
        return reply.code(401).send({ error: "invalid_token", message: "The token is not valid." });
      }
      const issued = sessions.issue(principal);
      req.log.info({ principal: principal.id, tenantId: principal.tenantId }, "session started");
      return reply
        .code(201)
        .header(
          "set-cookie",
          cookieHeaders(req, { session: issued.cookie, csrf: issued.payload.csrf }),
        )
        .send({
          principal: principalView(sessionPrincipal(issued.payload)),
          csrfToken: issued.payload.csrf,
          expiresAt: new Date(issued.payload.exp).toISOString(),
        });
    },
  );

  // Who am I (also tells the UI whether it is logged in).
  app.get(SESSION_ROUTE, { config: { access: "viewer" } }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const cookies = parseCookies(req.headers.cookie);
    const session =
      req.principal?.kind === "session" ? sessions.verify(cookies[SESSION_COOKIE]) : null;
    return {
      principal: principalView(req.principal!),
      csrfToken: session?.csrf ?? null,
      expiresAt: session ? new Date(session.exp).toISOString() : null,
    };
  });

  // Log out: clears the cookies. Sessions are stateless; see ADR 0006 for revocation.
  app.delete(SESSION_ROUTE, { config: { access: "public" } }, async (req, reply) => {
    return reply
      .code(200)
      .header("cache-control", "no-store")
      .header("set-cookie", cookieHeaders(req, null))
      .send({ ok: true });
  });

  return routes;
}
