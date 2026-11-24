/**
 * Sign in with GitHub (ADR 0020).
 *
 * Uses the existing personal-linking OAuth app (AFE_USER_GITHUB_CLIENT_ID/SECRET).
 *
 * - Off by default (`github_sign_in.enabled`). Only for Afe's own local
 *   authentication; a hosted build with its own AuthProvider/TenantResolver must
 *   supply a tenant mapping from the verified installation instead.
 * - Users are matched by the numeric GitHub id only (`user_external_identities`),
 *   never by login or email.
 * - Auto-provisioning is a separate opt-in (off by default) and needs at least one
 *   allowed organization. Allowed organizations must have an active installation
 *   of this tenant's own GitHub App; membership is proven with
 *   `/user/memberships/orgs/{org}` (`state: active`), never `/user/orgs`.
 *   New users are managed (viewer) users with GitHub in Source mode and nothing else.
 * - Login CSRF: the single-use `state` (stored as a digest, ten minutes) is bound to
 *   a random pre-login cookie set when the flow starts. The redirect URI is fixed,
 *   `next` is limited to same-origin relative paths, responses carry
 *   `referrer-policy: no-referrer`, and start and callback are rate limited per
 *   client address (`@fastify/rate-limit`, see rate-limit.ts). The administrator
 *   settings routes are rate limited per principal. `code`, `state` and tokens
 *   are never logged.
 * - Offboarding: sessions from this flow stay valid only while the user is
 *   enabled and still linked (`isActive`); membership is re-checked at every
 *   sign-in and on each access-cache refresh (permissions.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_TENANT_ID, type Principal } from "@afe/core";
import { Secret } from "@afe/core/security";
import { exchangeUserCode, GitHubHttp } from "@afe/connector-github";
import {
  bindExternalIdentity,
  consumeGitHubSignInState,
  createGitHubSignInState,
  createLocalUser,
  getExternalIdentityBySubject,
  getGitHubSignInSettings,
  getLocalUser,
  getUserToolPolicy,
  githubSubject,
  putGitHubSignInSettings,
  setLocalUserDisabled,
  setUserToolPolicy,
} from "@afe/db";
import type { ServerContext } from "../context.ts";
import { readSecretEnv } from "../config.ts";
import { requestTenant, secureCookies, sessionCookieHeaders } from "./index.ts";
import { GITHUB_SIGN_IN_KIND } from "./local-users.ts";
import {
  activeInstallationOrgs,
  allowedOrgMembership,
  normalizeOrgLogin,
} from "./github-membership.ts";
import { parseCookies, serializeCookie, type SessionCodec } from "./session.ts";
import { IdentityConflictError, saveAccount } from "./tool-accounts.ts";
import { onRateLimited, perAddress, perPrincipal, rateLimitedJson } from "../rate-limit.ts";

export const GITHUB_SIGN_IN_ROUTES = {
  available: "/api/login/github/available",
  start: "/api/login/github",
  callback: "/api/login/github/callback",
  settings: "/api/admin/github-sign-in",
} as const;
/** Pre-login browser binding cookie; only sent to the sign-in routes. */
export const LOGIN_COOKIE = "afe_github_login";
const LOGIN_COOKIE_PATH = "/api/login/github";
const STATE_TTL_SECONDS = 600;
/**
 * `repo` and `read:user` as for personal linking (the account is linked in Source
 * mode in the same step); `read:org` so the membership endpoint can prove active
 * membership. Replacing the stored `repo` token with a write-capable GitHub App
 * is required before a public or hosted launch (ADR 0020, launch blocker).
 */
