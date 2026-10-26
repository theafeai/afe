/**
 * ArgoCD connector wiring (AFE-9): connection management API and health probe.
 * Design: docs/decisions/0004-argocd-connection-model.md, docs/connectors/argocd.md.
 *
 * Event capture (application watch + reconciliation) is AFE-10; it builds on
 * `argocdClientForConnection` below and adds jobs to this module.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DEFAULT_TENANT_ID,
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
  listConnections,
  revokeCredential,
  setConnectionStatus,
  storeCredential,
  upsertConnection,
} from "@afe/db";
import {
  API_TOKEN_KIND,
  API_TOKEN_ROLE,
  ArgoCdError,
  CONNECTOR_SOURCE,
  InvalidConnectionInputError,
  createArgoCdClient,
  describeCaBundle,
  normaliseServerUrl,
  parseCaBundle,
  testArgoCdConnection,
  type ArgoCdClientHandle,
  type ConnectionTestResult,
} from "@afe/connector-argocd";
import type { ConnectorModule, ServerContext } from "../context.ts";

export interface ArgoCdModuleOptions {
  /** Retries per ArgoCD request (default 2). Tests use 0. */
  retries?: number;
  /** Total timeout per ArgoCD request in ms (default 30 s). */
  timeoutMs?: number;
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
      // No AuthProvider exists yet (ADR 0002); until it does, these admin
      // routes act on the built-in default tenant. The tenant must come from
      // the authenticated principal once auth lands, never from the request.
      const tenantId = DEFAULT_TENANT_ID;

      const runTest = async (handle: ArgoCdClientHandle): Promise<ConnectionTestResult> => {
        try {
          return await testArgoCdConnection(handle.client);
        } finally {
          await handle.close();
        }
      };

      app.get("/api/connections/argocd", async () => {
        const rows = await listConnections(ctx.pool, tenantId, { source: CONNECTOR_SOURCE });
        return { connections: rows.map(connectionView) };
      });

      app.post<{ Body: ConnectBody }>(
        "/api/connections/argocd",
        { schema: { body: connectBodySchema }, bodyLimit: 512 * 1024 },
        async (req, reply) => {
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

    health(ctx: ServerContext): ConnectorHealthHooks {
      return {
        source: CONNECTOR_SOURCE,
        async probe(connection) {
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
        // backfill: AFE-10 (re-list applications and diff operation history).
      };
    },
  };
}

export const argocdModule: ConnectorModule = createArgoCdModule();
