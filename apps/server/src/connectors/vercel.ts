/**
 * Vercel connector wiring (AFE-11, ADR 0005): connection model (Vercel
 * Integration via OAuth, or an access-token fallback), project selection,
 * disconnect/revocation and the webhook receiver. Ingesting deployment events
 * (mapping, polling, backfill) is AFE-12: this module only enqueues
 * `vercel.webhook` jobs whose handler is a placeholder.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type Connection,
  type ConnectorHealthHooks,
  type JsonObject,
  type ProbeResult,
  DEFAULT_TENANT_ID,
} from "@afe/core";
import { Secret } from "@afe/core/security";
import {
  type FetchLike,
  type ProjectSelection,
  type VercelWebhookEvent,
  CONNECTOR_SOURCE,
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  NO_PROJECTS,
  ScopedVercelReader,
  VercelApiError,
  VercelClient,
  VercelRateLimitError,
  buildInstallUrl,
  deleteIntegrationConfiguration,
  deriveStateKey,
  exchangeOAuthCode,
  isLifecycleEvent,
  isProjectSelected,
  newStateNonce,
  parseProjectSelection,
  parseSelectionRequest,
  signState,
  verifyState,
  verifyVercelWebhook,
} from "@afe/connector-vercel";
import {
  attachConnectionCredential,
  findConnectionByExternalId,
  getConnection,
  getConnectionCredentialIds,
  getCredential,
  recordDelivery,
  resolveConnectionBySourceIdentity,
  revokeCredential,
  setConnectionStatus,
  storeCredential,
  updateConnectionConfig,
  upsertConnection,
} from "@afe/db";
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";

const SOURCE = CONNECTOR_SOURCE;
export const VERCEL_WEBHOOK_JOB = "vercel.webhook";
const ROLE_TOKEN = "access_token";
const ROLE_WEBHOOK_SECRET = "webhook_secret";
const STATE_COOKIE = "afe_vercel_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_BODY_LIMIT = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Non-secret connection settings stored in `connections.config`. */
export interface VercelConnectionConfig {
  /** `integration` = Vercel Integration (OAuth); `token` = user-supplied access token. */
  mode: "integration" | "token";
  /** Null for a personal (Hobby) account. */
  teamId: string | null;
  userId: string;
  /** Integration configuration (installation) id; integration mode only. */
  configurationId: string | null;
  projectSelection: ProjectSelection;
}

export function readVercelConfig(connection: Connection): VercelConnectionConfig {
  const c = connection.config;
  return {
    mode: c.mode === "integration" ? "integration" : "token",
    teamId: typeof c.teamId === "string" ? c.teamId : null,
    userId: typeof c.userId === "string" ? c.userId : "",
    configurationId: typeof c.configurationId === "string" ? c.configurationId : null,
    projectSelection: parseProjectSelection(c.projectSelection),
  };
}

/** Payload of `vercel.webhook` jobs. Contains no credentials. */
export interface VercelWebhookJob {
  tenantId: string;
  connectionId: string;
  deliveryId: string;
  type: string;
  createdAt: number;
  projectId: string | null;
  /** Event payload with env values stripped. */
  payload: JsonObject;
}

export interface VercelModuleOptions {
  /** Injected for tests; production uses global fetch against https://api.vercel.com. */
  fetch?: FetchLike;
  /** Base URL override, tests only. */
  apiBaseUrl?: string;
  /** Tenant of the authenticated API caller. Defaults to the single self-host tenant. */
  resolveTenant?: (req: FastifyRequest) => string | Promise<string>;
  now?: () => number;
  webhookToleranceMs?: number;
}

