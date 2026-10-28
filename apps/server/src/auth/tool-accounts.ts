import { githubUserId } from "../actions/github-identity.ts";
import type pg from "pg";
import {
  argocdOidcConfig,
  argocdOidcChoices,
  clearArgocdOidcStates,
  registerArgocdOidcRoutes,
} from "./argocd-oidc.ts";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { GitHubHttp, exchangeUserCode } from "@afe/connector-github";
import { VercelClient, buildInstallUrl, exchangeOAuthCode } from "@afe/connector-vercel";
import { createArgoCdClient } from "@afe/connector-argocd";
import { parseCookies, SESSION_COOKIE } from "./session.ts";
import { Secret } from "@afe/core/security";
import {
  getConnection,
  getCredential,
  getUserToolPolicy,
  revokeCredential,
  storeCredential,
} from "@afe/db";
import type { EventAccessRule } from "@afe/core";
import type { ServerContext } from "../context.ts";
import { readSecretEnv } from "../config.ts";
import { requestTenant } from "./index.ts";
import { USER_TOOLS } from "./user-routes.ts";

export interface ToolAccount {
  tool: string;
  account_name: string;
  credential_id: string;
  context: { connectionId?: string; teamId?: string; oidcRevision?: string; expiresAt?: number };
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const binding = (req: FastifyRequest) =>
  hash(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "");
function githubConfig() {
  const clientId = process.env.AFE_USER_GITHUB_CLIENT_ID;
  const secret = readSecretEnv(process.env, "AFE_USER_GITHUB_CLIENT_SECRET");
  return clientId && secret ? { clientId, clientSecret: new Secret(secret) } : null;
}
function vercelConfig() {
  const clientId = process.env.AFE_USER_VERCEL_CLIENT_ID;
  const secret = readSecretEnv(process.env, "AFE_USER_VERCEL_CLIENT_SECRET");
  const slug = process.env.AFE_USER_VERCEL_INTEGRATION_SLUG;
  return clientId && secret && slug ? { clientId, clientSecret: new Secret(secret), slug } : null;
}
export async function toolAccounts(
  ctx: ServerContext,
  tenantId: string,
  userId: string,
): Promise<ToolAccount[]> {
  return (
    await ctx.pool.query<ToolAccount>(
      "SELECT tool,account_name,credential_id,context FROM user_tool_accounts WHERE tenant_id=$1 AND user_id=$2",
      [tenantId, userId],
    )
  ).rows;
}
async function saveAccount(
  ctx: ServerContext,
  tid: string,
  uid: string,
  tool: string,
  name: string,
  token: string,
  context: ToolAccount["context"],
  guard?: (db: pg.PoolClient) => Promise<void>,
) {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize replacement/disconnection for the same user's accounts.
    await client.query("SELECT id FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tid, uid]);
    if (guard) await guard(client);
    else if (tool === "argocd") await clearArgocdOidcStates(client, tid, uid);
    const old = await client.query<ToolAccount>(
      "SELECT credential_id FROM user_tool_accounts WHERE tenant_id=$1 AND user_id=$2 AND tool=$3",
      [tid, uid, tool],
    );
    const stored = await storeCredential(client, ctx.keys, tid, {
      kind: `user_${tool}_token`,
      secret: token,
    });
    await client.query(
      `INSERT INTO user_tool_accounts (tenant_id,user_id,tool,account_name,credential_id,context)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,user_id,tool) DO UPDATE
      SET account_name=EXCLUDED.account_name, credential_id=EXCLUDED.credential_id,context=EXCLUDED.context,linked_at=now()`,
      [tid, uid, tool, name, stored.id, JSON.stringify(context)],
    );
    if (old.rows[0]) await revokeCredential(client, tid, old.rows[0].credential_id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Always revalidate upstream access. Failures produce no source grants. Never trust saved resource lists. */
export async function sourceAccess(
  ctx: ServerContext,
  tid: string,
  account: ToolAccount,
): Promise<EventAccessRule[]> {
  const stored = await getCredential(ctx.pool, ctx.keys, tid, account.credential_id);
  if (!stored) return [];
  if (account.tool === "github") {
    const http = new GitHubHttp({ maxRetries: 0 });
    const rules: EventAccessRule[] = [];
    for (let page = 1; page <= 50; page++) {
      const res = await http.request<{ full_name: string }[]>({
        method: "GET",
        path: "/user/repos",
        query: { per_page: 100, page },
        token: stored.secret,
        bucket: "user",
      });
      for (const repo of res.data)
        if (typeof repo.full_name === "string")
          rules.push({ source: "github", resource: `repository:${repo.full_name.toLowerCase()}` });
      if (res.data.length < 100) return rules;
    }
    throw new Error("source resource limit");
  }
  if (account.tool === "vercel") {
    const client = new VercelClient({ token: stored.secret, maxRetries: 0 });
    const projects = await client.listProjects(account.context.teamId ?? null);
    return projects.map((p) => ({ source: "vercel", resource: `project:${p.id}` }));
  }
  if (account.tool === "argocd" && account.context.connectionId) {
    const c = await getConnection(ctx.pool, tid, account.context.connectionId);
    if (
      !c ||
      c.source !== "argocd" ||
      c.status !== "active" ||
      typeof c.config.serverUrl !== "string"
    )
      return [];
    if (
      account.context.oidcRevision &&
      (argocdOidcConfig(c.config.userOidc)?.revision !== account.context.oidcRevision ||
        !account.context.expiresAt ||
        account.context.expiresAt <= Date.now() / 1000)
    )
      return [];
    const handle = createArgoCdClient({
      config: {
        serverUrl: c.config.serverUrl,
        caPem: typeof c.config.caPem === "string" ? c.config.caPem : undefined,
      },
      token: () => stored.secret,
      policy: {
        allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets,
        allowInsecureHttp: ctx.config.allowInsecureHttpTargets,
      },
    });
    try {
      const apps = await handle.client.listApplications();
      return (apps.items ?? []).flatMap((a) =>
        a.metadata?.name
          ? [
              {
                source: "argocd",
                resource: `application:${a.metadata.name}`,
                connectionId: c.id,
                targetId: a.metadata.namespace
                  ? `${a.metadata.namespace}/${a.metadata.name}`
                  : a.metadata.name,
              },
            ]
          : [],
      );
    } finally {
      await handle.close();
    }
  }
  return [];
}

export function registerToolAccountRoutes(app: FastifyInstance, ctx: ServerContext) {
  registerArgocdOidcRoutes(app, ctx, saveAccount);
  app.get("/api/profile", { config: { access: "viewer" } }, async (req) => {
    const tid = requestTenant(req),
      uid = req.principal?.localUserId ?? (await githubUserId(ctx, req));
    if (!uid) return { tools: [], managedUser: false };
    const accounts = await toolAccounts(ctx, tid, uid);
    const tools = [];
    for (const tool of USER_TOOLS) {
      if (!req.principal?.localUserId && tool !== "github") continue;
      const policy = await getUserToolPolicy(ctx.pool, tid, uid, tool);
      if (policy.mode === "none") continue;
      const account = accounts.find((a) => a.tool === tool);
      const oidcConnections =
        tool === "argocd" && ["source", "source + custom"].includes(policy.mode)
          ? await argocdOidcChoices(ctx, tid)
          : [];
      tools.push({
        ...(tool === "argocd" ? { oidcConnections } : {}),
        tool,
        mode: policy.mode,
        linked: Boolean(account),
        accountName: account?.account_name ?? null,
        oauthAvailable: Boolean(
          ctx.config.publicUrl &&
          (tool === "github"
            ? githubConfig()
            : tool === "vercel"
              ? vercelConfig()
              : oidcConnections.length),
        ),
        sourceAvailable: tool !== "terraform",
        sourceEnabled:
          tool === "github" || policy.mode === "source" || policy.mode === "source + custom",
      });
    }
    return { tools, managedUser: true };
  });
  app.post<{ Body: { token?: unknown } }>(
    "/api/profile/tools/github/token",
    { config: { access: "viewer" }, bodyLimit: 8192 },
    async (req, reply) => {
      const tid = requestTenant(req),
        uid = await githubUserId(ctx, req);
      if (!uid) return reply.code(409).send({ error: "local_account_required" });
      const policy = await getUserToolPolicy(ctx.pool, tid, uid, "github");
      if (policy.mode === "none") return reply.code(403).send({ error: "forbidden" });
      const value = req.body?.token;
      if (typeof value !== "string" || value.length < 10 || value.length > 4096 || /\s/.test(value))
        return reply.code(400).send({
          error: "invalid_token",
          message: "Enter your GitHub fine-grained or personal access token.",
        });
      try {
        const identity = await new GitHubHttp({ maxRetries: 0 }).request<{
          id: number;
          login: string;
        }>({
          method: "GET",
          path: "/user",
          token: new Secret(value),
          bucket: `personal:${tid}:${uid}`,
        });
        if (!identity.data.id || !identity.data.login) throw new Error("invalid identity");
        await saveAccount(ctx, tid, uid, "github", identity.data.login, value, {});
        return { ok: true };
      } catch {
        return reply.code(403).send({
          error: "link_failed",
          message:
            "GitHub rejected this personal identity. Check the token expiry and organization approval.",
        });
      }
    },
  );
  app.post(
    "/api/profile/tools/github/login",
    { config: { access: "viewer" } },
    async (req, reply) => {
      const tid = requestTenant(req),
        uid = await githubUserId(ctx, req),
        config = githubConfig();
      if (!uid || !config || !ctx.config.publicUrl)
        return reply.code(409).send({
          error: "oauth_unavailable",
          message: "GitHub account linking is not configured.",
        });
      const p = await getUserToolPolicy(ctx.pool, tid, uid, "github");
      if (p.mode === "none") return reply.code(403).send({ error: "forbidden" });
      if (!parseCookies(req.headers.cookie)[SESSION_COOKIE])
        return reply.code(400).send({ error: "session_required" });
      const state = randomBytes(32).toString("base64url");
      await ctx.pool.query(
        "DELETE FROM user_oauth_states WHERE tenant_id=$1 AND expires_at<now()",
        [tid],
      );
      await ctx.pool.query(
        "INSERT INTO user_oauth_states (tenant_id,user_id,tool,digest,session_binding,expires_at) VALUES ($1,$2,'github',$3,$4,now()+interval '10 minutes')",
        [tid, uid, hash(state), binding(req)],
      );
      const u = new URL("https://github.com/login/oauth/authorize");
      u.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${ctx.config.publicUrl}/api/profile/tools/github/callback`,
        scope:
          (req.body as { workflowAccess?: boolean } | undefined)?.workflowAccess === true
            ? "repo read:user workflow"
            : "repo read:user",
        state,
      }).toString();
      return { url: u.toString() };
    },
  );
  app.get<{ Querystring: { state?: string; code?: string } }>(
    "/api/profile/tools/github/callback",
    { config: { access: "viewer" } },
    async (req, reply) => {
      const tid = requestTenant(req),
        uid = await githubUserId(ctx, req),
        config = githubConfig();
      reply.header("referrer-policy", "no-referrer");
      const { state, code } = req.query;
      if (
        !uid ||
        !config ||
        typeof state !== "string" ||
        state.length > 200 ||
        typeof code !== "string" ||
        code.length > 1024
      )
        return reply.code(400).send({ error: "invalid_callback" });
      const p = await getUserToolPolicy(ctx.pool, tid, uid, "github");
      if (p.mode === "none") return reply.code(403).send({ error: "forbidden" });
      const used = await ctx.pool.query(
        "DELETE FROM user_oauth_states WHERE tenant_id=$1 AND user_id=$2 AND tool='github' AND digest=$3 AND session_binding=$4 AND expires_at>now() RETURNING digest",
        [tid, uid, hash(state), binding(req)],
      );
      if (!used.rowCount) return reply.code(400).send({ error: "invalid_state" });
      try {
        const token = await exchangeUserCode(config, code);
        const http = new GitHubHttp({ maxRetries: 0 });
        const user = await http.request<{ id: number; login: string }>({
          method: "GET",
          path: "/user",
          token,
          bucket: "user",
        });
        if (!user.data.id || !user.data.login) throw new Error("invalid identity");
        await saveAccount(ctx, tid, uid, "github", user.data.login, token.reveal(), {});
        return reply.redirect("/profile?linked=github", 303);
      } catch {
        return reply.code(502).send({
          error: "link_failed",
          message: "GitHub account linking failed. Start again from your profile.",
        });
      }
    },
  );
  app.post(
    "/api/profile/tools/vercel/login",
    { config: { access: "viewer" } },
    async (req, reply) => {
      const tid = requestTenant(req),
        uid = req.principal?.localUserId,
        config = vercelConfig();
      if (!uid || !config || !ctx.config.publicUrl)
        return reply
          .code(409)
          .send({ error: "oauth_unavailable", message: "Vercel sign-in is not configured." });
      const p = await getUserToolPolicy(ctx.pool, tid, uid, "vercel");
      if (p.mode !== "source" && p.mode !== "source + custom")
        return reply.code(403).send({ error: "forbidden" });
      if (!parseCookies(req.headers.cookie)[SESSION_COOKIE])
        return reply.code(400).send({ error: "session_required" });
      const state = randomBytes(32).toString("base64url");
      await ctx.pool.query(
        "DELETE FROM user_oauth_states WHERE tenant_id=$1 AND expires_at<now()",
        [tid],
      );
      await ctx.pool.query(
        "INSERT INTO user_oauth_states (tenant_id,user_id,tool,digest,session_binding,expires_at) VALUES ($1,$2,'vercel',$3,$4,now()+interval '10 minutes')",
        [tid, uid, hash(state), binding(req)],
      );
      return { url: buildInstallUrl(config.slug, state) };
    },
  );
  app.get<{ Querystring: { state?: string; code?: string } }>(
    "/api/profile/tools/vercel/callback",
    { config: { access: "viewer" } },
    async (req, reply) => {
      reply.header("referrer-policy", "no-referrer");
      const tid = requestTenant(req),
        uid = req.principal?.localUserId,
        config = vercelConfig();
      const { state, code } = req.query;
      if (
        !uid ||
        !config ||
        !ctx.config.publicUrl ||
        typeof state !== "string" ||
        state.length > 200 ||
        typeof code !== "string" ||
        code.length > 1024
      )
        return reply.code(400).send({ error: "invalid_callback" });
      const p = await getUserToolPolicy(ctx.pool, tid, uid, "vercel");
      if (p.mode !== "source" && p.mode !== "source + custom")
        return reply.code(403).send({ error: "forbidden" });
      const used = await ctx.pool.query(
        "DELETE FROM user_oauth_states WHERE tenant_id=$1 AND user_id=$2 AND tool='vercel' AND digest=$3 AND session_binding=$4 AND expires_at>now() RETURNING digest",
        [tid, uid, hash(state), binding(req)],
      );
      if (!used.rowCount) return reply.code(400).send({ error: "invalid_state" });
      try {
        const result = await exchangeOAuthCode({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          code,
          redirectUri: `${ctx.config.publicUrl}/api/profile/tools/vercel/callback`,
        });
        const client = new VercelClient({ token: result.accessToken, maxRetries: 0 });
        const user = await client.getUser();
        if (user.id !== result.userId) throw new Error("identity mismatch");
        await client.listProjects(result.teamId);
        await saveAccount(
          ctx,
          tid,
          uid,
          "vercel",
          user.username ?? user.id,
          result.accessToken.reveal(),
          result.teamId ? { teamId: result.teamId } : {},
        );
        return reply.redirect("/profile?linked=vercel", 303);
      } catch {
        return reply.code(502).send({
          error: "link_failed",
          message: "Vercel account linking failed. Start again from your profile.",
        });
      }
    },
  );
  app.post<{
    Params: { tool: string };
    Body: { token?: unknown; teamId?: unknown; connectionId?: unknown };
  }>(
    "/api/profile/tools/:tool/token",
    { config: { access: "viewer" }, bodyLimit: 16384 },
    async (req, reply) => {
      const tid = requestTenant(req),
        uid = req.principal?.localUserId,
        tool = req.params.tool,
        b = req.body;
      if (
        !uid ||
        !["vercel", "argocd"].includes(tool) ||
        typeof b?.token !== "string" ||
        !b.token ||
        b.token.length > 8192
      )
        return reply.code(400).send({ error: "bad_request" });
      const p = await getUserToolPolicy(ctx.pool, tid, uid, tool);
      if (p.mode !== "source" && p.mode !== "source + custom")
        return reply.code(403).send({ error: "forbidden" });
      const context: ToolAccount["context"] = {};
      if (tool === "vercel" && b.teamId !== undefined) {
        if (typeof b.teamId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(b.teamId))
          return reply.code(400).send({ error: "bad_request" });
        context.teamId = b.teamId;
      }
      if (tool === "argocd") {
        if (typeof b.connectionId !== "string" || !/^[a-f0-9-]{36}$/i.test(b.connectionId))
          return reply.code(400).send({ error: "bad_request" });
        context.connectionId = b.connectionId;
        const c = await getConnection(ctx.pool, tid, b.connectionId);
        if (!c || c.source !== "argocd") return reply.code(404).send({ error: "not_found" });
      }
      try {
        // Test the caller's credential before storing it; never reuse the admin's token.
        let name = tool;
        if (tool === "vercel") {
          const client = new VercelClient({ token: new Secret(b.token), maxRetries: 0 });
          const user = await client.getUser();
          name = user.username ?? user.id;
          await client.listProjects(context.teamId ?? null);
        } else {
          const c = (await getConnection(ctx.pool, tid, context.connectionId!))!;
          const handle = createArgoCdClient({
            config: {
              serverUrl: String(c.config.serverUrl),
              caPem: typeof c.config.caPem === "string" ? c.config.caPem : undefined,
            },
            token: () => new Secret(b.token as string),
            policy: {
              allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets,
              allowInsecureHttp: ctx.config.allowInsecureHttpTargets,
            },
          });
          try {
            const info = await handle.client.getUserInfo();
            if (!info.loggedIn) throw new Error("not logged in");
            name = info.username ?? "ArgoCD user";
            await handle.client.listApplications();
          } finally {
            await handle.close();
          }
        }
        await saveAccount(ctx, tid, uid, tool, name, b.token, context);
        return { ok: true };
      } catch {
        return reply.code(400).send({
          error: "link_failed",
          message: "The tool rejected the credentials or is unavailable.",
        });
      }
    },
  );
  app.delete<{ Params: { tool: string } }>(
    "/api/profile/tools/:tool",
    { config: { access: "viewer" } },
    async (req, reply) => {
      const tid = requestTenant(req),
        uid =
          req.principal?.localUserId ??
          (req.params.tool === "github" ? await githubUserId(ctx, req) : null);
      if (!uid) return reply.code(409).send({ error: "local_account_required" });
      const client = await ctx.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          tid,
          uid,
        ]);
        if (req.params.tool === "argocd") await clearArgocdOidcStates(client, tid, uid);
        const old = await client.query<ToolAccount>(
          "DELETE FROM user_tool_accounts WHERE tenant_id=$1 AND user_id=$2 AND tool=$3 RETURNING credential_id",
          [tid, uid, req.params.tool],
        );
        if (old.rows[0]) await revokeCredential(client, tid, old.rows[0].credential_id);
        await client.query("COMMIT");
        return { ok: true };
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  );
}
