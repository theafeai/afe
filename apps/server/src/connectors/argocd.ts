/**
 * ArgoCD connector wiring (AFE-9): connection management API and health probe.
 * Design: docs/decisions/0004-argocd-connection-model.md, docs/connectors/argocd.md.
 *
 * Event capture (AFE-10): `argocd.watch` (long-running watch per connection,
 * in time slices that re-enqueue themselves) and `argocd.reconcile`
 * (scheduled every 5 minutes; fans out per connection and makes sure a watch
 * is queued), plus the `backfill` health hook. See docs/connectors/argocd.md
 * "Event capture".
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type Connection,
  type ConnectorHealthHooks,
  type JsonObject,
  type ProbeResult,
} from "@afe/core";
import {
  Secret,
  UnsafeUrlError,
  validateOutboundUrl,
  type OutboundUrlPolicy,
} from "@afe/core/security";
import {
  attachConnectionCredential,
  findConnectionByExternalId,
  getConnection,
  getConnectionCredentialIds,
  getCredential,
  listActiveConnections,
  listConnections,
  revokeCredential,
  setConnectionStatus,
  storeCredential,
  upsertConnection,
} from "@afe/db";
import {
  API_TOKEN_KIND,
  API_TOKEN_ROLE,
  ArgoCdCapture,
  ArgoCdError,
  CONNECTOR_SOURCE,
  InvalidConnectionInputError,
  createArgoCdClient,
  describeCaBundle,
  normaliseServerUrl,
  parseCaBundle,
  testArgoCdConnection,
  type ArgoCdClientHandle,
  type CaptureCounts,
  type CaptureObservation,
  type ConnectionTestResult,
} from "@afe/connector-argocd";
import { requestTenant } from "../auth/index.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import { createPgCaptureStateStore } from "./argocd-state.ts";
import {
  isAgentConnection,
  probeAgentConnection,
  requestAgentResync,
} from "./argocd-agent-state.ts";

export const ARGOCD_WATCH_JOB = "argocd.watch";
export const ARGOCD_RECONCILE_JOB = "argocd.reconcile";

/** Payload of `argocd.watch` / `argocd.reconcile` jobs. No credentials. */
export interface ArgoCdCaptureJob {
  tenantId?: string;
  connectionId?: string;
}

/**
 * Receives every capture observation (stream or reconciliation, success or
 * failure), e.g. to feed connection health (AFE-13).
 */
export type ArgoCdObservationHook = (
  ctx: ServerContext,
  connection: Connection,
  observation: CaptureObservation,
) => void | Promise<void>;

/** Structural view of AFE-13's `HealthReporter`, so this module works with or without it. */
interface HealthReporterLike {
  reportSuccess(
    tenantId: string,
    connectionId: string,
    at?: Date,
    options?: { via?: "stream" | "poll" },
  ): Promise<void>;
  reportFailure(
    tenantId: string,
    connectionId: string,
    reason: Extract<CaptureObservation, { ok: false }>["reason"],
    detail?: string,
    retryAfter?: Date,
    at?: Date,
  ): Promise<void>;
}

/**
 * Default observation hook: reports to connection health (`ctx.health`,
 * AFE-13) when it is registered, otherwise does nothing.
 */
export const reportObservationToHealth: ArgoCdObservationHook = async (ctx, c, o) => {
  const health = (ctx as { health?: HealthReporterLike }).health;
  if (!health) return;
  if (o.ok) await health.reportSuccess(c.tenantId, c.id, o.at, { via: o.via });
  else await health.reportFailure(c.tenantId, c.id, o.reason, o.detail, undefined, o.at);
};

export interface ArgoCdModuleOptions {
  /** Retries per ArgoCD request (default 2). Tests use 0. */
  retries?: number;
  /** Total timeout per ArgoCD request in ms (default 30 s). */
  timeoutMs?: number;
  /** Length of one `argocd.watch` job run in ms (default 10 min, below pg-boss' 15 min expiry). */
  watchSliceMs?: number;
  /** Re-enqueue `argocd.watch` at the end of each slice (default true; tests turn it off). */
  requeueWatch?: boolean;
  /** Let the scheduled reconcile fan-out also queue a watch per connection (default true). */
  scheduleWatch?: boolean;
  /** Reconnect delay of the watch after attempt n (default 1 s doubling to 60 s). */
  watchBackoffMs?: (attempt: number) => number;
  /** Cron for `argocd.reconcile` (default every 5 minutes). */
  reconcileSchedule?: string;
  /** Observation hook; default `reportObservationToHealth`. */
  onObservation?: ArgoCdObservationHook;
  /** Clock, for tests. */
  now?: () => Date;
}

