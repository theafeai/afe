/**
 * GitHub connector wiring (AFE-6): GitHub App webhooks, the install and
 * App Manifest flows, connection lifecycle and health probes.
 *
 * Pure logic (JWT, tokens, REST client, permission checks, manifest, state,
 * event mapping) lives in `@afe/connector-github`. The webhook route
 * verifies, de-duplicates and enqueues repository events as `github.webhook`
 * jobs; `processGitHubWebhook` (AFE-7) maps and ingests them.
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  ACTIONS,
  DEFAULT_TENANT_ID,
  EventValidationError,
  sourceEventId,
  type CanonicalEventInputLike,
  type Connection,
  type ConnectionStatus,
  type ConnectorHealthHooks,
  type JsonObject,
  type ProbeResult,
} from "@afe/core";
import { Secret, verifyGitHubSignature } from "@afe/core/security";
import {
  CONNECTOR_SOURCE,
  GITHUB_HEADERS,
  GITHUB_ROUTES,
  GITHUB_WEBHOOK_JOB,
  GitHubApiError,
  GitHubAppClient,
  GitHubPayloadError,
  GitHubHttp,
  GitHubNetworkError,
  GitHubRateLimitError,
  applyRepositoryChange,
  assertRsaPrivateKey,
  buildAppManifest,
  connectionConfig,
  convertManifestCode,
  deriveStateKey,
  describePermissionProblems,
  installUrl,
  installationIdOf,
  isRepositorySelected,
  loadGitHubAppConfigFromEnv,
  mapWebhookDelivery,
  manifestRegistrationUrl,
  newNonce,
  readDeliveryHeaders,
  readOnlyTokenPermissions,
  repositoryIdOf,
  signState,
  toJson,
  verifyState,
  type GitHubAppConfig,
  type GitHubConnectionConfig,
  type GitHubHttpOptions,
  type GitHubInstallation,
  type GitHubUser,
  type GitHubWebhookJob,
  type InstallationEventPayload,
  type InstallationRepositoriesEventPayload,
  type StatePurpose,
} from "@afe/connector-github";
import {
  findConnectionByExternalId,
  getConnection,
  getCredential,
  recordDelivery,
  resolveConnectionBySourceIdentity,
  setConnectionStatus,
  storeCredential,
  upsertConnection,
} from "@afe/db";
import type { ConnectorModule, ServerContext } from "../context.ts";

type Db = pg.Pool | pg.PoolClient;

export interface GitHubModuleOptions {
  /**
   * App credentials. Default: from the environment (AFE_GITHUB_APP_*), else
   * the App registered through the manifest flow (stored encrypted in the
   * database). `null` forces "not configured".
   */
  app?: GitHubAppConfig | null;
  env?: NodeJS.ProcessEnv;
  /** Transport options (inject `fetch` in tests). */
  http?: GitHubHttpOptions;
  /** Public base URL of this instance (AFE_PUBLIC_URL); needed for the manifest flow. */
  publicUrl?: string;
  /**
   * Tenant of an authenticated install/manifest request. Until the
   * AuthProvider/TenantResolver land, the default is the built-in tenant.
   */
  resolveTenant?: (req: FastifyRequest) => string | Promise<string>;
  /**
   * Single-tenant self-host: installations of this App that were not started
   * from Afe (no `state`) are connected to this tenant. The hosted service
   * passes null so an installation is only ever claimed through a signed,
   * browser-bound state. Default: DEFAULT_TENANT_ID unless
   * AFE_GITHUB_ADOPT_INSTALLATIONS=false.
   */
  adoptInstallationsInto?: string | null;
  /** Allow the App Manifest flow while no App is configured. Default true. */
  manifestFlow?: boolean;
  /** Tenant that owns a manifest-registered App's credentials. Default DEFAULT_TENANT_ID. */
  appTenantId?: string;
  /** Key material for signing redirect state (AFE_GITHUB_STATE_SECRET). */
  stateSecret?: string;
  /**
   * Processes one `github.webhook` job (repository events). Default:
   * `processGitHubWebhook` (map and ingest, AFE-7). Override in tests.
   */
  processWebhook?: (job: GitHubWebhookJob, runtime: GitHubRuntime) => Promise<unknown>;
  clock?: () => number;
}

/** GitHub caps webhook payloads at 25 MB. */
const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;
const FLOW_COOKIE = "afe_github_flow";
const DB_APP_TTL_MS = 60_000;
const LIFECYCLE = new Set(["installation", "installation_repositories"]);

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Resolved App plus its client. One client per App so the token cache is shared. */
export interface ResolvedApp {
  config: GitHubAppConfig;
  client: GitHubAppClient;
  origin: "env" | "options" | "database";
}

/** Per-server GitHub state: App config, client and token cache. */
export class GitHubRuntime {
  #resolved: ResolvedApp | null = null;
  #loadedAt = 0;
  #fallbackStateKey = deriveStateKey(randomUUID());
  readonly manifestHttp: GitHubHttp;

  constructor(
    readonly ctx: ServerContext,
    readonly options: GitHubModuleOptions,
    private readonly envApp: GitHubAppConfig | null,
  ) {
    this.manifestHttp = new GitHubHttp(options.http);
  }

  get clock(): () => number {
    return this.options.clock ?? Date.now;
  }

  get appTenantId(): string {
    return this.options.appTenantId ?? DEFAULT_TENANT_ID;
  }

