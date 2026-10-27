/**
 * In-cluster ArgoCD agent: registration, ingest endpoint and processing
 * (AFE-28). Design: docs/decisions/0004-argocd-connection-model.md "Agent
 * protocol", docs/connectors/argocd.md "In-cluster agent".
 *
 * - Admin API (ADR 0006, access `admin`):
 *     POST /api/connections/argocd/agents                     register, returns the secret once
 *     GET  /api/connections/argocd/agents                     list agents and their status
 *     POST /api/connections/argocd/agents/:id/rotate-secret   new secret (optional grace period)
 *   An agent connection is removed with the existing
 *   `DELETE /api/connections/argocd/:id` (revokes its secret).
 * - Agent endpoints, outside /api (access `public`; agents authenticate with
 *   an HMAC signature over the raw body made with their secret):
 *     POST /agent/argocd/v1/batches     watch events and full snapshots
 *     POST /agent/argocd/v1/heartbeat   liveness, counters, resync requests
 * - Jobs: `argocd-agent.process` feeds a connection's staged batches, in
 *   order, into the AFE-10 capture (`ArgoCdCapture` without an API client):
 *   watch items with observation method `stream`, snapshot items with
 *   `reconciliation`. `argocd-agent.heartbeat-check` (every minute) reports
 *   missing heartbeats to connection health; `argocd-agent.sweep` (every
 *   minute) re-queues processing for connections with staged batches.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Connection, HealthFailureReason, JsonObject } from "@afe/core";
import { Secret, isTimestampFresh } from "@afe/core/security";
import {
  attachConnectionCredential,
  findConnectionByExternalId,
  getConnection,
  getConnectionCredentialIds,
  getCredential,
  recordDelivery,
  revokeCredential,
  storeCredential,
  upsertConnection,
} from "@afe/db";
import {
  AGENT_DEFAULT_HEARTBEAT_SECONDS,
  AGENT_HEADERS,
  AGENT_MAX_SKEW_MS,
  AGENT_PATHS,
  AGENT_PREVIOUS_SECRET_ROLE,
  AGENT_REPLAY_SOURCE,
  AGENT_SECRET_KIND,
  AGENT_SECRET_ROLE,
  AgentProtocolError,
  ArgoCdCapture,
  CONNECTOR_SOURCE,
  generateAgentSecret,
  parseAgentBatch,
  parseAgentHeartbeat,
  verifyAgentSignature,
  type AgentBatch,
  type AgentBatchResponse,
  type AgentHeartbeat,
  type AgentHeartbeatResponse,
  type ArgoCdKubeEvent,
  type CaptureCounts,
} from "@afe/connector-argocd";
import { requestTenant } from "../auth/index.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import {
  AGENT_MODE,
  countPendingBatches,
  deleteStagedBatch,
  findAgentForAuth,
  getAgentRow,
  isAgentConnection,
  listAgentRows,
  listConnectionsWithPendingBatches,
  listSilentAgentsAcrossTenants,
  markBatchAttempt,
  nextPendingBatches,
  resetAgentRow,
  stageBatch,
  updateAgentRow,
  type AgentRow,
  type AgentRowPatch,
} from "./argocd-agent-state.ts";
import { createPgCaptureStateStore } from "./argocd-state.ts";

export const AGENT_PROCESS_JOB = "argocd-agent.process";
export const AGENT_HEARTBEAT_CHECK_JOB = "argocd-agent.heartbeat-check";
export const AGENT_SWEEP_JOB = "argocd-agent.sweep";

export interface ArgoCdAgentModuleOptions {
  /** Heartbeat interval asked of agents (default 30 s). */
  heartbeatIntervalSeconds?: number;
  /** Heartbeats older than this are missing (default 3 intervals). */
  heartbeatStaleMs?: number;
  /** Staged batches per connection above which the endpoint answers 429 (default 500). */
  maxPendingBatches?: number;
  /** While a gap waits for a snapshot, ask again this often (default 15 min). */
  resyncRepeatMs?: number;
  /** Attempts before a batch that cannot be processed is dropped (and a gap recorded). Default 10. */
  maxBatchAttempts?: number;
  now?: () => Date;
}