interface ConnectBody {
  url: string;
  token: string;
  caPem?: string;
  name?: string;
}

/** Outbound policy for ArgoCD URLs, from the operator's configuration (rules.md R6.2). */
export function argocdOutboundPolicy(ctx: ServerContext): OutboundUrlPolicy {
  return {
    allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets,
    allowInsecureHttp: ctx.config.allowInsecureHttpTargets,
  };
}

/**
 * Entry point for AFE-10 (watch/reconciliation) and the health probe: a
 * read-only client for a stored connection. The token is decrypted on every
 * request, so rotation and revocation apply immediately (rules.md R2.6).
 * Returns null if the connection has no usable credential.
 */
export async function argocdClientForConnection(
  ctx: ServerContext,
  connection: Connection,
  options: ArgoCdModuleOptions = {},
): Promise<ArgoCdClientHandle | null> {
  const ids = await getConnectionCredentialIds(ctx.pool, connection.tenantId, connection.id);
  const credentialId = ids[API_TOKEN_ROLE];
  if (!credentialId) return null;
  const serverUrl = String(connection.config.serverUrl ?? connection.externalId);
  const caPem = typeof connection.config.caPem === "string" ? connection.config.caPem : null;
  return createArgoCdClient({
    config: { serverUrl, caPem },
    policy: argocdOutboundPolicy(ctx),
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    token: async () => {
      const cred = await getCredential(ctx.pool, ctx.keys, connection.tenantId, credentialId);
      if (!cred) throw new ArgoCdError("unauthorized", "the connection's API token was revoked");
      return cred.secret;
    },
  });
}

