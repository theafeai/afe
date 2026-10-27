/**
 * Vercel connector wiring (AFE-11, ADR 0005): connection model (Vercel
 * Integration via OAuth, or an access-token fallback), project selection,
 * disconnect/revocation and the webhook receiver; and event capture (AFE-12):
 * `vercel.webhook` maps and ingests deliveries, `vercel.poll.dispatch` (cron)
 * fans out `vercel.poll` per active connection (backfill on first connect,
 * reconciliation polling, promotion/rollback detection), and the health
 * `backfill` hook re-observes a gap. See docs/connectors/vercel.md "Event capture".
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  clampLookbackMs,
  clampToRetention,
  type Connection,
  type ConnectorHealthHooks,
  type HealthFailureReason,
  type JsonObject,
  type ObservationGapReason,
  type ProbeResult,
  EventValidationError,
} from "@afe/core";
import { Secret } from "@afe/core/security";
import {
  type CaptureWebhookResult,
  type PollResult,
  VercelPoller,
  captureWebhookEvent,
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
  listActiveConnections,
  recordDelivery,
  resolveConnectionBySourceIdentity,
  revokeCredential,
  setConnectionStatus,
  storeCredential,
  updateConnectionConfig,
  upsertConnection,
} from "@afe/db";
import { requestTenant } from "../auth/index.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import { pgVercelCaptureStore, withVercelPollLock } from "./vercel-state.ts";

const SOURCE = CONNECTOR_SOURCE;
export const VERCEL_WEBHOOK_JOB = "vercel.webhook";
export const VERCEL_POLL_JOB = "vercel.poll";
export const VERCEL_POLL_DISPATCH_JOB = "vercel.poll.dispatch";
/** Every 3 minutes (UTC cron). */
export const DEFAULT_POLL_SCHEDULE = "*/3 * * * *";
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
  /** Tenant of the authenticated API caller. Default: the principal's (`requestTenant`). */
  resolveTenant?: (req: FastifyRequest) => string | Promise<string>;
  now?: () => number;
  webhookToleranceMs?: number;
  /** Cron for `vercel.poll.dispatch`. Default every 3 minutes. */
  pollSchedule?: string;
  /** History imported when a connection (or a newly selected project) is first polled. Default 30. */
  backfillDays?: number;
  /** Polls leave transitions younger than this to the next poll (webhooks win). Default 60 s. */
  settleMs?: number;
  /** Polls re-read this far before the cursor. Default 10 minutes. */
  overlapMs?: number;
  /**
   * Called after each webhook job, poll and gap reconciliation with whether
   * Vercel could be observed. Connection health (AFE-13) wires this up to
   * open and close observation gaps; this module tracks no health itself.
   */
  onObservation?: (observation: VercelObservation) => void | Promise<void>;
}

/** Payload of `vercel.poll` jobs. */
export interface VercelPollJob {
  tenantId: string;
  connectionId: string;
}

/** Outcome of one attempt to observe Vercel for a connection (see `onObservation`). */
export type VercelObservation = {
  tenantId: string;
  connectionId: string;
  kind: "webhook" | "poll" | "reconcile";
  at: Date;
} & (
  | { ok: true; result?: PollResult }
  | { ok: false; reason: ObservationGapReason; detail: string; retryAfter?: Date }
);

const HEALTH_REASON: Record<ObservationGapReason, HealthFailureReason> = {
  connection_error: "unreachable",
  source_unavailable: "unreachable",
  auth_failed: "unauthorized",
  permission_denied: "unauthorized",
  rate_limited: "rate_limited",
  webhook_delivery_failed: "error",
  history_unavailable: "error",
  afe_unavailable: "error",
  connection_paused: "error",
  unknown: "error",
};