  get adoptTenant(): string | null {
    if (this.options.adoptInstallationsInto !== undefined) {
      return this.options.adoptInstallationsInto;
    }
    const env = this.options.env ?? process.env;
    return env.AFE_GITHUB_ADOPT_INSTALLATIONS === "false" ? null : DEFAULT_TENANT_ID;
  }

  get publicUrl(): string | null {
    const env = this.options.env ?? process.env;
    const url = this.options.publicUrl ?? env.AFE_PUBLIC_URL;
    return url ? url.replace(/\/+$/, "") : null;
  }

  /** The configured App, or null. Database-registered Apps are re-read every minute. */
  async app(): Promise<ResolvedApp | null> {
    if (this.options.app === null) return null;
    const fixed = this.options.app ?? this.envApp;
    if (fixed) {
      this.#resolved ??= {
        config: fixed,
        client: new GitHubAppClient(fixed, this.options.http),
        origin: this.options.app ? "options" : "env",
      };
      return this.#resolved;
    }
    if (this.#resolved && this.clock() - this.#loadedAt < DB_APP_TTL_MS) return this.#resolved;
    const config = await loadRegisteredApp(this.ctx, this.appTenantId);
    this.#loadedAt = this.clock();
    if (!config) return (this.#resolved = null);
    const prev = this.#resolved;
    const same =
      prev &&
      prev.config.appId === config.appId &&
      prev.config.privateKey.reveal() === config.privateKey.reveal();
    this.#resolved = {
      config,
      client: same ? prev.client : new GitHubAppClient(config, this.options.http),
      origin: "database",
    };
    return this.#resolved;
  }

  invalidate(): void {
    this.#loadedAt = 0;
  }

  async stateKey(): Promise<Buffer> {
    const env = this.options.env ?? process.env;
    const secret = this.options.stateSecret ?? env.AFE_GITHUB_STATE_SECRET;
    if (secret) return deriveStateKey(secret);
    const app = await this.app();
    return app ? deriveStateKey(app.config.privateKey) : this.#fallbackStateKey;
  }

  /** Installation client narrowed to read-only versions of the granted permissions. */
  async installationClient(connection: Connection) {
    const app = await this.app();
    if (!app) throw new Error("GitHub App is not configured");
    const config = connection.config as unknown as Partial<GitHubConnectionConfig>;
    return app.client.installation(connection.externalId, {
      tenantId: connection.tenantId,
      permissions: readOnlyTokenPermissions(config.permissions),
    });
  }
}

const runtimes = new WeakMap<ServerContext, GitHubRuntime>();

// ---------------------------------------------------------------------------
// Manifest-registered App storage (migration 0005_github_apps.sql)
// ---------------------------------------------------------------------------

interface GitHubAppRow {
  app_id: string;
  slug: string;
  client_id: string | null;
  private_key_credential_id: string;
  webhook_secret_credential_id: string;
}