function connectionView(c: Connection) {
  const { caPem, ...config } = c.config;
  return {
    id: c.id,
    source: c.source,
    name: c.name,
    externalId: c.externalId,
    status: c.status,
    statusReason: c.statusReason,
    config,
    caCertificates: typeof caPem === "string" ? describeCaBundle(caPem) : [],
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function sendArgoCdError(reply: FastifyReply, err: ArgoCdError) {
  return reply.code(422).send({
    error: "connection_failed",
    kind: err.kind,
    message: err.message,
  });
}

function probeFailure(err: unknown): ProbeResult {
  if (!(err instanceof ArgoCdError)) return { ok: false, reason: "error" };
  switch (err.kind) {
    case "unauthorized":
    case "forbidden":
      return { ok: false, reason: "unauthorized", detail: err.message };
    case "rate_limited":
      return { ok: false, reason: "rate_limited", detail: err.message };
    case "unreachable":
    case "timeout":
    case "tls":
    case "unsafe_address":
      return { ok: false, reason: "unreachable", detail: err.message };
    default:
      return { ok: false, reason: "error", detail: err.message };
  }
}

const connectBodySchema = {
  type: "object",
  required: ["url", "token"],
  additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1, maxLength: 2048 },
    token: { type: "string", minLength: 1, maxLength: 16384 },
    caPem: { type: "string", maxLength: 262144 },
    name: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export function createArgoCdModule(options: ArgoCdModuleOptions = {}): ConnectorModule {
  return {
    source: CONNECTOR_SOURCE,

    routes(app: FastifyInstance, ctx: ServerContext) {
      // The tenant is the authenticated principal's (ADR 0006), never a request field.
      const runTest = async (handle: ArgoCdClientHandle): Promise<ConnectionTestResult> => {
        try {
          return await testArgoCdConnection(handle.client);
        } finally {
          await handle.close();
        }
      };

      app.get("/api/connections/argocd", async (req) => {
        const tenantId = requestTenant(req);
        const rows = await listConnections(ctx.pool, tenantId, { source: CONNECTOR_SOURCE });
        return { connections: rows.map(connectionView) };
      });

      app.post<{ Body: ConnectBody }>(
        "/api/connections/argocd",
        { schema: { body: connectBodySchema }, bodyLimit: 512 * 1024 },
        async (req, reply) => {
          const tenantId = requestTenant(req);
          const body = req.body;
          const policy = argocdOutboundPolicy(ctx);
          let serverUrl: string;
          let caPem: string | null = null;
          try {
            serverUrl = normaliseServerUrl(body.url);
            await validateOutboundUrl(serverUrl, policy);
            if (body.caPem?.trim()) caPem = parseCaBundle(body.caPem);
          } catch (e) {
            if (e instanceof InvalidConnectionInputError || e instanceof UnsafeUrlError) {
              return reply.code(400).send({ error: "invalid_input", message: e.message });
            }
            throw e;
          }

          const token = new Secret(body.token.trim());
          let result: ConnectionTestResult;
          try {
            result = await runTest(
              createArgoCdClient({
                config: { serverUrl, caPem },
                policy,
                token: () => token,
                retries: options.retries,
                timeoutMs: options.timeoutMs,
              }),
            );
          } catch (e) {
            if (e instanceof ArgoCdError) {
              req.log.warn(
                { source: CONNECTOR_SOURCE, kind: e.kind, status: e.status },
                "argocd connection test failed",
              );
              return sendArgoCdError(reply, e);
            }
            throw e;
          }

          if (result.readOnly.status === "write_capable") {
            return reply.code(422).send({
              error: "token_not_read_only",
              message:
                "the token can modify ArgoCD; create a dedicated account with the read-only role (docs/connectors/argocd.md)",
              writeCapabilities: result.readOnly.writeCapabilities,
            });
          }

          const config: JsonObject = {
            serverUrl,
            caPem,
            argocdVersion: result.version,
            account: result.username,
            readOnlyCheck: result.readOnly.status,
            verifiedAt: new Date().toISOString(),
          };
          const name = body.name?.trim() || new URL(serverUrl).host;

          const client = await ctx.pool.connect();
          let connection: Connection;
          try {
            await client.query("BEGIN");
            const existing = await findConnectionByExternalId(
              client,
              tenantId,
              CONNECTOR_SOURCE,
              serverUrl,
            );
            const cred = await storeCredential(client, ctx.keys, tenantId, {
              kind: API_TOKEN_KIND,
              secret: token,
            });
            connection = await upsertConnection(client, tenantId, {
              source: CONNECTOR_SOURCE,
              externalId: serverUrl,
              name,
              status: "active",
              config,
            });
            if (existing) {
              const old = (await getConnectionCredentialIds(client, tenantId, existing.id))[
                API_TOKEN_ROLE
              ];
              if (old) await revokeCredential(client, tenantId, old);
            }
            await attachConnectionCredential(
              client,
              tenantId,
              connection.id,
              API_TOKEN_ROLE,
              cred.id,
            );
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          } finally {
            client.release();
          }
          req.log.info(
            { source: CONNECTOR_SOURCE, connectionId: connection.id },
            "argocd connection saved",
          );
          return reply.code(201).send({
            connection: connectionView(connection),
            server: { version: result.version },
            account: { username: result.username, issuer: result.issuer },
            applicationCount: result.applicationCount,
            readOnlyCheck: result.readOnly,
            warnings: result.warnings,
          });
        },
      );

      app.post<{ Params: { id: string } }>(
        "/api/connections/argocd/:id/test",
        { schema: { params: idParamsSchema } },
        async (req, reply) => {
          const tenantId = requestTenant(req);
          const connection = await getConnection(ctx.pool, tenantId, req.params.id);
          if (!connection || connection.source !== CONNECTOR_SOURCE) {
            return reply.code(404).send({ error: "not_found" });
          }
          const handle = await argocdClientForConnection(ctx, connection, options);
          if (!handle) {
            return reply.code(422).send({
              error: "connection_failed",
              kind: "unauthorized",
              message: "the connection has no API token; reconnect it",
            });
          }
          try {
            const result = await runTest(handle);
            return {
              ok: result.readOnly.status !== "write_capable",
              server: { version: result.version },
              account: { username: result.username, issuer: result.issuer },
              applicationCount: result.applicationCount,
              readOnlyCheck: result.readOnly,
              warnings: result.warnings,
            };
          } catch (e) {
            if (e instanceof ArgoCdError) return sendArgoCdError(reply, e);
            throw e;
          }
        },
      );

      app.delete<{ Params: { id: string } }>(
        "/api/connections/argocd/:id",
        { schema: { params: idParamsSchema } },
        async (req, reply) => {
          const tenantId = requestTenant(req);
          const client = await ctx.pool.connect();
          try {
            await client.query("BEGIN");
            const connection = await getConnection(client, tenantId, req.params.id);
            if (!connection || connection.source !== CONNECTOR_SOURCE) {
              await client.query("ROLLBACK");
              return reply.code(404).send({ error: "not_found" });
            }
            const ids = await getConnectionCredentialIds(client, tenantId, connection.id);
            for (const id of Object.values(ids)) await revokeCredential(client, tenantId, id);
            const updated = await setConnectionStatus(
              client,
              tenantId,
              connection.id,
              "disconnected",
              "disconnected by user",
            );
            await client.query("COMMIT");
            req.log.info(
              { source: CONNECTOR_SOURCE, connectionId: connection.id },
              "argocd connection removed",
            );
            return { connection: connectionView(updated!) };
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          } finally {
            client.release();
          }
        },
      );
    },

    jobs(ctx: ServerContext): JobDefinition[] {
      return [
        {
          name: ARGOCD_RECONCILE_JOB,
          schedule: options.reconcileSchedule ?? "*/5 * * * *",
          scheduleData: {},
          handler: async (data) => {
            const job = data as ArgoCdCaptureJob;
            if (!job.tenantId || !job.connectionId) {
              // Scheduled fan-out: one reconcile (and an ensured watch) per connection.
              for (const c of await listActiveConnections(ctx.pool, CONNECTOR_SOURCE)) {
                // Agent connections (AFE-28) are fed by their agent, not pulled.
                if (isAgentConnection(c)) continue;
                const payload: ArgoCdCaptureJob = { tenantId: c.tenantId, connectionId: c.id };
                const singletonKey = `${c.tenantId}:${c.id}`;
                await ctx.jobs.send(ARGOCD_RECONCILE_JOB, payload, { singletonKey });
                if (options.scheduleWatch !== false) {
                  await ctx.jobs.send(ARGOCD_WATCH_JOB, payload, { singletonKey });
                }
              }
              return;
            }
            const connection = await activeConnection(ctx, job);
            if (connection) await reconcileArgoCdConnection(ctx, connection, options);
          },
        },
        {
          name: ARGOCD_WATCH_JOB,
          retryLimit: 100,
          handler: async (data) => {
            const job = data as ArgoCdCaptureJob;
            const connection = await activeConnection(ctx, job);
            if (!connection) return;
            await watchArgoCdConnection(ctx, connection, options);
            if (options.requeueWatch !== false && (await activeConnection(ctx, job))) {
              await ctx.jobs.send(ARGOCD_WATCH_JOB, job, {
                singletonKey: `${connection.tenantId}:${connection.id}`,
              });
            }
          },
        },
      ];
    },

    health(ctx: ServerContext): ConnectorHealthHooks {
      return {
        source: CONNECTOR_SOURCE,
        async probe(connection) {
          // Agent connections (AFE-28): health comes from the agent's heartbeats.
          if (isAgentConnection(connection)) return probeAgentConnection(ctx.pool, connection);
          let handle: ArgoCdClientHandle | null;
          try {
            handle = await argocdClientForConnection(ctx, connection, options);
          } catch {
            return {
              ok: false,
              reason: "error",
              detail: "could not load the connection's credential",
            };
          }
          if (!handle) return { ok: false, reason: "revoked", detail: "no API token" };
          try {
            const user = await handle.client.getUserInfo();
            if (!user.loggedIn)
              return { ok: false, reason: "unauthorized", detail: "token rejected" };
            return { ok: true };
          } catch (e) {
            return probeFailure(e);
          } finally {
            await handle.close();
          }
        },
        /**
         * After a gap: re-list applications and diff operation state and
         * history against the stored state; anything missed is ingested with
         * observation.method "reconciliation". ArgoCD has no time-range query,
         * so `from`/`to` are not needed: history keeps the last
         * `revisionHistoryLimit` (default 10) successful syncs; failed syncs
         * other than the latest operation are not recoverable.
         */
        async backfill(connection, _from, to) {
          // Agent connections (AFE-28): ask the agent for a full snapshot instead.
          if (isAgentConnection(connection)) return requestAgentResync(ctx.pool, connection, to);
          await reconcileArgoCdConnection(ctx, connection, options);
        },
      };
    },
  };
}

async function activeConnection(
  ctx: ServerContext,
  job: ArgoCdCaptureJob,
): Promise<Connection | null> {
  if (!job.tenantId || !job.connectionId) return null;
  const c = await getConnection(ctx.pool, job.tenantId, job.connectionId);
  return c && c.source === CONNECTOR_SOURCE && c.status === "active" && !isAgentConnection(c)
    ? c
    : null;
}

function captureFor(
  ctx: ServerContext,
  connection: Connection,
  handle: ArgoCdClientHandle,
  options: ArgoCdModuleOptions,
): ArgoCdCapture {
  const hook = options.onObservation ?? reportObservationToHealth;
  return new ArgoCdCapture({
    tenantId: connection.tenantId,
    connectionId: connection.id,
    client: handle.client,
    sink: ctx.sink,
    store: createPgCaptureStateStore(ctx.pool, connection.tenantId, connection.id),
    onObservation: (o) => hook(ctx, connection, o),
    log: ctx.log,
    ...(options.now ? { now: options.now } : {}),
  });
}

async function reportMissingToken(
  ctx: ServerContext,
  connection: Connection,
  options: ArgoCdModuleOptions,
  via: "stream" | "poll",
): Promise<void> {
  const hook = options.onObservation ?? reportObservationToHealth;
  await hook(ctx, connection, {
    ok: false,
    via,
    at: options.now?.() ?? new Date(),
    reason: "revoked",
    detail: "the connection has no API token",
  });
}

/** One reconciliation pass for a connection (`argocd.reconcile`, backfill). */
export async function reconcileArgoCdConnection(
  ctx: ServerContext,
  connection: Connection,
  options: ArgoCdModuleOptions = {},
): Promise<CaptureCounts | null> {
  const handle = await argocdClientForConnection(ctx, connection, options);
  if (!handle) {
    await reportMissingToken(ctx, connection, options, "poll");
    return null;
  }
  try {
    const counts = await captureFor(ctx, connection, handle, options).reconcile();
    ctx.log.info(
      { source: CONNECTOR_SOURCE, connectionId: connection.id, ...counts },
      "argocd reconciliation finished",
    );
    return counts;
  } finally {
    await handle.close();
  }
}

/** Connections whose watch runs in this process (avoids duplicate watches per worker). */
const runningWatches = new Set<string>();

/** One watch slice for a connection (`argocd.watch`). */
export async function watchArgoCdConnection(
  ctx: ServerContext,
  connection: Connection,
  options: ArgoCdModuleOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const key = `${connection.tenantId}:${connection.id}`;
  if (runningWatches.has(key)) return;
  runningWatches.add(key);
  try {
    const handle = await argocdClientForConnection(ctx, connection, options);
    if (!handle) {
      await reportMissingToken(ctx, connection, options, "stream");
      return;
    }
    try {
      const summary = await captureFor(ctx, connection, handle, options).watch({
        durationMs: options.watchSliceMs ?? 10 * 60_000,
        ...(signal ? { signal } : {}),
        ...(options.watchBackoffMs ? { backoffMs: options.watchBackoffMs } : {}),
      });
      ctx.log.info(
        {
          source: CONNECTOR_SOURCE,
          connectionId: connection.id,
          connects: summary.connects,
          failures: summary.failures,
          events: summary.events,
        },
        "argocd watch slice finished",
      );
    } finally {
      await handle.close();
    }
  } finally {
    runningWatches.delete(key);
  }
}

export const argocdModule: ConnectorModule = createArgoCdModule();