/** Default `onObservation`: report to connection health (AFE-13) when it is enabled. */
async function reportHealth(ctx: ServerContext, obs: VercelObservation): Promise<void> {
  if (!ctx.health) return;
  if (obs.ok) {
    await ctx.health.reportSuccess(obs.tenantId, obs.connectionId, obs.at, {
      via: obs.kind === "webhook" ? "webhook" : obs.kind === "poll" ? "poll" : "backfill",
    });
  } else {
    await ctx.health.reportFailure(
      obs.tenantId,
      obs.connectionId,
      HEALTH_REASON[obs.reason],
      obs.detail,
      obs.retryAfter,
      obs.at,
    );
  }
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
  const resolveTenant = options.resolveTenant ?? requestTenant;
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

  // --- event capture (AFE-12) --------------------------------------------------

  async function observe(ctx: ServerContext, obs: VercelObservation): Promise<void> {
    const report = options.onObservation ?? ((o: VercelObservation) => reportHealth(ctx, o));
    try {
      await report(obs);
    } catch (err) {
      ctx.log.warn(
        { source: SOURCE, connectionId: obs.connectionId, err: (err as Error).name },
        "vercel observation callback failed",
      );
    }
  }

  /** Classifies a capture failure; 401/403 and missing credentials revoke the connection. */
  async function failure(
    ctx: ServerContext,
    conn: Connection,
    kind: VercelObservation["kind"],
    err: unknown,
  ): Promise<VercelObservation> {
    const base = { ok: false as const, tenantId: conn.tenantId, connectionId: conn.id, kind };
    const at = new Date(now());
    if (err instanceof MissingCredentialError) {
      await markRevoked(ctx, conn, "credential missing or revoked");
      return { ...base, at, reason: "auth_failed", detail: "credential missing or revoked" };
    }
    if (err instanceof VercelRateLimitError) {
      return {
        ...base,
        at,
        reason: "rate_limited",
        detail: "Vercel API rate limit",
        ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
      };
    }
    if (err instanceof VercelApiError) {
      if (err.isAuthError) {
        await markRevoked(
          ctx,
          conn,
          `Vercel API returned ${err.status}: the token was revoked or expired, or lost access to the team`,
        );
        return {
          ...base,
          at,
          reason: err.status === 403 ? "permission_denied" : "auth_failed",
          detail: `HTTP ${err.status}`,
        };
      }
      return {
        ...base,
        at,
        reason: err.status >= 500 ? "source_unavailable" : "unknown",
        detail: `HTTP ${err.status}`,
      };
    }
    if (err instanceof EventValidationError) {
      return { ...base, at, reason: "unknown", detail: "event mapping failed validation" };
    }
    return { ...base, at, reason: "connection_error", detail: (err as Error)?.name ?? "error" };
  }

  function readerFor(ctx: ServerContext, conn: Connection): ScopedVercelReader {
    return vercelReader(ctx, conn, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    });
  }

  async function loadActive(ctx: ServerContext, tenantId: string, connectionId: string) {
    const conn = await getConnection(ctx.pool, tenantId, connectionId);
    return conn && conn.source === SOURCE && conn.status === "active" ? conn : null;
  }

  async function processWebhookJob(ctx: ServerContext, job: VercelWebhookJob): Promise<void> {
    const conn = await loadActive(ctx, job.tenantId, job.connectionId);
    if (!conn) return;
    let result: CaptureWebhookResult;
    try {
      result = await captureWebhookEvent({
        event: job,
        reader: readerFor(ctx, conn),
        sink: ctx.sink,
        store: pgVercelCaptureStore(ctx.pool, conn.tenantId, conn.id),
        tenantId: conn.tenantId,
        connectionId: conn.id,
        observedAt: new Date(now()),
      });
    } catch (err) {
      if (err instanceof EventValidationError) {
        // A mapping bug: retrying cannot help (docs/event-model.md rule 5).
        ctx.log.error(
          { source: SOURCE, connectionId: conn.id, deliveryId: job.deliveryId, type: job.type },
          "vercel webhook event failed validation",
        );
        return;
      }
      throw err;
    }
    if (result.enrichmentError !== undefined) {
      const obs = await failure(ctx, conn, "webhook", result.enrichmentError);
      ctx.log.warn(
        {
          source: SOURCE,
          connectionId: conn.id,
          deliveryId: job.deliveryId,
          reason: obs.ok ? null : obs.reason,
        },
        "vercel deployment read failed; event mapped from the webhook payload only",
      );
      await observe(ctx, obs);
    } else {
      await observe(ctx, {
        ok: true,
        tenantId: conn.tenantId,
        connectionId: conn.id,
        kind: "webhook",
        at: new Date(now()),
      });
    }
    ctx.log.debug(
      {
        source: SOURCE,
        connectionId: conn.id,
        deliveryId: job.deliveryId,
        type: job.type,
        status: result.status,
      },
      "vercel webhook processed",
    );
  }

  const DEFAULT_BACKFILL_DAYS = 30;
  const DAY_MS = 24 * 3600_000;
  let backfillClampLogged = false;
  /** First-connect history, never longer than the retention window (ADR 0008). */
  function backfillDays(ctx: ServerContext): number {
    const configured = options.backfillDays ?? DEFAULT_BACKFILL_DAYS;
    const c = clampLookbackMs(configured * DAY_MS, ctx.retention);
    if (!c.clamped) return configured;
    const used = Math.floor(c.ms / DAY_MS);
    if (!backfillClampLogged) {
      backfillClampLogged = true;
      ctx.log.info(
        { source: SOURCE, configured, used },
        "vercel backfill exceeds the event retention window; clamped to it",
      );
    }
    return used;
  }

  async function runCapture(
    ctx: ServerContext,
    conn: Connection,
    kind: "poll" | "reconcile",
    fn: (poller: VercelPoller) => Promise<PollResult>,
  ): Promise<PollResult | null> {
    const poller = new VercelPoller({
      reader: readerFor(ctx, conn),
      sink: ctx.sink,
      store: pgVercelCaptureStore(ctx.pool, conn.tenantId, conn.id),
      tenantId: conn.tenantId,
      connectionId: conn.id,
      now,
      backfillDays: backfillDays(ctx),
      ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
      ...(options.overlapMs !== undefined ? { overlapMs: options.overlapMs } : {}),
    });
    try {
      const result = await withVercelPollLock(ctx.pool, conn.tenantId, conn.id, () => fn(poller));
      if (result === null) {
        ctx.log.debug({ source: SOURCE, connectionId: conn.id }, "vercel poll already running");
        return null;
      }
      ctx.log.info(
        {
          source: SOURCE,
          connectionId: conn.id,
          kind,
          seen: result.deploymentsSeen,
          inserted: result.inserted,
          productionChanges: result.productionChanges,
          truncated: result.truncated,
        },
        "vercel deployments polled",
      );
      await observe(ctx, {
        ok: true,
        tenantId: conn.tenantId,
        connectionId: conn.id,
        kind,
        at: new Date(now()),
        result,
      });
      return result;
    } catch (err) {
      const obs = await failure(ctx, conn, kind, err);
      ctx.log.warn(
        { source: SOURCE, connectionId: conn.id, kind, reason: obs.ok ? null : obs.reason },
        "vercel poll failed",
      );
      await observe(ctx, obs);
      // Auth problems revoke the connection; retrying would not help.
      if (
        err instanceof MissingCredentialError ||
        (err instanceof VercelApiError && err.isAuthError)
      ) {
        return null;
      }
      throw err;
    }
  }

  async function processPollJob(ctx: ServerContext, job: VercelPollJob): Promise<void> {
    const conn = await loadActive(ctx, job.tenantId, job.connectionId);
    if (!conn) return;
    await runCapture(ctx, conn, "poll", (poller) => poller.poll());
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
          handler: (data) => processWebhookJob(ctx, data as VercelWebhookJob),
        },
        {
          name: VERCEL_POLL_DISPATCH_JOB,
          schedule: options.pollSchedule ?? DEFAULT_POLL_SCHEDULE,
          scheduleData: {},
          retryLimit: 0,
          handler: async () => {
            for (const conn of await listActiveConnections(ctx.pool, SOURCE)) {
              const job: VercelPollJob = { tenantId: conn.tenantId, connectionId: conn.id };
              await ctx.jobs.send(VERCEL_POLL_JOB, job, { singletonKey: conn.id });
            }
          },
        },
        {
          name: VERCEL_POLL_JOB,
          retryLimit: 1,
          handler: (data) => processPollJob(ctx, data as VercelPollJob),
        },
      ];
    },

    health(ctx): ConnectorHealthHooks {
      return {
        source: SOURCE,
        async backfill(conn: Connection, from: Date, to: Date): Promise<void> {
          if (conn.source !== SOURCE || conn.status !== "active") return;
          // Events before the retention cutoff would be dropped anyway (ADR 0008).
          const start = clampToRetention(
            from,
            await ctx.retention.cutoff(conn.tenantId, new Date(now())),
          );
          if (start.getTime() >= to.getTime()) return;
          await runCapture(ctx, conn, "reconcile", (poller) => poller.reconcile(start, to));
        },
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

      // For the web UI (AFE-16): is the integration (OAuth) path available? No secrets.
      app.get("/api/connections/vercel/integration", async () => ({
        configured: integrationReady(),
        slug: integrationReady() ? (ctx.config.vercel?.integrationSlug ?? null) : null,
        installUrl: integrationReady() ? "/api/connections/vercel/install" : null,
        missing: [
          ...(ctx.config.vercel
            ? []
            : ["AFE_VERCEL_CLIENT_ID", "AFE_VERCEL_CLIENT_SECRET", "AFE_VERCEL_INTEGRATION_SLUG"]),
          ...(ctx.config.publicUrl ? [] : ["AFE_PUBLIC_URL"]),
        ],
      }));

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
          // Start capturing (and backfilling newly selected projects) right away.
          if (selection.mode !== "none") {
            const job: VercelPollJob = { tenantId: conn.tenantId, connectionId: conn.id };
            await ctx.jobs.send(VERCEL_POLL_JOB, job, { singletonKey: conn.id });
          }
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