async function loadRegisteredApp(
  ctx: ServerContext,
  tenantId: string,
): Promise<GitHubAppConfig | null> {
  const { rows } = await ctx.pool.query<GitHubAppRow>(
    `SELECT app_id, slug, client_id, private_key_credential_id, webhook_secret_credential_id
       FROM github_apps WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) return null;
  const key = await getCredential(ctx.pool, ctx.keys, tenantId, row.private_key_credential_id);
  const hook = await getCredential(ctx.pool, ctx.keys, tenantId, row.webhook_secret_credential_id);
  if (!key || !hook) return null; // revoked
  return {
    appId: String(row.app_id),
    slug: row.slug,
    privateKey: key.secret,
    webhookSecret: hook.secret,
    ...(row.client_id ? { clientId: row.client_id } : {}),
  };
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

interface LifecycleContext {
  deliveryId: string;
  rawBody: string;
  observedAt: Date;
}

function actorOf(sender: GitHubUser | undefined): CanonicalEventInputLike["actor"] {
  if (!sender) return { type: "unknown" };
  return {
    type: sender.type === "Bot" ? "bot" : "user",
    id: String(sender.id),
    login: sender.login,
  };
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function connectionEvent(p: {
  action: string;
  connection: Connection;
  idParts: (string | number)[];
  installation: GitHubInstallation;
  sender?: GitHubUser;
  data: JsonObject;
  observation: CanonicalEventInputLike["observation"];
  observedAt: Date;
  occurredAt?: string | null;
  rawBody?: string;
}): CanonicalEventInputLike {
  return {
    source: "afe",
    sourceEventId: sourceEventId("connection", p.connection.id, ...p.idParts),
    connectionId: p.connection.id,
    action: p.action,
    actor: actorOf(p.sender),
    target: { type: "connection", id: p.connection.id, name: p.connection.name },
    trigger: p.sender
      ? { type: "manual", sourceValue: "github_app_installation" }
      : { type: "system", sourceValue: "github_app_installation" },
    outcome: "none",
    occurredAt: p.occurredAt ?? p.observedAt,
    observedAt: p.observedAt,
    observation: p.observation,
    data: {
      source: CONNECTOR_SOURCE,
      installationId: p.installation.id,
      account: p.installation.account?.login ?? null,
      ...p.data,
    },
    ...(p.rawBody ? { rawPayload: { contentType: "application/json", body: p.rawBody } } : {}),
  };
}

/** Writes status + reason; an active connection carries any permission problem as its reason. */
async function applyStatus(
  db: Db,
  connection: Connection,
  status: ConnectionStatus,
  reason: string | null,
): Promise<Connection> {
  const check = (connection.config as unknown as Partial<GitHubConnectionConfig>).permissionCheck;
  const permReason = check && status === "active" ? describePermissionProblems(check) : null;
  return (
    (await setConnectionStatus(
      db,
      connection.tenantId,
      connection.id,
      status,
      reason ?? permReason,
    )) ?? connection
  );
}

async function upsertInstallation(
  db: Db,
  tenantId: string,
  installation: GitHubInstallation,
  repositories: { id: number; full_name: string }[] | null,
): Promise<Connection> {
  const config = connectionConfig(installation, repositories);
  const conn = await upsertConnection(db, tenantId, {
    source: CONNECTOR_SOURCE,
    externalId: String(installation.id),
    name: config.account.login,
    status: installation.suspended_at ? "suspended" : "active",
    config: toJson(config),
  });
  return applyStatus(
    db,
    conn,
    conn.status,
    installation.suspended_at ? "installation suspended on GitHub" : null,
  );
}

function warnOnPermissions(ctx: ServerContext, connection: Connection): void {
  const check = (connection.config as unknown as GitHubConnectionConfig).permissionCheck;
  if (check && !check.ok) {
    ctx.log.warn(
      { connectionId: connection.id, missing: check.missing, writable: check.writable },
      "github installation permission check failed",
    );
  }
}

/**
 * Applies an `installation` or `installation_repositories` delivery inside the
 * caller's transaction and returns the audit events to ingest.
 */
async function applyLifecycle(
  rt: GitHubRuntime,
  db: Db,
  event: string,
  payload: InstallationEventPayload | InstallationRepositoriesEventPayload,
  lc: LifecycleContext,
): Promise<{ tenantId: string | null; events: [string, CanonicalEventInputLike][] }> {
  const { ctx } = rt;
  const installation = payload.installation;
  const existing = await resolveConnectionBySourceIdentity(
    db,
    CONNECTOR_SOURCE,
    String(installation.id),
  );
  const events: [string, CanonicalEventInputLike][] = [];
  const observation = { method: "webhook" as const, deliveryId: lc.deliveryId };
  const common = {
    installation,
    observation,
    observedAt: lc.observedAt,
    rawBody: lc.rawBody,
    ...(payload.sender ? { sender: payload.sender } : {}),
  };
  const app = await rt.app();

  if (event === "installation") {
    const p = payload as InstallationEventPayload;
    if (p.action === "created") {
      const targets = existing.length > 0 ? existing.map((c) => c.tenantId) : [];
      if (targets.length === 0 && rt.adoptTenant) targets.push(rt.adoptTenant);
      for (const tenantId of targets) {
        const conn = await upsertInstallation(db, tenantId, installation, p.repositories ?? null);
        warnOnPermissions(ctx, conn);
        const config = conn.config as unknown as GitHubConnectionConfig;
        events.push([
          tenantId,
          connectionEvent({
            ...common,
            action: ACTIONS.CONNECTION_CREATED,
            connection: conn,
            idParts: ["created"],
            occurredAt: installation.created_at ?? null,
            data: {
              repositorySelection: config.repositorySelection,
              repositories: toJson(config).repositories ?? null,
              permissions: config.permissions,
              permissionCheck: toJson(config).permissionCheck ?? null,
            },
          }),
        ]);
      }
      return { tenantId: targets.length === 1 ? targets[0]! : null, events };
    }

    for (const conn of existing) {
      const prevConfig = conn.config as unknown as Partial<GitHubConnectionConfig>;
      let updated: Connection;
      let action: string;
      let idParts: (string | number)[];
      let data: JsonObject = {};
      switch (p.action) {
        case "deleted":
          await upsertKeepingRepos(db, conn, installation, prevConfig);
          updated = await applyStatus(db, conn, "revoked", "GitHub App uninstalled");
          action = ACTIONS.CONNECTION_REVOKED;
          idParts = ["revoked"];
          break;
        case "suspend": {
          const at = installation.suspended_at ?? installation.updated_at ?? lc.deliveryId;
          await upsertKeepingRepos(db, conn, installation, prevConfig);
          updated = await applyStatus(db, conn, "suspended", "installation suspended on GitHub");
          action = ACTIONS.CONNECTION_SUSPENDED;
          idParts = ["suspended", at];
          data = { suspendedBy: installation.suspended_by?.login ?? null };
          break;
        }
        case "unsuspend": {
          const fresh = await upsertKeepingRepos(db, conn, installation, prevConfig);
          updated = await applyStatus(db, fresh, "active", null);
          action = ACTIONS.CONNECTION_RESUMED;
          idParts = ["resumed", installation.updated_at ?? lc.deliveryId];
          break;
        }
        case "new_permissions_accepted": {
          const fresh = await upsertKeepingRepos(db, conn, installation, prevConfig);
          updated = await applyStatus(
            db,
            fresh,
            conn.status === "suspended" ? "suspended" : "active",
            conn.status === "suspended" ? conn.statusReason : null,
          );
          const cfg = updated.config as unknown as GitHubConnectionConfig;
          action = ACTIONS.CONNECTION_UPDATED;
          idParts = ["permissions", installation.updated_at ?? lc.deliveryId];
          data = {
            change: "permissions",
            previousPermissions: (prevConfig.permissions ?? {}) as JsonObject,
            permissions: cfg.permissions,
            events: cfg.events,
            permissionCheck: toJson(cfg).permissionCheck ?? null,
          };
          warnOnPermissions(ctx, updated);
          break;
        }
        default:
          continue;
      }
      app?.client.tokens.invalidate(installation.id);
      events.push([
        conn.tenantId,
        connectionEvent({ ...common, action, connection: updated, idParts, data }),
      ]);
    }
    return { tenantId: existing.length === 1 ? existing[0]!.tenantId : null, events };
  }

  // installation_repositories
  const p = payload as InstallationRepositoriesEventPayload;
  if (p.action !== "added" && p.action !== "removed") return { tenantId: null, events };
  for (const conn of existing) {
    const prevConfig = conn.config as unknown as Partial<GitHubConnectionConfig>;
    const repositories = applyRepositoryChange(prevConfig.repositories, p);
    const config = connectionConfig(
      { ...installation, repository_selection: p.repository_selection },
      repositories === "all"
        ? null
        : repositories.map((r) => ({ id: r.id, full_name: r.fullName })),
    );
    const fresh = await upsertConnection(db, conn.tenantId, {
      source: CONNECTOR_SOURCE,
      externalId: conn.externalId,
      name: config.account.login,
      status: conn.status,
      config: toJson(config),
    });
    const updated = await applyStatus(
      db,
      fresh,
      conn.status,
      conn.status === "active" ? null : conn.statusReason,
    );
    const added = (p.repositories_added ?? []).map((r) => r.full_name).sort();
    const removed = (p.repositories_removed ?? []).map((r) => r.full_name).sort();
    events.push([
      conn.tenantId,
      connectionEvent({
        ...common,
        action: ACTIONS.CONNECTION_UPDATED,
        connection: updated,
        idParts: [
          "repositories",
          p.action,
          shortHash([p.repository_selection, added, removed, installation.updated_at ?? null]),
        ],
        data: {
          change: "repositories",
          repositorySelection: p.repository_selection,
          added,
          removed,
        },
      }),
    ]);
  }
  return { tenantId: existing.length === 1 ? existing[0]!.tenantId : null, events };
}

/** Refreshes config from the installation object while keeping the stored repository list. */
async function upsertKeepingRepos(
  db: Db,
  conn: Connection,
  installation: GitHubInstallation,
  prev: Partial<GitHubConnectionConfig>,
): Promise<Connection> {
  const repos = prev.repositories;
  const config = connectionConfig(
    installation,
    Array.isArray(repos) ? repos.map((r) => ({ id: r.id, full_name: r.fullName })) : null,
  );
  return upsertConnection(db, conn.tenantId, {
    source: CONNECTOR_SOURCE,
    externalId: conn.externalId,
    name: config.account.login,
    status: conn.status,
    config: toJson(config),
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function flowCookie(rt: GitHubRuntime, req: FastifyRequest, value: string, maxAge: number) {
  const secure = rt.publicUrl?.startsWith("https://") || req.protocol === "https";
  return [
    `${FLOW_COOKIE}=${value}`,
    "Path=/api/connections/github",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

async function startFlow(
  rt: GitHubRuntime,
  req: FastifyRequest,
  reply: FastifyReply,
  purpose: StatePurpose,
): Promise<string> {
  const tenantId = await (rt.options.resolveTenant?.(req) ?? DEFAULT_TENANT_ID);
  const nonce = newNonce();
  const state = signState(await rt.stateKey(), { purpose, tenantId, nonce }, rt.clock());
  reply.header("set-cookie", flowCookie(rt, req, nonce, 15 * 60));
  reply.header("cache-control", "no-store");
  return state;
}

async function checkFlow(
  rt: GitHubRuntime,
  req: FastifyRequest,
  state: unknown,
  purpose: StatePurpose,
) {
  const result = verifyState(
    await rt.stateKey(),
    state,
    { purpose, nonce: readCookie(req, FLOW_COOKIE) },
    rt.clock(),
  );
  if (!result.ok) {
    req.log.warn({ reason: result.reason, purpose }, "github redirect state rejected");
    throw new HttpError(400, "invalid or expired state");
  }
  return result.payload;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

async function ingestAll(ctx: ServerContext, events: [string, CanonicalEventInputLike][]) {
  for (const [tenantId, input] of events) await ctx.sink.ingest(tenantId, input);
}

async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

class Replay extends Error {}

async function handleWebhook(rt: GitHubRuntime, req: FastifyRequest, reply: FastifyReply) {
  const { ctx } = rt;
  const app = await rt.app();
  if (!app) return reply.code(503).send({ error: "GitHub App is not configured" });
  const raw = req.rawBody;
  const deliveryHeader = req.headers[GITHUB_HEADERS.delivery];
  const deliveryForLog = typeof deliveryHeader === "string" ? deliveryHeader.slice(0, 128) : null;
  if (
    !raw ||
    !verifyGitHubSignature(raw, app.config.webhookSecret, req.headers[GITHUB_HEADERS.signature])
  ) {
    req.log.warn({ source: "github", deliveryId: deliveryForLog }, "webhook signature rejected");
    return reply.code(401).send({ error: "invalid signature" });
  }
  const delivery = readDeliveryHeaders(req.headers);
  const payload = req.body as JsonObject | undefined;
  if (!delivery || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return reply.code(400).send({ error: "malformed delivery" });
  }
  const log = req.log.child({
    source: "github",
    deliveryId: delivery.deliveryId,
    event: delivery.event,
  });
  const receivedAt = new Date(rt.clock());

  if (delivery.event === "ping") return reply.code(200).send({ ok: true });

  if (LIFECYCLE.has(delivery.event)) {
    try {
      const outcome = await withTransaction(ctx.pool, async (client) => {
        const p = payload as unknown as InstallationEventPayload;
        if (!installationIdOf(p)) throw new HttpError(400, "malformed delivery");
        const known = await resolveConnectionBySourceIdentity(
          client,
          CONNECTOR_SOURCE,
          String(p.installation.id),
        );
        const tenantHint =
          known.length === 1 ? known[0]!.tenantId : known.length === 0 ? rt.adoptTenant : null;
        const fresh = await recordDelivery(
          client,
          tenantHint,
          CONNECTOR_SOURCE,
          delivery.deliveryId,
          receivedAt,
        );
        if (!fresh) throw new Replay();
        const result = await applyLifecycle(rt, client, delivery.event, p, {
          deliveryId: delivery.deliveryId,
          rawBody: raw.toString("utf8"),
          observedAt: receivedAt,
        });
        // Ingest before commit: if it fails, the delivery is not recorded and a
        // redelivery is processed again (ingestion is idempotent).
        await ingestAll(ctx, result.events);
        return result;
      });
      log.info(
        { action: (payload as { action?: unknown }).action, changes: outcome.events.length },
        "github lifecycle event applied",
      );
      return reply
        .code(outcome.events.length > 0 ? 200 : 202)
        .send({ ok: true, applied: outcome.events.length });
    } catch (err) {
      if (err instanceof Replay) return reply.code(200).send({ ok: true, duplicate: true });
      throw err;
    }
  }

  if (delivery.event === "github_app_authorization") {
    // A user revoked their OAuth authorization of the App. Afe does not use
    // user-to-server tokens, so there is nothing to change.
    const fresh = await recordDelivery(
      ctx.pool,
      null,
      CONNECTOR_SOURCE,
      delivery.deliveryId,
      receivedAt,
    );
    return reply.code(fresh ? 202 : 200).send({ ok: true, ...(fresh ? {} : { duplicate: true }) });
  }

  // Repository events: hand over to the github.webhook job (AFE-7).
  const installationId = installationIdOf(payload);
  const connections = installationId
    ? (
        await resolveConnectionBySourceIdentity(ctx.pool, CONNECTOR_SOURCE, String(installationId))
      ).filter((c) => c.status === "active")
    : [];
  const tenantHint = connections.length === 1 ? connections[0]!.tenantId : null;
  try {
    await withTransaction(ctx.pool, async (client) => {
      const fresh = await recordDelivery(
        client,
        tenantHint,
        CONNECTOR_SOURCE,
        delivery.deliveryId,
        receivedAt,
      );
      if (!fresh) throw new Replay();
      const rawBody = raw.toString("utf8");
      for (const conn of connections) {
        const job: GitHubWebhookJob = {
          tenantId: conn.tenantId,
          connectionId: conn.id,
          installationId: installationId!,
          deliveryId: delivery.deliveryId,
          event: delivery.event,
          action: typeof payload.action === "string" ? payload.action : null,
          receivedAt: receivedAt.toISOString(),
          payload,
          rawBody,
        };
        await ctx.jobs.send(GITHUB_WEBHOOK_JOB, job, {
          singletonKey: `${delivery.deliveryId}:${conn.tenantId}:${conn.id}`,
        });
      }
    });
  } catch (err) {
    if (err instanceof Replay) return reply.code(200).send({ ok: true, duplicate: true });
    throw err;
  }
  if (connections.length === 0) {
    log.info({ installationId }, "github delivery for unknown or inactive installation ignored");
    return reply.code(202).send({ ok: true, queued: 0 });
  }
  return reply.code(202).send({ ok: true, queued: connections.length });
}

/** A browser navigation (not an API client) asks for HTML. */
function wantsHtml(req: FastifyRequest): boolean {
  return String(req.headers.accept ?? "").includes("text/html");
}

/** Where the web UI (AFE-16) shows the result of the install flow. */
function uiUrl(rt: GitHubRuntime, path: string): string {
  return `${rt.publicUrl ?? ""}${path}`;
}

/**
 * Setup URL handler. API clients get JSON; a browser coming back from GitHub
 * is redirected to the web UI (`/connections/<id>`, or `/connections/github`
 * with `status` / `error`) so the install flow ends on a page, not on JSON.
 */
async function handleSetupForBrowser(rt: GitHubRuntime, req: FastifyRequest, reply: FastifyReply) {
  if (!wantsHtml(req)) return handleSetup(rt, req, reply);
  try {
    await handleSetup(rt, req, reply);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return reply.redirect(
      uiUrl(rt, `/connections/github?error=${encodeURIComponent(err.message)}`),
      303,
    );
  }
  return reply;
}

async function handleSetup(rt: GitHubRuntime, req: FastifyRequest, reply: FastifyReply) {
  const { ctx } = rt;
  const q = req.query as Record<string, string | undefined>;
  const app = await rt.app();
  if (!app) throw new HttpError(503, "GitHub App is not configured");

  let tenantId: string;
  let flowStartedAt: number | null = null;
  if (q.state !== undefined) {
    const state = await checkFlow(rt, req, q.state, "install");
    tenantId = state.tenantId;
    flowStartedAt = state.exp - 15 * 60_000;
  } else if (rt.adoptTenant) {
    tenantId = rt.adoptTenant;
  } else {
    throw new HttpError(400, "invalid or expired state");
  }
  reply.header("set-cookie", flowCookie(rt, req, "", 0));
  reply.header("cache-control", "no-store");

  if (q.setup_action === "request") {
    if (wantsHtml(req)) {
      return reply.redirect(uiUrl(rt, "/connections/github?status=pending_approval"), 303);
    }
    return reply.code(202).send({ status: "pending_approval" });
  }
  if (!q.installation_id || !/^[1-9][0-9]{0,18}$/.test(q.installation_id)) {
    throw new HttpError(400, "missing installation_id");
  }

  let installation: GitHubInstallation;
  try {
    installation = await app.client.getInstallation(q.installation_id);
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      throw new HttpError(400, "unknown installation");
    }
    throw err;
  }
  if (String(installation.app_id) !== app.config.appId) {
    throw new HttpError(400, "unknown installation");
  }

  const claimed = await resolveConnectionBySourceIdentity(
    ctx.pool,
    CONNECTOR_SOURCE,
    String(installation.id),
  );
  const mine = claimed.find((c) => c.tenantId === tenantId);
  if (!mine) {
    if (claimed.some((c) => c.status === "active" || c.status === "suspended")) {
      throw new HttpError(409, "installation is connected elsewhere");
    }
    // A new claim must come from a flow that started before the installation
    // was created, so a guessed or old installation id cannot be claimed.
    if (flowStartedAt !== null && installation.created_at) {
      if (Date.parse(installation.created_at) < flowStartedAt - 60_000) {
        throw new HttpError(400, "installation predates this install flow");
      }
    }
  }

  let repos: { id: number; full_name: string }[] | null = null;
  if (installation.repository_selection === "selected") {
    repos = await app.client
      .installation(installation.id, {
        tenantId,
        permissions: readOnlyTokenPermissions(installation.permissions),
      })
      .listRepositories();
  }

  const observedAt = new Date(rt.clock());
  const conn = await withTransaction(ctx.pool, async (client) => {
    const existing = await findConnectionByExternalId(
      client,
      tenantId,
      CONNECTOR_SOURCE,
      String(installation.id),
    );
    const conn = await upsertInstallation(client, tenantId, installation, repos);
    if (!existing || existing.status === "revoked" || existing.status === "disconnected") {
      const config = conn.config as unknown as GitHubConnectionConfig;
      await ctx.sink.ingest(
        tenantId,
        connectionEvent({
          action: ACTIONS.CONNECTION_CREATED,
          connection: conn,
          idParts: ["created"],
          installation,
          observation: { method: "internal", detail: "GitHub App install setup callback" },
          observedAt,
          occurredAt: installation.created_at ?? null,
          data: {
            repositorySelection: config.repositorySelection,
            repositories: toJson(config).repositories ?? null,
            permissions: config.permissions,
            permissionCheck: toJson(config).permissionCheck ?? null,
          },
        }),
      );
    }
    return conn;
  });
  warnOnPermissions(ctx, conn);
  const config = conn.config as unknown as GitHubConnectionConfig;
  if (wantsHtml(req)) {
    return reply.redirect(uiUrl(rt, `/connections/${conn.id}?connected=github`), 303);
  }
  return reply.code(200).send({
    connection: {
      id: conn.id,
      source: conn.source,
      name: conn.name,
      status: conn.status,
      statusReason: conn.statusReason,
      repositorySelection: config.repositorySelection,
      repositories: config.repositories,
      permissionCheck: config.permissionCheck,
    },
  });
}

async function handleManifest(rt: GitHubRuntime, req: FastifyRequest, reply: FastifyReply) {
  if (rt.options.manifestFlow === false) throw new HttpError(404, "not found");
  if (await rt.app()) throw new HttpError(409, "a GitHub App is already configured");
  const publicUrl = rt.publicUrl;
  if (!publicUrl) throw new HttpError(500, "set AFE_PUBLIC_URL to use the manifest flow");
  const q = req.query as Record<string, string | undefined>;
  const org = q.org && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(q.org) ? q.org : undefined;
  if (q.org !== undefined && !org) throw new HttpError(400, "invalid org");
  const name = q.name && /^[\w .-]{1,34}$/.test(q.name) ? q.name : undefined;
  const state = await startFlow(rt, req, reply, "manifest");
  const manifest = buildAppManifest({ publicUrl, ...(name ? { name } : {}) });
  const action = manifestRegistrationUrl(state, org);
  const body =
    `<h1>Register the Afe GitHub App</h1>` +
    `<p>This creates a private GitHub App ${org ? `owned by <b>${escapeHtml(org)}</b>` : "owned by your account"} with read-only permissions: ` +
    `${escapeHtml(
      Object.entries(manifest.default_permissions)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", "),
    )}.</p>` +
    `<form method="post" action="${escapeHtml(action)}">` +
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
    `<button type="submit">Create GitHub App</button></form>`;
  return reply
    .code(200)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", "default-src 'none'; form-action https://github.com")
    .send(htmlPage("Register GitHub App", body));
}

async function handleManifestCallback(rt: GitHubRuntime, req: FastifyRequest, reply: FastifyReply) {
  const { ctx } = rt;
  if (rt.options.manifestFlow === false) throw new HttpError(404, "not found");
  const q = req.query as Record<string, string | undefined>;
  const flow = await checkFlow(rt, req, q.state, "manifest");
  reply.header("set-cookie", flowCookie(rt, req, "", 0));
  reply.header("cache-control", "no-store");
  if (await rt.app()) throw new HttpError(409, "a GitHub App is already configured");
  if (!q.code || !/^[A-Za-z0-9_-]{1,128}$/.test(q.code)) throw new HttpError(400, "missing code");

  // Conversion is unauthenticated; the code is single-use and expires in an hour.
  const conv = await convertManifestCode(rt.manifestHttp, q.code);
  if (!conv.webhook_secret) throw new HttpError(502, "GitHub did not return a webhook secret");
  assertRsaPrivateKey(conv.pem);
  const tenantId = rt.appTenantId;
  if (flow.tenantId !== tenantId) {
    req.log.warn({ tenantId: flow.tenantId }, "manifest flow started for another tenant");
  }
  await withTransaction(ctx.pool, async (client) => {
    const key = await storeCredential(client, ctx.keys, tenantId, {
      kind: "github_app_private_key",
      secret: new Secret(conv.pem),
    });
    const hook = await storeCredential(client, ctx.keys, tenantId, {
      kind: "github_webhook_secret",
      secret: new Secret(conv.webhook_secret!),
    });
    const oauth = conv.client_secret
      ? await storeCredential(client, ctx.keys, tenantId, {
          kind: "github_app_client_secret",
          secret: new Secret(conv.client_secret),
        })
      : null;
    await client.query(
      `INSERT INTO github_apps (tenant_id, id, app_id, slug, name, client_id, owner_login, html_url,
         private_key_credential_id, webhook_secret_credential_id, client_secret_credential_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        randomUUID(),
        conv.id,
        conv.slug,
        conv.name,
        conv.client_id ?? null,
        conv.owner?.login ?? null,
        conv.html_url ?? null,
        key.id,
        hook.id,
        oauth?.id ?? null,
      ],
    );
  });
  rt.invalidate();
  req.log.info({ appId: conv.id, slug: conv.slug }, "github app registered via manifest");
  const body =
    `<h1>GitHub App created</h1>` +
    `<p>The App <b>${escapeHtml(conv.name)}</b> (${escapeHtml(conv.slug)}) is registered and its credentials are stored encrypted.</p>` +
    `<p><a href="${GITHUB_ROUTES.install}">Install it on an organization</a></p>`;
  return reply
    .code(200)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", "default-src 'none'")
    .send(htmlPage("GitHub App created", body));
}