/** Job payload: which connection's staged batches to process. No secrets. */
export interface AgentProcessJob {
  tenantId?: string;
  connectionId?: string;
}

const INSTANCE_ID_RE = "^[a-z0-9]([-a-z0-9.]{0,61}[a-z0-9])?$";

const registerBodySchema = {
  type: "object",
  required: ["instanceId"],
  additionalProperties: false,
  properties: {
    instanceId: { type: "string", pattern: INSTANCE_ID_RE },
    name: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const rotateBodySchema = {
  type: "object",
  properties: { graceSeconds: { type: "integer", minimum: 0, maximum: 86_400 } },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function agentView(c: Connection, row: AgentRow | null) {
  return {
    id: c.id,
    source: c.source,
    name: c.name,
    externalId: c.externalId,
    instanceId: c.config.instanceId ?? null,
    status: c.status,
    statusReason: c.statusReason,
    createdAt: c.createdAt.toISOString(),
    agent: row
      ? {
          lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
          lastBatchAt: row.lastBatchAt?.toISOString() ?? null,
          lastSnapshotCompletedAt: row.lastSnapshotCompletedAt?.toISOString() ?? null,
          runId: row.runId,
          lastSequence: row.lastSequence,
          droppedTotal: row.droppedTotal,
          awaitingSnapshot: row.awaitingSnapshot,
          awaitingReason: row.awaitingReason,
          reported: row.lastHeartbeat,
          previousSecretExpiresAt: row.previousSecretExpiresAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** What changed in the agent's run that may mean lost observations. */
function detectLoss(
  row: AgentRow,
  msg: { runId: string; droppedTotal: number; sequence?: number },
): { reason: HealthFailureReason; detail: string } | null {
  if (row.runId && row.runId !== msg.runId) {
    return {
      reason: "unreachable",
      detail:
        "the agent restarted; observations it had not sent yet may be lost until its next full snapshot",
    };
  }
  const prevDropped = row.runId === msg.runId ? row.droppedTotal : 0;
  if (msg.droppedTotal > prevDropped) {
    return {
      reason: "error",
      detail: `the agent dropped ${msg.droppedTotal - prevDropped} observation(s) (buffer full or batch rejected)`,
    };
  }
  if (
    msg.sequence !== undefined &&
    row.runId === msg.runId &&
    msg.sequence > row.lastSequence + 1
  ) {
    return {
      reason: "error",
      detail: `agent batches ${row.lastSequence + 1}..${msg.sequence - 1} never arrived`,
    };
  }
  return null;
}

/** Patch that opens "awaiting a full snapshot" (a gap that only a snapshot closes). */
function awaitingPatch(
  at: Date,
  detail: string,
  runId: string | null,
  droppedTotal: number,
  requestResync: boolean,
): AgentRowPatch {
  return {
    awaitingSnapshot: true,
    awaitingSince: at,
    awaitingReason: detail,
    awaitingRunId: runId,
    awaitingDroppedTotal: droppedTotal,
    ...(requestResync ? { resyncRequested: true } : {}),
  };
}

export function createArgoCdAgentModule(options: ArgoCdAgentModuleOptions = {}): ConnectorModule {
  const now = options.now ?? (() => new Date());
  const intervalS = options.heartbeatIntervalSeconds ?? AGENT_DEFAULT_HEARTBEAT_SECONDS;
  const staleMs = options.heartbeatStaleMs ?? intervalS * 3000;
  const maxPending = options.maxPendingBatches ?? 500;
  const resyncRepeatMs = options.resyncRepeatMs ?? 15 * 60_000;
  const maxAttempts = options.maxBatchAttempts ?? 10;

  const health = (ctx: ServerContext) => ctx.health;

  async function reportLoss(
    ctx: ServerContext,
    tenantId: string,
    connectionId: string,
    loss: { reason: HealthFailureReason; detail: string },
    at: Date,
  ) {
    ctx.log.warn(
      { source: CONNECTOR_SOURCE, connectionId, reason: loss.reason, detail: loss.detail },
      "argocd agent: observations may be missing",
    );
    await health(ctx)?.reportFailure(
      tenantId,
      connectionId,
      loss.reason,
      loss.detail,
      undefined,
      at,
    );
  }

  // ---- agent authentication ------------------------------------------------

  type Authed = { tenantId: string; connectionId: string; receivedAt: Date };

  async function authenticateAgent(
    ctx: ServerContext,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Authed | null> {
    const unauthorized = () => {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    };
    const agentId = req.headers[AGENT_HEADERS.agentId];
    const body = req.rawBody;
    if (typeof agentId !== "string" || !UUID_RE.test(agentId) || !body) return unauthorized();
    const connectionId = agentId.toLowerCase();
    const agent = await findAgentForAuth(ctx.pool, connectionId);
    if (!agent) return unauthorized();
    const { tenantId } = agent;
    const receivedAt = now();
    const ids = await getConnectionCredentialIds(ctx.pool, tenantId, connectionId);
    const secrets: string[] = [];
    const current = ids[AGENT_SECRET_ROLE];
    if (current) {
      const c = await getCredential(ctx.pool, ctx.keys, tenantId, current);
      if (c) secrets.push(c.secret.reveal());
    }
    const previous = ids[AGENT_PREVIOUS_SECRET_ROLE];
    if (
      previous &&
      agent.previousSecretExpiresAt &&
      agent.previousSecretExpiresAt.getTime() > receivedAt.getTime()
    ) {
      const c = await getCredential(ctx.pool, ctx.keys, tenantId, previous);
      if (c) secrets.push(c.secret.reveal());
    }
    if (!secrets.length) return unauthorized();
    const check = verifyAgentSignature({
      secrets,
      timestamp: req.headers[AGENT_HEADERS.timestamp],
      signature: req.headers[AGENT_HEADERS.signature],
      body,
      now: receivedAt.getTime(),
    });
    if (check === "stale") {
      void reply.code(401).send({
        error: "clock_skew",
        message: "request timestamp is more than 5 minutes away from Afe's clock",
        serverTime: receivedAt.toISOString(),
      });
      return null;
    }
    if (check !== "ok") {
      req.log.warn(
        { source: CONNECTOR_SOURCE, connectionId, check },
        "argocd agent: bad signature",
      );
      return unauthorized();
    }
    const parsed = req.body as { agentId?: unknown; sentAt?: unknown } | undefined;
    if (typeof parsed?.agentId !== "string" || parsed.agentId.toLowerCase() !== connectionId) {
      void reply.code(400).send({ error: "invalid_body", message: "agentId does not match" });
      return null;
    }
    if (
      typeof parsed.sentAt !== "string" ||
      !isTimestampFresh(Date.parse(parsed.sentAt), AGENT_MAX_SKEW_MS, receivedAt.getTime())
    ) {
      void reply.code(401).send({
        error: "clock_skew",
        message: "sentAt is more than 5 minutes away from Afe's clock",
        serverTime: receivedAt.toISOString(),
      });
      return null;
    }
    return { tenantId, connectionId, receivedAt };
  }

  // ---- heartbeat -------------------------------------------------------------

  async function handleHeartbeat(
    ctx: ServerContext,
    a: Authed,
    hb: AgentHeartbeat,
  ): Promise<AgentHeartbeatResponse> {
    const at = a.receivedAt;
    let loss: { reason: HealthFailureReason; detail: string } | null = null;
    let resync = false;
    let awaiting = false;
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await getAgentRow(client, a.tenantId, a.connectionId, { forUpdate: true });
      if (!row) throw new Error("agent row missing");
      loss = detectLoss(row, hb);
      const runChanged = row.runId !== hb.runId;
      const patch: AgentRowPatch = {
        lastHeartbeatAt: at,
        lastHeartbeat: {
          receivedAt: at.toISOString(),
          sentAt: hb.sentAt,
          agentVersion: hb.agentVersion,
          mode: hb.mode,
          runId: hb.runId,
          lastSequence: hb.lastSequence,
          buffered: hb.buffered,
          droppedTotal: hb.droppedTotal,
          watching: hb.watching,
          ...(hb.lastWatchEventAt ? { lastWatchEventAt: hb.lastWatchEventAt } : {}),
          ...(hb.lastSnapshotAt ? { lastSnapshotAt: hb.lastSnapshotAt } : {}),
          ...(hb.kubernetesVersion ? { kubernetesVersion: hb.kubernetesVersion } : {}),
          ...(hb.namespaces ? { namespaces: hb.namespaces } : {}),
        },
        runId: hb.runId,
        droppedTotal: hb.droppedTotal,
        ...(runChanged ? { lastSequence: 0 } : {}),
      };
      if (loss) {
        // A restart sends a full snapshot by itself; drops need an explicit request.
        Object.assign(
          patch,
          awaitingPatch(at, loss.detail, hb.runId, hb.droppedTotal, !runChanged),
        );
      }
      awaiting = loss !== null || row.awaitingSnapshot;
      const wantResync = loss ? !runChanged : row.resyncRequested;
      const repeat =
        awaiting &&
        !loss &&
        (!row.resyncSentAt || at.getTime() - row.resyncSentAt.getTime() > resyncRepeatMs);
      if (wantResync || repeat) {
        resync = true;
        patch.resyncRequested = false;
        patch.resyncSentAt = at;
      }
      await updateAgentRow(client, a.tenantId, a.connectionId, patch);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    if (loss) await reportLoss(ctx, a.tenantId, a.connectionId, loss, at);
    else if (!awaiting) {
      await health(ctx)?.reportSuccess(a.tenantId, a.connectionId, at, { via: "stream" });
    }
    return {
      ok: true,
      resync,
      heartbeatIntervalSeconds: intervalS,
      serverTime: at.toISOString(),
    };
  }

  // ---- batch processing ------------------------------------------------------

  /** Processes one staged batch: run/sequence bookkeeping, then the AFE-10 capture. */
  async function processBatch(
    ctx: ServerContext,
    tenantId: string,
    connectionId: string,
    batch: AgentBatch,
    receivedAt: Date,
  ): Promise<CaptureCounts> {
    const at = now();
    // Run, sequence and drop bookkeeping.
    let loss: { reason: HealthFailureReason; detail: string } | null = null;
    {
      const client = await ctx.pool.connect();
      try {
        await client.query("BEGIN");
        const row = await getAgentRow(client, tenantId, connectionId, { forUpdate: true });
        if (!row) throw new Error("agent row missing");
        // Whichever arrives first after a restart (heartbeat or batch) notices it.
        loss = detectLoss(row, batch);
        const runChanged = row.runId !== batch.runId;
        await updateAgentRow(client, tenantId, connectionId, {
          runId: batch.runId,
          lastSequence: runChanged ? batch.sequence : Math.max(row.lastSequence, batch.sequence),
          droppedTotal: runChanged
            ? batch.droppedTotal
            : Math.max(row.droppedTotal, batch.droppedTotal),
          lastBatchAt: receivedAt,
          ...(loss
            ? awaitingPatch(at, loss.detail, batch.runId, batch.droppedTotal, !runChanged)
            : {}),
        });
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    }
    if (loss) await reportLoss(ctx, tenantId, connectionId, loss, at);

    const capture = new ArgoCdCapture({
      tenantId,
      connectionId,
      sink: ctx.sink,
      store: createPgCaptureStateStore(ctx.pool, tenantId, connectionId),
      transport: "agent",
      log: ctx.log,
      now,
    });
    const counts: CaptureCounts = {
      applications: 0,
      inserted: 0,
      duplicates: 0,
      invalid: 0,
      deletions: 0,
    };
    // Observation times come from the agent's clock, never later than receipt.
    const observed = (t: string) => new Date(Math.min(Date.parse(t), receivedAt.getTime()));
    const eventsOf = (events: ArgoCdKubeEvent[] | undefined) =>
      events ? { appEvents: async () => events } : {};
    for (const item of batch.items) {
      if (item.kind === "watch") {
        await capture.handleWatchEvent({ type: item.type, application: item.application }, counts, {
          observedAt: observed(item.observedAt),
          ...eventsOf(item.events),
        });
      } else if (item.kind === "snapshot") {
        await capture.observe(item.application, "reconciliation", counts, undefined, {
          observedAt: observed(item.observedAt),
          ...eventsOf(item.events),
        });
      } else {
        const listedAt = observed(item.listedAt);
        const c = await capture.reconcileFromSnapshot({
          uids: item.uids,
          listedAt,
          evidence: "absent from the in-cluster agent's complete list of applications",
        });
        counts.inserted += c.inserted;
        counts.duplicates += c.duplicates;
        counts.deletions += c.deletions;
        await completeSnapshot(ctx, tenantId, connectionId, batch, item.droppedTotalAtStart);
      }
    }
    return counts;
  }

  /** A full snapshot was processed: close the gap if it started after every known loss. */
  async function completeSnapshot(
    ctx: ServerContext,
    tenantId: string,
    connectionId: string,
    batch: AgentBatch,
    droppedTotalAtStart: number,
  ): Promise<void> {
    const at = now();
    let closed = false;
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await getAgentRow(client, tenantId, connectionId, { forUpdate: true });
      if (!row) throw new Error("agent row missing");
      const covers =
        !row.awaitingSnapshot ||
        row.awaitingRunId !== batch.runId ||
        droppedTotalAtStart >= row.awaitingDroppedTotal;
      // Drops during the snapshot itself (batch counter above the start counter) also block it.
      const clean = batch.droppedTotal === droppedTotalAtStart;
      const patch: AgentRowPatch = { lastSnapshotCompletedAt: at };
      if (row.awaitingSnapshot && covers && clean) {
        Object.assign(patch, {
          awaitingSnapshot: false,
          awaitingSince: null,
          awaitingReason: null,
          awaitingRunId: null,
          awaitingDroppedTotal: 0,
          resyncRequested: false,
          resyncSentAt: null,
        } satisfies AgentRowPatch);
        closed = true;
      }
      await updateAgentRow(client, tenantId, connectionId, patch);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    // A full snapshot is a successful observation of the whole source.
    const row = await getAgentRow(ctx.pool, tenantId, connectionId);
    if (closed || !row?.awaitingSnapshot) {
      await health(ctx)?.reportSuccess(tenantId, connectionId, at, { via: "stream" });
    }
  }

  /** Processes every staged batch of a connection, in arrival order, under a per-connection lock. */
  async function processPending(
    ctx: ServerContext,
    tenantId: string,
    connectionId: string,
  ): Promise<void> {
    const lockKey = `argocd-agent:${tenantId}:${connectionId}`;
    const lock = await ctx.pool.connect();
    try {
      const { rows } = await lock.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
        [lockKey],
      );
      if (!rows[0]?.ok) return; // another worker is on it; the sweeper catches leftovers
      try {
        for (;;) {
          const batches = await nextPendingBatches(ctx.pool, tenantId, connectionId, 20);
          if (!batches.length) break;
          for (const b of batches) {
            let parsed: AgentBatch;
            try {
              parsed = parseAgentBatch(b.body);
            } catch {
              await deleteStagedBatch(ctx.pool, tenantId, b.id);
              continue; // validated at ingest; cannot happen unless the row was edited
            }
            try {
              const counts = await processBatch(ctx, tenantId, connectionId, parsed, b.receivedAt);
              await deleteStagedBatch(ctx.pool, tenantId, b.id);
              ctx.log.debug(
                { source: CONNECTOR_SOURCE, connectionId, sequence: parsed.sequence, ...counts },
                "argocd agent batch processed",
              );
            } catch (e) {
              await markBatchAttempt(ctx.pool, tenantId, b.id);
              if (b.attempts + 1 < maxAttempts) throw e;
              // Give up on this batch rather than block the agent forever, and say so.
              await deleteStagedBatch(ctx.pool, tenantId, b.id);
              const at = now();
              const detail = `an agent batch (sequence ${parsed.sequence}) could not be processed and was dropped`;
              await updateAgentRow(
                ctx.pool,
                tenantId,
                connectionId,
                awaitingPatch(at, detail, parsed.runId, parsed.droppedTotal, true),
              );
              await reportLoss(ctx, tenantId, connectionId, { reason: "error", detail }, at);
            }
          }
        }
      } finally {
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      }
    } finally {
      lock.release();
    }
  }

  // ---- module ----------------------------------------------------------------

  return {
    source: "argocd-agent",

    routes(app: FastifyInstance, ctx: ServerContext) {
      // ---- admin API (ADR 0006: admin only, tenant from the principal) ----

      app.get("/api/connections/argocd/agents", { config: { access: "admin" } }, async (req) => {
        const tenantId = requestTenant(req);
        const rows = new Map(
          (await listAgentRows(ctx.pool, tenantId)).map((r) => [r.connectionId, r]),
        );
        const out = [];
        for (const id of rows.keys()) {
          const c = await getConnection(ctx.pool, tenantId, id);
          if (c && isAgentConnection(c)) out.push(agentView(c, rows.get(id)!));
        }
        return { agents: out };
      });

      app.post<{ Body: { instanceId: string; name?: string } }>(
        "/api/connections/argocd/agents",
        { config: { access: "admin" }, schema: { body: registerBodySchema } },
        async (req, reply) => {
          const tenantId = requestTenant(req);
          const { instanceId } = req.body;
          const externalId = `agent:${instanceId}`;
          const secret = new Secret(generateAgentSecret());
          const client = await ctx.pool.connect();
          let connection: Connection;
          try {
            await client.query("BEGIN");
            const existing = await findConnectionByExternalId(
              client,
              tenantId,
              CONNECTOR_SOURCE,
              externalId,
            );
            if (existing && existing.status !== "disconnected") {
              await client.query("ROLLBACK");
              return reply.code(409).send({
                error: "agent_exists",
                message:
                  "an agent with this instanceId is registered; rotate its secret or remove it first",
                connectionId: existing.id,
              });
            }
            const cred = await storeCredential(client, ctx.keys, tenantId, {
              kind: AGENT_SECRET_KIND,
              secret,
            });
            const config: JsonObject = {
              mode: AGENT_MODE,
              transport: "agent",
              instanceId,
              registeredAt: now().toISOString(),
            };
            connection = await upsertConnection(client, tenantId, {
              source: CONNECTOR_SOURCE,
              externalId,
              name: req.body.name?.trim() || instanceId,
              status: "active",
              config,
            });
            if (existing) {
              for (const id of Object.values(
                await getConnectionCredentialIds(client, tenantId, existing.id),
              )) {
                await revokeCredential(client, tenantId, id);
              }
            }
            await attachConnectionCredential(
              client,
              tenantId,
              connection.id,
              AGENT_SECRET_ROLE,
              cred.id,
            );
            await resetAgentRow(client, tenantId, connection.id);
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw e;
          } finally {
            client.release();
          }
          req.log.info(
            { source: CONNECTOR_SOURCE, connectionId: connection.id },
            "argocd agent registered",
          );
          void reply.header("cache-control", "no-store");
          return reply.code(201).send({
            connection: agentView(connection, null),
            agentId: connection.id,
            // Shown once; Afe stores it encrypted and never returns it again.
            secret: secret.reveal(),
            ingest: {
              ...(ctx.config.publicUrl ? { url: ctx.config.publicUrl } : {}),
              batches: AGENT_PATHS.batches,
              heartbeat: AGENT_PATHS.heartbeat,
            },
            heartbeatIntervalSeconds: intervalS,
          });
        },
      );

      app.post<{ Params: { id: string }; Body: { graceSeconds?: number } | undefined }>(
        "/api/connections/argocd/agents/:id/rotate-secret",
        { config: { access: "admin" }, schema: { params: idParamsSchema, body: rotateBodySchema } },
        async (req, reply) => {
          const tenantId = requestTenant(req);
          const grace = req.body?.graceSeconds ?? 0;
          const secret = new Secret(generateAgentSecret());
          const client = await ctx.pool.connect();
          let expires: Date | null = null;
          try {
            await client.query("BEGIN");
            const connection = await getConnection(client, tenantId, req.params.id);
            if (!connection || !isAgentConnection(connection) || connection.status !== "active") {
              await client.query("ROLLBACK");
              return reply.code(404).send({ error: "not_found" });
            }
            const ids = await getConnectionCredentialIds(client, tenantId, connection.id);
            const cred = await storeCredential(client, ctx.keys, tenantId, {
              kind: AGENT_SECRET_KIND,
              secret,
            });
            const old = ids[AGENT_SECRET_ROLE];
            const oldPrevious = ids[AGENT_PREVIOUS_SECRET_ROLE];
            if (oldPrevious) await revokeCredential(client, tenantId, oldPrevious);
            if (old && grace > 0) {
              expires = new Date(now().getTime() + grace * 1000);
              await attachConnectionCredential(
                client,
                tenantId,
                connection.id,
                AGENT_PREVIOUS_SECRET_ROLE,
                old,
              );
            } else if (old) {
              await revokeCredential(client, tenantId, old);
            }
            await attachConnectionCredential(
              client,
              tenantId,
              connection.id,
              AGENT_SECRET_ROLE,
              cred.id,
            );
            await updateAgentRow(client, tenantId, connection.id, {
              previousSecretExpiresAt: expires,
            });
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw e;
          } finally {
            client.release();
          }
          req.log.info(
            { source: CONNECTOR_SOURCE, connectionId: req.params.id, graceSeconds: grace },
            "argocd agent secret rotated",
          );
          void reply.header("cache-control", "no-store");
          return {
            agentId: req.params.id,
            secret: secret.reveal(),
            previousSecretValidUntil: expires?.toISOString() ?? null,
          };
        },
      );

      // ---- agent endpoints (outside /api; HMAC-authenticated) ----

      app.post(
        AGENT_PATHS.heartbeat,
        { config: { access: "public" }, bodyLimit: 64 * 1024 },
        async (req, reply) => {
          const a = await authenticateAgent(ctx, req, reply);
          if (!a) return reply;
          let hb: AgentHeartbeat;
          try {
            hb = parseAgentHeartbeat(req.body);
          } catch (e) {
            if (e instanceof AgentProtocolError) {
              return reply.code(400).send({ error: "invalid_heartbeat", message: e.message });
            }
            throw e;
          }
          const fresh = await recordDelivery(
            ctx.pool,
            a.tenantId,
            AGENT_REPLAY_SOURCE,
            `heartbeat:${hb.heartbeatId}`,
            a.receivedAt,
          );
          if (!fresh) {
            const res: AgentHeartbeatResponse = {
              ok: true,
              resync: false,
              heartbeatIntervalSeconds: intervalS,
              serverTime: a.receivedAt.toISOString(),
            };
            return res;
          }
          return handleHeartbeat(ctx, a, hb);
        },
      );

      app.post(
        AGENT_PATHS.batches,
        { config: { access: "public" }, bodyLimit: 8 * 1024 * 1024 },
        async (req, reply) => {
          const a = await authenticateAgent(ctx, req, reply);
          if (!a) return reply;
          let batch: AgentBatch;
          try {
            batch = parseAgentBatch(req.body);
          } catch (e) {
            if (e instanceof AgentProtocolError) {
              return reply.code(400).send({ error: "invalid_batch", message: e.message });
            }
            throw e;
          }
          if ((await countPendingBatches(ctx.pool, a.tenantId, a.connectionId)) >= maxPending) {
            // Backpressure: the agent keeps the batch and retries later.
            return reply
              .code(429)
              .header("retry-after", "10")
              .send({ error: "busy", message: "too many unprocessed batches; retry later" });
          }
          const client = await ctx.pool.connect();
          let fresh: boolean;
          try {
            await client.query("BEGIN");
            fresh = await recordDelivery(
              client,
              a.tenantId,
              AGENT_REPLAY_SOURCE,
              batch.batchId,
              a.receivedAt,
            );
            if (fresh) {
              await stageBatch(
                client,
                a.tenantId,
                a.connectionId,
                batch.batchId,
                req.body as JsonObject,
                a.receivedAt,
              );
            }
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw e;
          } finally {
            client.release();
          }
          if (!fresh) {
            const res: AgentBatchResponse = { status: "duplicate" };
            return reply.code(200).send(res);
          }
          const job: AgentProcessJob = { tenantId: a.tenantId, connectionId: a.connectionId };
          await ctx.jobs.send(AGENT_PROCESS_JOB, job, {
            singletonKey: `${a.tenantId}:${a.connectionId}`,
          });
          const res: AgentBatchResponse = { status: "accepted" };
          return reply.code(202).send(res);
        },
      );
    },

    jobs(ctx: ServerContext): JobDefinition[] {
      return [
        {
          name: AGENT_PROCESS_JOB,
          retryLimit: 20,
          handler: async (data) => {
            const job = data as AgentProcessJob;
            if (!job.tenantId || !job.connectionId) return;
            const c = await getConnection(ctx.pool, job.tenantId, job.connectionId);
            if (!c || !isAgentConnection(c) || c.status !== "active") return;
            await processPending(ctx, job.tenantId, job.connectionId);
          },
        },
        {
          name: AGENT_SWEEP_JOB,
          schedule: "* * * * *",
          scheduleData: {},
          handler: async () => {
            for (const p of await listConnectionsWithPendingBatches(ctx.pool)) {
              const job: AgentProcessJob = { tenantId: p.tenantId, connectionId: p.connectionId };
              await ctx.jobs.send(AGENT_PROCESS_JOB, job, {
                singletonKey: `${p.tenantId}:${p.connectionId}`,
              });
            }
          },
        },
        {
          name: AGENT_HEARTBEAT_CHECK_JOB,
          schedule: "* * * * *",
          scheduleData: {},
          handler: async () => {
            const at = now();
            const silent = await listSilentAgentsAcrossTenants(
              ctx.pool,
              new Date(at.getTime() - staleMs),
            );
            for (const row of silent) {
              const detail = `no heartbeat from the agent since ${row.lastHeartbeatAt!.toISOString()}`;
              await updateAgentRow(ctx.pool, row.tenantId, row.connectionId, {
                silenceReportedAt: at,
                ...awaitingPatch(at, detail, row.runId, row.droppedTotal, true),
              });
              await reportLoss(
                ctx,
                row.tenantId,
                row.connectionId,
                { reason: "unreachable", detail },
                at,
              );
            }
          },
        },
      ];
    },
  };
}

export const argocdAgentModule: ConnectorModule = createArgoCdAgentModule();