class MissingCredentialError extends Error {
  constructor() {
    super("Vercel credential missing or revoked");
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function publicView(c: Connection) {
  return {
    id: c.id,
    source: c.source,
    externalId: c.externalId,
    name: c.name,
    status: c.status,
    statusReason: c.statusReason,
    config: c.config,
  };
}

export function createVercelModule(options: VercelModuleOptions = {}): ConnectorModule {
  const now = options.now ?? Date.now;
  const resolveTenant = options.resolveTenant ?? (() => DEFAULT_TENANT_ID);
  const toleranceMs = options.webhookToleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;

  function clientWith(token: Secret<string> | (() => Promise<Secret<string>>)): VercelClient {
    return new VercelClient({
      token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
    });
  }

  /** Loads the token at use time (R2.6), so revocation/rotation apply to the next call. */
  async function loadToken(ctx: ServerContext, conn: Connection): Promise<Secret<string>> {
    const ids = await getConnectionCredentialIds(ctx.pool, conn.tenantId, conn.id);
    const id = ids[ROLE_TOKEN];
    const cred = id ? await getCredential(ctx.pool, ctx.keys, conn.tenantId, id) : null;
    if (!cred) throw new MissingCredentialError();
    return cred.secret;
  }

  async function markRevoked(ctx: ServerContext, conn: Connection, reason: string): Promise<void> {
    await setConnectionStatus(ctx.pool, conn.tenantId, conn.id, "revoked", reason);
    ctx.log.warn({ source: SOURCE, connectionId: conn.id, reason }, "vercel connection revoked");
  }

  async function revokeAllCredentials(ctx: ServerContext, conn: Connection): Promise<void> {
    const ids = await getConnectionCredentialIds(ctx.pool, conn.tenantId, conn.id);
    for (const id of Object.values(ids)) await revokeCredential(ctx.pool, conn.tenantId, id);
  }

  /**
   * Runs `fn` with a client for the connection. A 401/403 from Vercel, or a
   * missing credential, marks the connection revoked (ADR 0005).
   */
  async function withClient<T>(
    ctx: ServerContext,
    conn: Connection,
    fn: (client: VercelClient, cfg: VercelConnectionConfig) => Promise<T>,
  ): Promise<T> {
    const cfg = readVercelConfig(conn);
    try {
      return await fn(
        clientWith(() => loadToken(ctx, conn)),
        cfg,
      );
    } catch (err) {
      if (err instanceof VercelApiError && err.isAuthError) {
        await markRevoked(
          ctx,
          conn,
          `Vercel API returned ${err.status}: the token was revoked or expired, or lost access to the team`,
        );
      } else if (err instanceof MissingCredentialError) {
        await markRevoked(ctx, conn, "credential missing or revoked");
      }
      throw err;
    }
  }

  function sendUpstreamError(reply: FastifyReply, err: unknown): FastifyReply {
    if (
      err instanceof MissingCredentialError ||
      (err instanceof VercelApiError && err.isAuthError)
    ) {
      return reply.code(409).send({ error: "connection_revoked" });
    }
    if (err instanceof VercelRateLimitError) {
      if (err.retryAfter) {
        reply.header(
          "retry-after",
          Math.max(1, Math.ceil((err.retryAfter.getTime() - now()) / 1000)),
        );
      }
      return reply.code(503).send({ error: "vercel_rate_limited" });
    }
    return reply.code(502).send({ error: "vercel_unavailable" });
  }

  /** Stores a fresh token (and optional webhook secret) and upserts the connection atomically. */
  async function saveConnection(
    ctx: ServerContext,
    tenantId: string,
    input: {
      name: string;
      cfg: Omit<VercelConnectionConfig, "projectSelection">;
      token: Secret<string>;
      tokenKind: string;
      webhookSecret?: Secret<string>;
    },
  ): Promise<Connection> {
    const externalId = input.cfg.teamId ?? input.cfg.userId;
    const existing = await findConnectionByExternalId(ctx.pool, tenantId, SOURCE, externalId);
    // Reconnecting keeps an earlier explicit project choice.
    const selection = existing ? readVercelConfig(existing).projectSelection : NO_PROJECTS;
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      if (existing) {
        const old = await getConnectionCredentialIds(client, tenantId, existing.id);
        for (const id of Object.values(old)) await revokeCredential(client, tenantId, id);
      }
      const conn = await upsertConnection(client, tenantId, {
        source: SOURCE,
        externalId,
        name: input.name,
        status: "active",
        config: { ...input.cfg, projectSelection: selection as unknown as JsonObject },
      });
      const cred = await storeCredential(client, ctx.keys, tenantId, {
        kind: input.tokenKind,
        secret: input.token,
      });
      await attachConnectionCredential(client, tenantId, conn.id, ROLE_TOKEN, cred.id);
      if (input.webhookSecret) {
        const ws = await storeCredential(client, ctx.keys, tenantId, {
          kind: "vercel_webhook_secret",
          secret: input.webhookSecret,
        });
        await attachConnectionCredential(client, tenantId, conn.id, ROLE_WEBHOOK_SECRET, ws.id);
      }
      await client.query("COMMIT");
      return conn;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function loadOwnConnection(
    ctx: ServerContext,
    req: FastifyRequest<{ Params: { id: string } }>,
  ): Promise<Connection | null> {
    if (!UUID_PATTERN.test(req.params.id)) return null;
    const tenantId = await resolveTenant(req);
    const conn = await getConnection(ctx.pool, tenantId, req.params.id);
    return conn && conn.source === SOURCE ? conn : null;
  }

  // --- webhook processing ---------------------------------------------------

  async function handleLifecycle(
    ctx: ServerContext,
    conn: Connection,
    event: VercelWebhookEvent,
  ): Promise<void> {
    switch (event.type) {
      case "integration-configuration.removed":
        await revokeAllCredentials(ctx, conn);
        await markRevoked(
          ctx,
          conn,
          "Vercel integration was removed (integration-configuration.removed)",
        );
        break;
      case "integration-configuration.permission-upgraded":
        await updateConnectionConfig(ctx.pool, conn.tenantId, conn.id, {
          permissionsUpgradedAt: new Date(event.createdAt).toISOString(),
        });
        break;
      case "integration-configuration.scope-change-confirmed":
        // The installation's project access changed in Vercel. Afe's own
        // selection is unchanged; projects no longer accessible simply return 403/404.
        await updateConnectionConfig(ctx.pool, conn.tenantId, conn.id, {
          installationProjectIds: event.configurationProjects,
        });
        break;
    }
  }

  /** After verification: replay check, then lifecycle handling or enqueue. */
  async function dispatch(
    ctx: ServerContext,
    event: VercelWebhookEvent,
    connections: Connection[],
  ): Promise<{ status: string }> {
    const tenantId = connections.length === 1 ? connections[0]!.tenantId : null;
    const first = await recordDelivery(ctx.pool, tenantId, SOURCE, event.id, new Date(now()));
    if (!first) return { status: "duplicate" };
    if (connections.length === 0) return { status: "ignored_unknown_account" };

    for (const conn of connections) {
      if (isLifecycleEvent(event.type)) {
        if (readVercelConfig(conn).mode === "integration") await handleLifecycle(ctx, conn, event);
        continue;
      }
      if (conn.status !== "active") continue;
      const selection = readVercelConfig(conn).projectSelection;
      // Enforce project selection at the boundary: events of unselected projects
      // (or without a project when not observing "all") are not queued.
      if (
        event.projectId ? !isProjectSelected(selection, event.projectId) : selection.mode !== "all"
      ) {
        continue;
      }
      const job: VercelWebhookJob = {
        tenantId: conn.tenantId,
        connectionId: conn.id,
        deliveryId: event.id,
        type: event.type,
        createdAt: event.createdAt,
        projectId: event.projectId,
        payload: event.payload as JsonObject,
      };
      await ctx.jobs.send(VERCEL_WEBHOOK_JOB, job, { singletonKey: `${conn.id}:${event.id}` });
    }
    return { status: "accepted" };
  }

  function rejectWebhook(req: FastifyRequest, reply: FastifyReply, reason: string) {
    // R3.4: log source and reason only, never the signature or body.
    req.log.warn({ source: SOURCE, reason }, "vercel webhook rejected");
    return reply.code(401).send({ error: "unauthorized" });
  }

  return {
    source: SOURCE,

    jobs(ctx): JobDefinition[] {
      return [
        {
          name: VERCEL_WEBHOOK_JOB,
          // AFE-12 boundary: mapping Vercel events to canonical events and
          // ingesting them via ctx.sink is implemented there. Until then the job
          // only acknowledges the delivery.
          handler: async (data) => {
            const job = data as VercelWebhookJob;
            ctx.log.debug(
              {
                source: SOURCE,
                connectionId: job.connectionId,
                deliveryId: job.deliveryId,
                type: job.type,
              },
              "vercel webhook received (ingestion: AFE-12)",
            );
          },
        },
      ];
    },

    health(ctx): ConnectorHealthHooks {
      return {
        source: SOURCE,
        async probe(conn: Connection): Promise<ProbeResult> {
          try {
            await withClient(ctx, conn, async (client, cfg) =>
              cfg.teamId ? client.getTeam(cfg.teamId) : client.getUser(),
            );
            return { ok: true };
          } catch (err) {
            if (err instanceof MissingCredentialError) return { ok: false, reason: "revoked" };
            if (err instanceof VercelRateLimitError) {
              return {
                ok: false,
                reason: "rate_limited",
                ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
              };
            }
            if (err instanceof VercelApiError) {
              return err.isAuthError
                ? { ok: false, reason: "revoked", detail: `HTTP ${err.status}` }
                : { ok: false, reason: "error", detail: `HTTP ${err.status}` };
            }
            return { ok: false, reason: "unreachable" };
          }
        },
      };
    },

    routes(app: FastifyInstance, ctx: ServerContext) {
      const redirectUri = () => `${ctx.config.publicUrl}/api/connections/vercel/callback`;
      const integrationReady = () => Boolean(ctx.config.vercel && ctx.config.publicUrl);

      // --- Integration (OAuth) flow ---------------------------------------
      app.get("/api/connections/vercel/install", async (req, reply) => {
        const vc = ctx.config.vercel;
        if (!vc || !integrationReady()) {
          return reply.code(404).send({ error: "vercel_integration_not_configured" });
        }
        const tenantId = await resolveTenant(req);
        const nonce = newStateNonce();
        const state = signState(
          { tenantId, nonce, expiresAt: now() + STATE_TTL_MS },
          deriveStateKey(vc.clientSecret),
        );
        const secure = ctx.config.publicUrl!.startsWith("https://") ? "; Secure" : "";
        reply.header(
          "set-cookie",
          `${STATE_COOKIE}=${nonce}; Path=/api/connections/vercel; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_MS / 1000}${secure}`,
        );
        return reply.redirect(buildInstallUrl(vc.integrationSlug, state), 302);
      });

      app.get<{
        Querystring: { code?: string; state?: string; next?: string; configurationId?: string };
      }>("/api/connections/vercel/callback", async (req, reply) => {
        const vc = ctx.config.vercel;
        if (!vc || !integrationReady()) {
          return reply.code(404).send({ error: "vercel_integration_not_configured" });
        }
        const state = verifyState(req.query.state, deriveStateKey(vc.clientSecret), now());
        const cookieNonce = parseCookies(req.headers.cookie)[STATE_COOKIE];
        if (!state || !cookieNonce || cookieNonce !== state.nonce) {
          req.log.warn(
            { source: SOURCE, reason: "invalid_state" },
            "vercel oauth callback rejected",
          );
          return reply.code(400).send({
            error: "invalid_state",
            message: "Start the connection from Afe (Connections > Vercel > Connect).",
          });
        }
        reply.header(
          "set-cookie",
          `${STATE_COOKIE}=; Path=/api/connections/vercel; HttpOnly; Max-Age=0`,
        );
        const code = req.query.code;
        if (typeof code !== "string" || code === "" || code.length > 512) {
          return reply.code(400).send({ error: "missing_code" });
        }

        let exchanged;
        try {
          exchanged = await exchangeOAuthCode({
            clientId: vc.clientId,
            clientSecret: vc.clientSecret,
            code,
            redirectUri: redirectUri(),
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
          });
        } catch (err) {
          req.log.warn(
            { source: SOURCE, status: err instanceof VercelApiError ? err.status : null },
            "vercel oauth code exchange failed",
          );
          return reply.code(502).send({ error: "oauth_exchange_failed" });
        }

        const client = clientWith(exchanged.accessToken);
        let name: string;
        try {
          name = exchanged.teamId
            ? await client.getTeam(exchanged.teamId).then((t) => t.name || t.slug)
            : await client.getUser().then((u) => u.username);
        } catch (err) {
          return sendUpstreamError(reply, err);
        }
        const conn = await saveConnection(ctx, state.tenantId, {
          name,
          cfg: {
            mode: "integration",
            teamId: exchanged.teamId,
            userId: exchanged.userId,
            configurationId: exchanged.configurationId,
          },
          token: exchanged.accessToken,
          tokenKind: "vercel_oauth_token",
        });
        req.log.info({ source: SOURCE, connectionId: conn.id }, "vercel integration connected");

        // Vercel passes `next` when the install started in its own UI; only follow it to vercel.com.
        const next = req.query.next;
        if (typeof next === "string") {
          try {
            const u = new URL(next);
            if (u.protocol === "https:" && u.hostname === "vercel.com") {
              return reply.redirect(u.toString(), 302);
            }
          } catch {
            // ignore invalid next
          }
        }
        return reply.redirect(
          `${ctx.config.publicUrl}/connections/vercel/${conn.id}/projects`,
          302,
        );
      });

      // --- Access-token fallback ------------------------------------------
      app.post<{ Body: { token?: unknown; teamId?: unknown; webhookSecret?: unknown } }>(
        "/api/connections/vercel",
        { bodyLimit: 16 * 1024 },
        async (req, reply) => {
          const { token, teamId, webhookSecret } = req.body ?? {};
          if (typeof token !== "string" || token.length < 8 || token.length > 512) {
            return reply.code(400).send({ error: "invalid_token" });
          }
          if (
            teamId !== undefined &&
            teamId !== null &&
            (typeof teamId !== "string" || !ID_PATTERN.test(teamId))
          ) {
            return reply.code(400).send({ error: "invalid_team_id" });
          }
          if (
            webhookSecret !== undefined &&
            (typeof webhookSecret !== "string" ||
              webhookSecret.length < 16 ||
              webhookSecret.length > 512)
          ) {
            return reply.code(400).send({ error: "invalid_webhook_secret" });
          }
          const tenantId = await resolveTenant(req);
          const secret = new Secret(token);
          const client = clientWith(secret);
          let user;
          let name: string;
          try {
            user = await client.getUser();
            name =
              typeof teamId === "string"
                ? await client.getTeam(teamId).then((t) => t.name || t.slug)
                : user.username;
          } catch (err) {
            if (err instanceof VercelApiError && (err.isAuthError || err.status === 404)) {
              return reply.code(400).send({
                error:
                  typeof teamId === "string" && err.status !== 401
                    ? "team_not_accessible"
                    : "token_rejected",
              });
            }
            return sendUpstreamError(reply, err);
          }
          const conn = await saveConnection(ctx, tenantId, {
            name,
            cfg: {
              mode: "token",
              teamId: typeof teamId === "string" ? teamId : null,
              userId: user.id,
              configurationId: null,
            },
            token: secret,
            tokenKind: "vercel_access_token",
            ...(typeof webhookSecret === "string"
              ? { webhookSecret: new Secret(webhookSecret) }
              : {}),
          });
          req.log.info(
            { source: SOURCE, connectionId: conn.id },
            "vercel token connection created",
          );
          return reply.code(201).send({
            connection: publicView(conn),
            warnings: [
              "Vercel access tokens cannot be limited to read-only: this token grants full access to its scope. " +
                "Afe only issues GET requests with it. Prefer the Vercel Integration, scope the token to this one team, " +
                "set an expiry, and create it as a member with the least-privileged role.",
            ],
          });
        },
      );

      // --- Project selection ----------------------------------------------
      app.get<{ Params: { id: string } }>(
        "/api/connections/vercel/:id/projects",
        async (req, reply) => {
          const conn = await loadOwnConnection(ctx, req);
          if (!conn) return reply.code(404).send({ error: "not_found" });
          if (conn.status !== "active")
            return reply.code(409).send({ error: `connection_${conn.status}` });
          const cfg = readVercelConfig(conn);
          try {
            const projects = await withClient(ctx, conn, (client) =>
              client.listProjects(cfg.teamId, { max: 1000 }),
            );
            return {
              selection: cfg.projectSelection,
              projects: projects.map((p) => ({
                id: p.id,
                name: p.name,
                framework: p.framework ?? null,
                updatedAt: p.updatedAt ?? null,
                selected: isProjectSelected(cfg.projectSelection, p.id),
              })),
            };
          } catch (err) {
            return sendUpstreamError(reply, err);
          }
        },
      );

      app.put<{ Params: { id: string }; Body: unknown }>(
        "/api/connections/vercel/:id/projects",
        { bodyLimit: 64 * 1024 },
        async (req, reply) => {
          const conn = await loadOwnConnection(ctx, req);
          if (!conn) return reply.code(404).send({ error: "not_found" });
          if (conn.status !== "active")
            return reply.code(409).send({ error: `connection_${conn.status}` });
          const selection = parseSelectionRequest(req.body);
          if (!selection) {
            return reply.code(400).send({
              error: "invalid_selection",
              message: 'Send {"projects":"all"} or {"projectIds":[...]} (empty list = none).',
            });
          }
          if (selection.mode === "selected") {
            const cfg = readVercelConfig(conn);
            let available: Set<string>;
            try {
              available = new Set(
                (await withClient(ctx, conn, (c) => c.listProjects(cfg.teamId, { max: 1000 }))).map(
                  (p) => p.id,
                ),
              );
            } catch (err) {
              return sendUpstreamError(reply, err);
            }
            const unknown = selection.projectIds.filter((id) => !available.has(id));
            if (unknown.length > 0) {
              return reply.code(400).send({ error: "unknown_projects", projectIds: unknown });
            }
          }
          const updated = await updateConnectionConfig(ctx.pool, conn.tenantId, conn.id, {
            projectSelection: selection as unknown as JsonObject,
          });
          return { selection: readVercelConfig(updated!).projectSelection };
        },
      );

      // --- Disconnect -----------------------------------------------------
      app.delete<{ Params: { id: string } }>("/api/connections/vercel/:id", async (req, reply) => {
        const conn = await loadOwnConnection(ctx, req);
        if (!conn) return reply.code(404).send({ error: "not_found" });
        const cfg = readVercelConfig(conn);
        let integrationRemoved = false;
        if (cfg.mode === "integration" && cfg.configurationId && conn.status === "active") {
          try {
            integrationRemoved = await deleteIntegrationConfiguration({
              token: await loadToken(ctx, conn),
              configurationId: cfg.configurationId,
              teamId: cfg.teamId,
              ...(options.fetch ? { fetch: options.fetch } : {}),
              ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
            });
          } catch {
            integrationRemoved = false;
          }
        }
        await revokeAllCredentials(ctx, conn);
        const updated = await setConnectionStatus(
          ctx.pool,
          conn.tenantId,
          conn.id,
          "disconnected",
          "disconnected by user",
        );
        req.log.info({ source: SOURCE, connectionId: conn.id }, "vercel connection disconnected");
        return {
          connection: publicView(updated!),
          vercelIntegrationRemoved: integrationRemoved,
          ...(cfg.mode === "integration" && !integrationRemoved
            ? {
                note: "Afe deleted its token. Also remove the Afe integration in Vercel (Team Settings > Integrations).",
              }
            : {}),
          ...(cfg.mode === "token"
            ? {
                note: "Afe deleted its copy of the token. Also delete the token in Vercel (Account Settings > Tokens).",
              }
            : {}),
        };
      });

      // --- Webhooks -------------------------------------------------------

      // Integration webhooks: signed with the integration client secret.
      app.post("/webhooks/vercel", { bodyLimit: WEBHOOK_BODY_LIMIT }, async (req, reply) => {
        const vc = ctx.config.vercel;
        if (!vc) return reply.code(404).send({ error: "vercel_integration_not_configured" });
        if (!req.rawBody) return rejectWebhook(req, reply, "no_body");
        const result = verifyVercelWebhook({
          rawBody: req.rawBody,
          signature: req.headers["x-vercel-signature"],
          secret: vc.clientSecret,
          now: now(),
          toleranceMs,
        });
        if (!result.ok) return rejectWebhook(req, reply, result.reason);
        const event = result.event;
        const externalId = event.teamId ?? event.userId;
        const candidates = externalId
          ? await resolveConnectionBySourceIdentity(ctx.pool, SOURCE, externalId)
          : [];
        // Tenant comes only from the stored mapping (R5.4).
        const matches = candidates.filter((c) => {
          const cfg = readVercelConfig(c);
          return (
            cfg.mode === "integration" &&
            (event.configurationId === null || cfg.configurationId === event.configurationId)
          );
        });
        return dispatch(ctx, event, matches);
      });

      // Account webhooks for token connections: URL names the account, the
      // per-connection webhook secret proves it.
      app.post<{ Params: { externalId: string } }>(
        "/webhooks/vercel/:externalId",
        { bodyLimit: WEBHOOK_BODY_LIMIT },
        async (req, reply) => {
          if (!req.rawBody || !ID_PATTERN.test(req.params.externalId)) {
            return rejectWebhook(req, reply, "bad_request");
          }
          const candidates = (
            await resolveConnectionBySourceIdentity(ctx.pool, SOURCE, req.params.externalId)
          ).filter((c) => readVercelConfig(c).mode === "token");
          for (const conn of candidates) {
            const ids = await getConnectionCredentialIds(ctx.pool, conn.tenantId, conn.id);
            const credId = ids[ROLE_WEBHOOK_SECRET];
            const cred = credId
              ? await getCredential(ctx.pool, ctx.keys, conn.tenantId, credId)
              : null;
            if (!cred) continue;
            const result = verifyVercelWebhook({
              rawBody: req.rawBody,
              signature: req.headers["x-vercel-signature"],
              secret: cred.secret,
              now: now(),
              toleranceMs,
            });
            if (!result.ok) {
              if (result.reason === "bad_signature") continue;
              return rejectWebhook(req, reply, result.reason);
            }
            const accountId = result.event.teamId ?? result.event.userId;
            return dispatch(ctx, result.event, accountId === conn.externalId ? [conn] : []);
          }
          return rejectWebhook(req, reply, "bad_signature");
        },
      );
    },
  };
}

/**
 * Builds a project-scoped reader for a Vercel connection (for AFE-12 polling
 * and backfill). Never read Vercel data outside it. The token is loaded at
 * use time. Callers should treat `VercelApiError.isAuthError` as revocation
 * (set the connection status to `revoked`), as the routes and probe do.
 */
export function vercelReader(
  ctx: ServerContext,
  conn: Connection,
  options: Pick<VercelModuleOptions, "fetch" | "apiBaseUrl"> = {},
): ScopedVercelReader {
  const cfg = readVercelConfig(conn);
  const client = new VercelClient({
    token: async () => {
      const ids = await getConnectionCredentialIds(ctx.pool, conn.tenantId, conn.id);
      const id = ids[ROLE_TOKEN];
      const cred = id ? await getCredential(ctx.pool, ctx.keys, conn.tenantId, id) : null;
      if (!cred) throw new MissingCredentialError();
      return cred.secret;
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
  });
  return new ScopedVercelReader(client, cfg.teamId, cfg.projectSelection);
}

export const vercelModule = createVercelModule();