// ---------------------------------------------------------------------------
// Repository events (AFE-7)
// ---------------------------------------------------------------------------

export type GitHubWebhookOutcome =
  | { status: "ingested"; inserted: number; duplicates: number }
  | { status: "ignored"; reason: string }
  | { status: "rejected"; reason: string };

/**
 * Default `github.webhook` processor: maps one verified delivery into
 * canonical events and ingests them idempotently for the job's tenant.
 *
 * - Deliveries for a connection that no longer exists, for repositories not
 *   selected in the connection config, and events/actions Afe does not record
 *   are ignored.
 * - A malformed payload (`GitHubPayloadError`) or a mapping that fails
 *   validation (`EventValidationError`) is permanent: it is logged (delivery
 *   id, event and issue paths only, never the payload) and the job completes
 *   so it is not retried. The delivery can be redelivered from GitHub after a fix.
 * - Any other error (database) propagates and the job is retried; ingestion
 *   is idempotent.
 * - Every delivery processed without error counts as a successful webhook
 *   observation for connection health.
 */
export async function processGitHubWebhook(
  job: GitHubWebhookJob,
  rt: GitHubRuntime,
): Promise<GitHubWebhookOutcome> {
  const { ctx } = rt;
  const log = ctx.log.child({
    source: "github",
    deliveryId: job.deliveryId,
    event: job.event,
    connectionId: job.connectionId,
  });
  const connection = await getConnection(ctx.pool, job.tenantId, job.connectionId);
  if (!connection || connection.source !== CONNECTOR_SOURCE) {
    log.info("github.webhook: connection not found, delivery ignored");
    return { status: "ignored", reason: "connection not found" };
  }
  const receivedAt = new Date(job.receivedAt);
  const done = async <T extends GitHubWebhookOutcome>(outcome: T): Promise<T> => {
    if (connection.status === "active") {
      await ctx.health?.reportSuccess(job.tenantId, job.connectionId, receivedAt, {
        via: "webhook",
      });
    }
    return outcome;
  };

  const repositoryId = repositoryIdOf(job.payload);
  if (repositoryId !== null && !isRepositorySelected(connection.config, repositoryId)) {
    log.info({ repositoryId }, "github.webhook: repository not selected, delivery ignored");
    return done({ status: "ignored", reason: "repository not selected" });
  }

  try {
    const result = mapWebhookDelivery({
      event: job.event,
      payload: job.payload,
      rawBody: job.rawBody,
      deliveryId: job.deliveryId,
      receivedAt,
      connectionId: connection.id,
    });
    if (result.status === "ignored") {
      log.debug({ reason: result.reason }, "github.webhook: delivery not recorded");
      return done({ status: "ignored", reason: result.reason });
    }
    let inserted = 0;
    for (const input of result.events) {
      const r = await ctx.sink.ingest(job.tenantId, input);
      if (r.inserted) inserted += 1;
    }
    log.info(
      { action: job.action, inserted, duplicates: result.events.length - inserted },
      "github.webhook: delivery ingested",
    );
    return done({ status: "ingested", inserted, duplicates: result.events.length - inserted });
  } catch (err) {
    if (err instanceof GitHubPayloadError) {
      log.error({ path: err.path }, "github.webhook: malformed payload, delivery dropped");
      return { status: "rejected", reason: err.message };
    }
    if (err instanceof EventValidationError) {
      log.error(
        { issues: err.issues.map((i) => ({ path: i.path.join("."), code: i.code })) },
        "github.webhook: mapped event failed validation, delivery dropped",
      );
      return { status: "rejected", reason: "event validation failed" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function probeInstallation(
  rt: GitHubRuntime,
  connection: Connection,
): Promise<ProbeResult> {
  const app = await rt.app();
  if (!app) return { ok: false, reason: "error", detail: "GitHub App is not configured" };
  try {
    const installation = await app.client.getInstallation(connection.externalId);
    if (installation.suspended_at) {
      return { ok: false, reason: "unauthorized", detail: "installation suspended on GitHub" };
    }
    await app.client.tokens.get({
      tenantId: connection.tenantId,
      installationId: connection.externalId,
      permissions: readOnlyTokenPermissions(installation.permissions),
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof GitHubRateLimitError) {
      return { ok: false, reason: "rate_limited", retryAfter: err.retryAfter };
    }
    if (err instanceof GitHubNetworkError)
      return { ok: false, reason: "unreachable", detail: err.message };
    if (err instanceof GitHubApiError) {
      if (err.status === 404)
        return { ok: false, reason: "revoked", detail: "installation not found (uninstalled)" };
      if (err.status === 401 || err.status === 403) {
        return { ok: false, reason: "unauthorized", detail: `GitHub returned ${err.status}` };
      }
      return { ok: false, reason: "error", detail: `GitHub returned ${err.status}` };
    }
    return { ok: false, reason: "error", detail: "probe failed" };
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export function createGitHubModule(options: GitHubModuleOptions = {}): ConnectorModule {
  let envApp: GitHubAppConfig | null | undefined;
  const runtime = (ctx: ServerContext): GitHubRuntime => {
    let rt = runtimes.get(ctx);
    if (!rt) {
      envApp ??=
        options.app === undefined ? loadGitHubAppConfigFromEnv(options.env ?? process.env) : null;
      rt = new GitHubRuntime(ctx, options, envApp);
      runtimes.set(ctx, rt);
    }
    return rt;
  };

  return {
    source: CONNECTOR_SOURCE,

    routes(app, ctx) {
      // Fail fast on a partly configured environment.
      const rt = runtime(ctx);
      const wrap =
        (fn: (rt: GitHubRuntime, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
        async (req: FastifyRequest, reply: FastifyReply) => {
          try {
            return await fn(rt, req, reply);
          } catch (err) {
            if (err instanceof HttpError) {
              return reply.code(err.statusCode).send({ error: err.message });
            }
            throw err;
          }
        };

      app.post(GITHUB_ROUTES.webhook, { bodyLimit: WEBHOOK_BODY_LIMIT }, wrap(handleWebhook));

      app.get(
        GITHUB_ROUTES.install,
        wrap(async (rt, req, reply) => {
          const resolved = await rt.app();
          if (!resolved) throw new HttpError(503, "GitHub App is not configured");
          const state = await startFlow(rt, req, reply, "install");
          return reply.redirect(installUrl(resolved.config.slug, state), 302);
        }),
      );
      app.get(GITHUB_ROUTES.setup, wrap(handleSetupForBrowser));
      // For the web UI (AFE-16): which connect options are available. No secrets.
      app.get(
        "/api/connections/github/app",
        wrap(async (rt) => {
          const resolved = await rt.app();
          return {
            configured: resolved !== null,
            slug: resolved?.config.slug ?? null,
            origin: resolved?.origin ?? null,
            installUrl: resolved ? GITHUB_ROUTES.install : null,
            manifestFlow: {
              available: !resolved && rt.options.manifestFlow !== false,
              publicUrlConfigured: rt.publicUrl !== null,
              url: GITHUB_ROUTES.manifest,
            },
          };
        }),
      );
      app.get(GITHUB_ROUTES.manifest, wrap(handleManifest));
      app.get(GITHUB_ROUTES.manifestCallback, wrap(handleManifestCallback));
    },

    jobs(ctx) {
      const rt = runtime(ctx);
      return [
        {
          name: GITHUB_WEBHOOK_JOB,
          async handler(data) {
            const job = data as GitHubWebhookJob;
            await (options.processWebhook ?? processGitHubWebhook)(job, rt);
          },
        },
      ];
    },

    health(ctx): ConnectorHealthHooks {
      const rt = runtime(ctx);
      return { source: CONNECTOR_SOURCE, probe: (connection) => probeInstallation(rt, connection) };
    },
  };
}

/** Exposed for tests and AFE-7: the runtime bound to a server context. */
export function githubRuntime(ctx: ServerContext): GitHubRuntime | undefined {
  return runtimes.get(ctx);
}

/** Default module: App from the environment or the manifest flow. */
export const githubModule = createGitHubModule();