export const GITHUB_SIGN_IN_SCOPE = "repo read:user read:org";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** A same-origin relative path, else "/". Never an absolute, protocol-relative or API URL. */
export function safeNextPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 512 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\\]/.test(value)
  )
    return "/";
  try {
    const u = new URL(value, "http://afe.invalid");
    if (u.origin !== "http://afe.invalid" || u.pathname.startsWith("/api/")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

function oauthConfig() {
  const clientId = process.env.AFE_USER_GITHUB_CLIENT_ID;
  const secret = readSecretEnv(process.env, "AFE_USER_GITHUB_CLIENT_SECRET");
  return clientId && secret ? { clientId, clientSecret: new Secret(secret) } : null;
}

export interface GitHubSignInOptions {
  sessions: SessionCodec;
  /** True only for Afe's own local authentication (single tenant). */
  localAuth: boolean;
}

type FailCode =
  | "unavailable"
  | "rate_limited"
  | "invalid_state"
  | "failed"
  | "not_linked"
  | "not_member"
  | "disabled"
  | "github_disabled"
  | "identity_in_use";

export function registerGitHubSignIn(
  app: FastifyInstance,
  ctx: ServerContext,
  options: GitHubSignInOptions,
) {
  const { sessions } = options;
  const publicUrl = ctx.config.publicUrl;
  const tenantId = DEFAULT_TENANT_ID;
  // Sign-in attempts: 20 per client address per 15 minutes for each of start and
  // callback. Settings: generous for an administrator, bounded for a script.
  const startLimit = perAddress(tenantId, 20, 15 * 60_000);
  const callbackLimit = perAddress(tenantId, 20, 15 * 60_000);
  const settingsReadLimit = perPrincipal(60, 60_000);
  const settingsWriteLimit = perPrincipal(20, 60_000);

  const available = async () => {
    if (!options.localAuth || !publicUrl || !oauthConfig()) return false;
    try {
      return (await getGitHubSignInSettings(ctx.pool, tenantId)).enabled;
    } catch {
      return false;
    }
  };
  const loginCookie = (req: FastifyRequest, value: string | null) =>
    serializeCookie(LOGIN_COOKIE, value ?? "", {
      path: LOGIN_COOKIE_PATH,
      maxAgeSec: value ? STATE_TTL_SECONDS : 0,
      httpOnly: true,
      secure: secureCookies(req, publicUrl),
    });
  const hardened = (reply: FastifyReply) =>
    reply.header("referrer-policy", "no-referrer").header("cache-control", "no-store");

  app.get(
    GITHUB_SIGN_IN_ROUTES.available,
    { config: { access: "public" } },
    async (_req, reply) => {
      hardened(reply);
      return { available: await available() };
    },
  );

  app.post<{ Body: { next?: unknown } }>(
    GITHUB_SIGN_IN_ROUTES.start,
    {
      config: { access: "public", rateLimit: startLimit },
      bodyLimit: 4096,
      errorHandler: onRateLimited((_req, reply) =>
        hardened(reply).code(429).send({ error: "rate_limited" }),
      ),
    },
    async (req, reply) => {
      hardened(reply);
      const config = oauthConfig();
      if (!config || !(await available()))
        return reply.code(409).send({
          error: "github_sign_in_unavailable",
          message: "Sign in with GitHub is not enabled.",
        });
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      await createGitHubSignInState(ctx.pool, tenantId, {
        digest: digest(state),
        browserBinding: digest(nonce),
        nextPath: safeNextPath(req.body?.next),
        ttlSeconds: STATE_TTL_SECONDS,
      });
      const u = new URL("https://github.com/login/oauth/authorize");
      u.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${publicUrl}${GITHUB_SIGN_IN_ROUTES.callback}`,
        scope: GITHUB_SIGN_IN_SCOPE,
        state,
        allow_signup: "false",
      }).toString();
      return reply.header("set-cookie", loginCookie(req, nonce)).send({ url: u.toString() });
    },
  );

  const failRedirect = (req: FastifyRequest, reply: FastifyReply, code: FailCode) =>
    hardened(reply)
      .header("set-cookie", loginCookie(req, null))
      .redirect(`/login?github_error=${code}`, 303);

  app.get<{ Querystring: { state?: unknown; code?: unknown } }>(
    GITHUB_SIGN_IN_ROUTES.callback,
    {
      config: { access: "public", rateLimit: callbackLimit },
      errorHandler: onRateLimited((req, reply) => failRedirect(req, reply, "rate_limited")),
    },
    async (req, reply) => {
      hardened(reply);
      const fail = (code: FailCode) => failRedirect(req, reply, code);
      const config = oauthConfig();
      if (!config || !(await available())) return fail("unavailable");
      const { state, code } = req.query;
      const nonce = parseCookies(req.headers.cookie)[LOGIN_COOKIE];
      if (
        typeof state !== "string" ||
        state.length > 200 ||
        typeof code !== "string" ||
        code.length > 1024 ||
        !nonce ||
        nonce.length > 200
      )
        return fail("invalid_state");
      const next = await consumeGitHubSignInState(ctx.pool, tenantId, digest(state), digest(nonce));
      if (!next) return fail("invalid_state");

      let token: Secret<string>, subject: string, login: string;
      try {
        token = await exchangeUserCode(config, code);
        const user = await new GitHubHttp({ maxRetries: 0 }).request<{
          id?: unknown;
          login?: unknown;
        }>({ method: "GET", path: "/user", token, bucket: `sign-in:${tenantId}` });
        const s = githubSubject(user.data?.id);
        if (!s || typeof user.data.login !== "string" || !user.data.login)
          throw new Error("invalid identity");
        subject = s;
        login = user.data.login.slice(0, 100);
      } catch {
        return fail("failed");
      }

      const settings = await getGitHubSignInSettings(ctx.pool, tenantId);
      const membership = settings.allowedOrgs.length
        ? (
            await allowedOrgMembership(
              ctx.pool,
              tenantId,
              settings.allowedOrgs,
              token,
              `sign-in:${tenantId}`,
            )
          ).membership
        : null;
      const identity = await getExternalIdentityBySubject(ctx.pool, tenantId, "github", subject);
      let userId: string;
      if (identity) {
        // Administrator storage accounts (ADR 0012) hold personal GitHub access for
        // an administrator principal; they are never Afe logins.
        const adminStorage = await ctx.pool.query(
          "SELECT 1 FROM github_admin_identities WHERE tenant_id=$1 AND user_id=$2",
          [tenantId, identity.userId],
        );
        if (adminStorage.rowCount) return fail("not_linked");
        const user = await getLocalUser(ctx.pool, tenantId, identity.userId);
        if (!user || user.disabled) return fail("disabled");
        if (membership !== null && membership !== "active") {
          if (identity.provisioned && membership === "none") {
            await setLocalUserDisabled(ctx.pool, tenantId, identity.userId, true);
            ctx.access?.forgetUser(tenantId, identity.userId);
          }
          return fail("not_member");
        }
        userId = identity.userId;
      } else {
        if (!settings.autoProvision) return fail("not_linked");
        if (membership !== "active") return fail("not_member");
        try {
          userId = await provision(ctx, tenantId, subject, login);
        } catch {
          return fail("failed");
        }
      }
      if ((await getUserToolPolicy(ctx.pool, tenantId, userId, "github")).mode !== "source")
        return fail("github_disabled");
      try {
        await saveAccount(ctx, tenantId, userId, "github", login, token.reveal(), {}, undefined, {
          subject,
          login,
        });
      } catch (error) {
        return fail(error instanceof IdentityConflictError ? "identity_in_use" : "failed");
      }
      const user = await getLocalUser(ctx.pool, tenantId, userId);
      if (!user || user.disabled) return fail("disabled");
      const principal: Principal = {
        id: `local:${user.id}`,
        tenantId,
        roles: ["viewer"],
        kind: GITHUB_SIGN_IN_KIND,
        name: user.username,
        localUserId: user.id,
        credentialVersion: user.credentialVersion,
      };
      const issued = sessions.issue(principal);
      req.log.info({ principal: principal.id, tenantId }, "session started with GitHub");
      return reply
        .header("set-cookie", [
          ...sessionCookieHeaders(req, publicUrl, sessions, {
            session: issued.cookie,
            csrf: issued.payload.csrf,
          }),
          loginCookie(req, null),
        ])
        .redirect(next, 303);
    },
  );

  app.get(
    GITHUB_SIGN_IN_ROUTES.settings,
    { config: { access: "admin", rateLimit: settingsReadLimit }, errorHandler: rateLimitedJson },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const tid = requestTenant(req);
      return {
        ...(await getGitHubSignInSettings(ctx.pool, tid)),
        configured: Boolean(options.localAuth && publicUrl && oauthConfig()),
        installedOrgs: [...(await activeInstallationOrgs(ctx.pool, tid))].sort(),
        callbackUrl: publicUrl ? `${publicUrl}${GITHUB_SIGN_IN_ROUTES.callback}` : null,
      };
    },
  );

  app.put<{
    Body: {
      enabled?: unknown;
      autoProvision?: unknown;
      allowedOrgs?: unknown;
      defaultRole?: unknown;
    };
  }>(
    GITHUB_SIGN_IN_ROUTES.settings,
    {
      config: { access: "admin", rateLimit: settingsWriteLimit },
      bodyLimit: 16384,
      errorHandler: rateLimitedJson,
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const tid = requestTenant(req);
      const b = req.body ?? {};
      const bad = (message: string) => reply.code(400).send({ error: "invalid_settings", message });
      if (typeof b.enabled !== "boolean" || typeof b.autoProvision !== "boolean")
        return bad("enabled and autoProvision must be booleans.");
      if (b.defaultRole !== undefined && b.defaultRole !== "viewer")
        return bad("Auto-provisioned users are managed viewers; defaultRole can only be viewer.");
      if (!Array.isArray(b.allowedOrgs) || b.allowedOrgs.length > 50)
        return bad("allowedOrgs must be a list of at most 50 organization logins.");
      const orgs: string[] = [];
      for (const o of b.allowedOrgs) {
        const login = normalizeOrgLogin(o);
        if (!login) return bad("allowedOrgs contains an invalid organization login.");
        if (!orgs.includes(login)) orgs.push(login);
      }
      if (b.autoProvision && !orgs.length)
        return bad("Auto-provisioning needs at least one allowed organization.");
      // Only organizations where this tenant's own App installation is active.
      const installed = await activeInstallationOrgs(ctx.pool, tid);
      const missing = orgs.filter((o) => !installed.has(o));
      if (missing.length)
        return reply.code(400).send({
          error: "org_not_installed",
          message:
            "Each allowed organization needs an active installation of this Afe's GitHub App.",
          orgs: missing,
        });
      await putGitHubSignInSettings(ctx.pool, tid, {
        enabled: b.enabled,
        autoProvision: b.autoProvision,
        allowedOrgs: orgs,
        defaultRole: "viewer",
      });
      return { ok: true };
    },
  );
}

/** Creates a managed user with GitHub in Source mode, bound to the numeric GitHub id. */
async function provision(
  ctx: ServerContext,
  tenantId: string,
  subject: string,
  login: string,
): Promise<string> {
  const db = await ctx.pool.connect();
  try {
    await db.query("BEGIN");
    let created;
    try {
      await db.query("SAVEPOINT username");
      created = await createLocalUser(db, tenantId, login);
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      await db.query("ROLLBACK TO SAVEPOINT username");
      created = await createLocalUser(db, tenantId, `${login}-${subject}`);
    }
    await setUserToolPolicy(db, tenantId, created.user.id, "github", {
      mode: "source",
      custom: [],
    });
    const bound = await bindExternalIdentity(db, tenantId, created.user.id, {
      provider: "github",
      subject,
      login,
      provisioned: true,
    });
    if (bound === "conflict") throw new IdentityConflictError();
    await db.query("COMMIT");
    return created.user.id;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
