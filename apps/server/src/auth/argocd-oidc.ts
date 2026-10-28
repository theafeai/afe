import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createArgoCdClient, parseCaBundle } from "@afe/connector-argocd";
import type { JsonObject } from "@afe/core";
import { Secret } from "@afe/core/security";
import {
  getConnection,
  getConnectionCredentialIds,
  getCredential,
  getCredentialMetadata,
  getUserToolPolicy,
  listConnections,
  revokeCredential,
  storeCredential,
  updateConnectionConfig,
  attachConnectionCredential,
} from "@afe/db";
import type { ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import { requestTenant } from "./index.ts";
import { parseCookies, SESSION_COOKIE } from "./session.ts";
import { discoverOidc, exchangeOidcCode, oidcHttp, type OidcConfig } from "./oidc.ts";
import type { ToolAccount } from "./tool-accounts.ts";
const role = "user_oidc_client_secret";
function callbackUri(ctx: ServerContext): string | null {
  try {
    const u = new URL(ctx.config.publicUrl ?? "");
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/" &&
      !ctx.config.publicUrl?.includes("?") &&
      !ctx.config.publicUrl?.includes("#")
      ? `${u.origin}/api/profile/tools/argocd/callback`
      : null;
  } catch {
    return null;
  }
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const binding = (req: FastifyRequest) =>
  hash(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "");
const policy = (ctx: ServerContext) => ({
  allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets,
  allowInsecureHttp: ctx.config.allowInsecureHttpTargets,
});
export function argocdOidcConfig(value: unknown): OidcConfig | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<OidcConfig>;
  return typeof v.issuer === "string" &&
    typeof v.clientId === "string" &&
    typeof v.revision === "string" &&
    Array.isArray(v.scopes) &&
    ["none", "client_secret_basic", "client_secret_post"].includes(v.authMethod ?? "")
    ? (v as OidcConfig)
    : null;
}
export async function argocdOidcChoices(ctx: ServerContext, tid: string) {
  return (await listConnections(ctx.pool, tid, { source: "argocd", statuses: ["active"] }))
    .filter((c) => argocdOidcConfig(c.config.userOidc))
    .map((c) => ({ id: c.id, name: c.name }));
}
/** Called while holding the user's row lock, including unlink and manual replacement. */
export async function clearArgocdOidcStates(db: pg.PoolClient, tid: string, uid: string) {
  const { rows } = await db.query<{ credential_id: string }>(
    "DELETE FROM user_argocd_oidc_states WHERE tenant_id=$1 AND user_id=$2 RETURNING credential_id",
    [tid, uid],
  );
  for (const row of rows) await revokeCredential(db, tid, row.credential_id);
}
async function cleanupTenant(ctx: ServerContext, tid: string) {
  const db = await ctx.pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query<{ credential_id: string }>(
      "DELETE FROM user_argocd_oidc_states WHERE tenant_id=$1 AND expires_at<=now() RETURNING credential_id",
      [tid],
    );
    for (const row of rows) await revokeCredential(db, tid, row.credential_id);
    await db.query("COMMIT");
  } catch {
    await db.query("ROLLBACK");
    throw new Error("OIDC state cleanup failed");
  } finally {
    db.release();
  }
}
/** Explicit operator maintenance discovers tenants; each cleanup remains tenant-scoped. */
export function argocdOidcJobs(ctx: ServerContext): JobDefinition[] {
  return [
    {
      name: "argocd.user-oidc-cleanup",
      schedule: "0 * * * *",
      handler: async () => {
        const { rows } = await ctx.pool.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM user_argocd_oidc_states WHERE expires_at<=now()",
        );
        for (const row of rows) await cleanupTenant(ctx, row.tenant_id);
      },
    },
  ];
}
type SaveAccount = (
  ctx: ServerContext,
  tid: string,
  uid: string,
  tool: string,
  name: string,
  token: string,
  context: ToolAccount["context"],
  guard?: (db: pg.PoolClient) => Promise<void>,
) => Promise<void>;
export function registerArgocdOidcRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  saveAccount: SaveAccount,
) {
  app.get<{ Params: { id: string } }>(
    "/api/connections/argocd/:id/oidc",
    { config: { access: "admin" } },
    async (req, reply) => {
      const tid = requestTenant(req),
        c = uuid.test(req.params.id) ? await getConnection(ctx.pool, tid, req.params.id) : null;
      if (!c || c.source !== "argocd") return reply.code(404).send({ error: "not_found" });
      const config = argocdOidcConfig(c.config.userOidc),
        ids = await getConnectionCredentialIds(ctx.pool, tid, c.id);
      const metadata = ids[role] ? await getCredentialMetadata(ctx.pool, tid, ids[role]!) : null;
      return {
        config,
        clientSecretConfigured: Boolean(metadata && !metadata.revokedAt),
        callbackUrl: callbackUri(ctx),
      };
    },
  );
  app.put<{
    Params: { id: string };
    Body: {
      issuer?: unknown;
      clientId?: unknown;
      clientSecret?: unknown;
      scopes?: unknown;
      authMethod?: unknown;
      caPem?: unknown;
    };
  }>(
    "/api/connections/argocd/:id/oidc",
    { config: { access: "admin" }, bodyLimit: 300_000 },
    async (req, reply) => {
      const tid = requestTenant(req),
        c = uuid.test(req.params.id) ? await getConnection(ctx.pool, tid, req.params.id) : null;
      if (!c || c.source !== "argocd") return reply.code(404).send({ error: "not_found" });
      const b = req.body;
      if (!callbackUri(ctx)) return reply.code(409).send({ error: "oidc_public_url_required" });
      if (
        !b ||
        typeof b.issuer !== "string" ||
        b.issuer.length > 2048 ||
        typeof b.clientId !== "string" ||
        !b.clientId ||
        b.clientId.length > 512 ||
        !["none", "client_secret_basic", "client_secret_post"].includes(String(b.authMethod)) ||
        !Array.isArray(b.scopes) ||
        b.scopes.length > 10 ||
        !b.scopes.includes("openid") ||
        b.scopes.some(
          (s) => typeof s !== "string" || !["openid", "profile", "email", "groups"].includes(s),
        ) ||
        (b.clientSecret !== undefined &&
          (typeof b.clientSecret !== "string" ||
            !b.clientSecret ||
            b.clientSecret.length > 8192)) ||
        (b.caPem !== undefined && typeof b.caPem !== "string")
      )
        return reply.code(400).send({ error: "invalid_oidc_config" });
      let config: OidcConfig;
      try {
        const caPem = b.caPem?.trim() ? parseCaBundle(b.caPem as string) : undefined;
        config = {
          issuer: b.issuer,
          clientId: b.clientId,
          scopes: [...new Set(b.scopes)] as string[],
          authMethod: b.authMethod as OidcConfig["authMethod"],
          revision: randomUUID(),
          ...(caPem ? { caPem } : {}),
        };
        const http = oidcHttp(policy(ctx), config.caPem);
        try {
          await discoverOidc(http, config, policy(ctx));
        } finally {
          await http.close();
        }
      } catch {
        return reply.code(400).send({
          error: "invalid_oidc_config",
          message:
            "OIDC discovery failed or the provider does not support this client configuration.",
        });
      }
      const db = await ctx.pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          tid,
          c.id,
        ]);
        const ids = await getConnectionCredentialIds(db, tid, c.id),
          old = ids[role];
        const previous = argocdOidcConfig((await getConnection(db, tid, c.id))?.config.userOidc);
        if (config.authMethod !== "none") {
          if (b.clientSecret) {
            const stored = await storeCredential(db, ctx.keys, tid, {
              kind: "argocd_user_oidc_client_secret",
              secret: new Secret(b.clientSecret as string),
            });
            await attachConnectionCredential(db, tid, c.id, role, stored.id);
            if (old) await revokeCredential(db, tid, old);
          } else if (
            !old ||
            !previous ||
            previous.issuer !== config.issuer ||
            previous.clientId !== config.clientId ||
            !(await getCredential(db, ctx.keys, tid, old))
          ) {
            await db.query("ROLLBACK");
            return reply.code(400).send({ error: "oidc_secret_required" });
          }
        } else if (old) {
          await revokeCredential(db, tid, old);
          await db.query(
            "DELETE FROM connection_credentials WHERE tenant_id=$1 AND connection_id=$2 AND role=$3",
            [tid, c.id, role],
          );
        }
        await updateConnectionConfig(db, tid, c.id, {
          userOidc: config as unknown as JsonObject,
        });
        await db.query("COMMIT");
        return { ok: true };
      } catch {
        await db.query("ROLLBACK");
        throw new Error("OIDC configuration could not be saved");
      } finally {
        db.release();
      }
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/connections/argocd/:id/oidc",
    { config: { access: "admin" } },
    async (req, reply) => {
      const tid = requestTenant(req),
        c = uuid.test(req.params.id) ? await getConnection(ctx.pool, tid, req.params.id) : null;
      if (!c || c.source !== "argocd") return reply.code(404).send({ error: "not_found" });
      const db = await ctx.pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          tid,
          c.id,
        ]);
        const ids = await getConnectionCredentialIds(db, tid, c.id);
        if (ids[role]) await revokeCredential(db, tid, ids[role]!);
        await db.query(
          "DELETE FROM connection_credentials WHERE tenant_id=$1 AND connection_id=$2 AND role=$3",
          [tid, c.id, role],
        );
        await updateConnectionConfig(db, tid, c.id, { userOidc: null });
        await db.query("COMMIT");
        return { ok: true };
      } catch {
        await db.query("ROLLBACK");
        throw new Error("OIDC configuration could not be removed");
      } finally {
        db.release();
      }
    },
  );
  app.post<{ Body: { connectionId?: unknown } }>(
    "/api/profile/tools/argocd/login",
    { config: { access: "viewer" }, bodyLimit: 4096 },
    async (req, reply) => {
      const tid = requestTenant(req),
        uid = req.principal?.localUserId,
        id = req.body?.connectionId;
      if (!uid || req.principal?.kind !== "session")
        return reply.code(400).send({ error: "session_required" });
      const p = await getUserToolPolicy(ctx.pool, tid, uid, "argocd");
      if (p.mode !== "source" && p.mode !== "source + custom")
        return reply.code(403).send({ error: "forbidden" });
      const c =
        typeof id === "string" && uuid.test(id) ? await getConnection(ctx.pool, tid, id) : null;
      if (!c || c.source !== "argocd" || c.status !== "active")
        return reply.code(404).send({ error: "not_found" });
      const config = argocdOidcConfig(c.config.userOidc);
      if (!config || !callbackUri(ctx)) return reply.code(409).send({ error: "oauth_unavailable" });
      const http = oidcHttp(policy(ctx), config.caPem);
      try {
        const discovery = await discoverOidc(http, config, policy(ctx));
        await cleanupTenant(ctx, tid);
        const state = randomBytes(32).toString("base64url"),
          verifier = randomBytes(32).toString("base64url"),
          nonce = randomBytes(32).toString("base64url"),
          redirectUri = callbackUri(ctx)!;
        const db = await ctx.pool.connect();
        try {
          await db.query("BEGIN");
          await db.query("SELECT id FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            tid,
            uid,
          ]);
          await clearArgocdOidcStates(db, tid, uid);
          const saved = await storeCredential(db, ctx.keys, tid, {
            kind: "argocd_oidc_pkce",
            secret: JSON.stringify({ verifier, nonce, revision: config.revision, redirectUri }),
          });
          await db.query(
            "INSERT INTO user_argocd_oidc_states(tenant_id,digest,user_id,connection_id,session_binding,credential_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')",
            [tid, hash(state), uid, c.id, binding(req), saved.id],
          );
          await db.query("COMMIT");
        } catch {
          await db.query("ROLLBACK");
          throw new Error("OIDC state could not be saved");
        } finally {
          db.release();
        }
        const url = new URL(discovery.authorization_endpoint);
        url.search = new URLSearchParams({
          client_id: config.clientId,
          response_type: "code",
          redirect_uri: redirectUri,
          scope: config.scopes.join(" "),
          state,
          nonce,
          code_challenge: Buffer.from(createHash("sha256").update(verifier).digest()).toString(
            "base64url",
          ),
          code_challenge_method: "S256",
        }).toString();
        return { url: url.href };
      } catch {
        return reply.code(502).send({
          error: "link_failed",
          message: "ArgoCD SSO is unavailable. Start again from Profile.",
        });
      } finally {
        await http.close();
      }
    },
  );
  app.get<{ Querystring: { state?: unknown; code?: unknown; error?: unknown } }>(
    "/api/profile/tools/argocd/callback",
    { config: { access: "viewer" } },
    async (req, reply) => {
      reply.header("referrer-policy", "no-referrer").header("cache-control", "no-store");
      const tid = requestTenant(req),
        uid = req.principal?.localUserId,
        { state, code, error } = req.query;
      if (
        !uid ||
        req.principal?.kind !== "session" ||
        typeof state !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(state)
      )
        return reply.code(400).send({ error: "invalid_callback" });
      const p = await getUserToolPolicy(ctx.pool, tid, uid, "argocd");
      if (p.mode !== "source" && p.mode !== "source + custom")
        return reply.code(403).send({ error: "forbidden" });
      const db = await ctx.pool.connect();
      let flow: { verifier: string; nonce: string; revision: string; redirectUri: string },
        connectionId: string;
      try {
        await db.query("BEGIN");
        const { rows } = await db.query<{ connection_id: string; credential_id: string }>(
          "UPDATE user_argocd_oidc_states SET used_at=now() WHERE tenant_id=$1 AND user_id=$2 AND digest=$3 AND session_binding=$4 AND expires_at>now() AND used_at IS NULL RETURNING connection_id,credential_id",
          [tid, uid, hash(state), binding(req)],
        );
        if (!rows[0]) {
          await db.query("ROLLBACK");
          return reply.code(400).send({ error: "invalid_state" });
        }
        connectionId = rows[0].connection_id;
        const stored = await getCredential(db, ctx.keys, tid, rows[0].credential_id);
        if (!stored) throw new Error("missing flow");
        flow = JSON.parse(stored.secret.reveal()) as typeof flow;
        await revokeCredential(db, tid, rows[0].credential_id);
        await db.query("COMMIT");
      } catch {
        await db.query("ROLLBACK");
        return reply.code(400).send({ error: "invalid_state" });
      } finally {
        db.release();
      }
      if (error !== undefined || typeof code !== "string" || !code || code.length > 4096)
        return reply.code(400).send({ error: "invalid_callback" });
      const c = await getConnection(ctx.pool, tid, connectionId),
        config = argocdOidcConfig(c?.config.userOidc);
      if (
        !c ||
        c.status !== "active" ||
        !config ||
        config.revision !== flow.revision ||
        !ctx.config.publicUrl ||
        flow.redirectUri !== callbackUri(ctx)
      )
        return reply.code(400).send({ error: "invalid_state" });
      const http = oidcHttp(policy(ctx), config.caPem);
      try {
        const discovery = await discoverOidc(http, config, policy(ctx)),
          ids = await getConnectionCredentialIds(ctx.pool, tid, c.id);
        const secret = ids[role] ? await getCredential(ctx.pool, ctx.keys, tid, ids[role]!) : null;
        const result = await exchangeOidcCode(http, config, discovery, {
          code,
          verifier: flow.verifier,
          nonce: flow.nonce,
          redirectUri: flow.redirectUri,
          clientSecret: secret?.secret,
        });
        const handle = createArgoCdClient({
          config: {
            serverUrl: String(c.config.serverUrl),
            caPem: typeof c.config.caPem === "string" ? c.config.caPem : undefined,
          },
          token: () => new Secret(result.token),
          policy: policy(ctx),
        });
        let name: string;
        try {
          const info = await handle.client.getUserInfo();
          if (!info.loggedIn || !info.username || (info.iss && info.iss !== config.issuer))
            throw new Error("ArgoCD identity rejected");
          name = info.username;
          await handle.client.listApplications();
        } finally {
          await handle.close();
        }
        await saveAccount(
          ctx,
          tid,
          uid,
          "argocd",
          name,
          result.token,
          { connectionId: c.id, oidcRevision: config.revision, expiresAt: result.expiresAt },
          async (client) => {
            const current = await getConnection(client, tid, c.id),
              policyNow = await getUserToolPolicy(client, tid, uid, "argocd");
            const user = await client.query(
              "SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND NOT disabled AND credential_version=$3",
              [tid, uid, req.principal!.credentialVersion],
            );
            const pending = await client.query(
              "DELETE FROM user_argocd_oidc_states WHERE tenant_id=$1 AND user_id=$2 AND digest=$3 AND session_binding=$4 AND used_at IS NOT NULL AND expires_at>now() RETURNING digest",
              [tid, uid, hash(state), binding(req)],
            );
            if (
              !pending.rowCount ||
              !user.rowCount ||
              current?.status !== "active" ||
              argocdOidcConfig(current.config.userOidc)?.revision !== config.revision ||
              !["source", "source + custom"].includes(policyNow.mode)
            )
              throw new Error("flow invalidated");
          },
        );
        return reply.redirect("/profile?linked=argocd", 303);
      } catch {
        return reply.code(502).send({
          error: "link_failed",
          message: "ArgoCD rejected the sign-in or SSO is unavailable. Start again from Profile.",
        });
      } finally {
        await http.close();
      }
    },
  );
}
