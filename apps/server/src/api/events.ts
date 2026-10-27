/**
 * Event query API (AFE-14): events, deployments, event detail and raw
 * payload download. Reference: docs/api.md.
 *
 * Authentication (AFE-27, ADR 0006): the server's auth hook authenticates
 * every request before these handlers run; the tenant is the authenticated
 * principal's (`requestTenant`), never a request field.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  DEPLOYMENT_VIEW_ACTIONS,
  EventFilterError,
  normaliseEventFilter,
  parseEventFilterParams,
  type CanonicalEvent,
  type EventFilter,
  type TenantResolver,
} from "@afe/core";
import { getEvent, getRawPayload, InvalidCursorError, queryEvents } from "@afe/db";
import { requestTenant } from "../auth/index.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";

export interface EventsApiOptions {
  /**
   * Overrides the tenant of a request (receives the authenticated principal).
   * Default: the tenant set by the server's auth hook.
   */
  tenantResolver?: TenantResolver;
}

export const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;
const PAGE_PARAMS = ["order", "limit", "cursor"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BadRequest extends Error {}

/** Provenance summary shown with every event. */
export function provenanceOf(e: CanonicalEvent) {
  return {
    source: e.source,
    sourceEventId: e.sourceEventId,
    method: e.observation.method,
    discoveredByReconciliation: e.observation.method === "reconciliation",
    deliveryId: e.observation.deliveryId ?? null,
    jobId: e.observation.jobId ?? null,
    connectionId: e.connectionId,
    observedAt: e.observedAt,
    recordedAt: e.recordedAt,
  };
}

/** One row of the deployments view: who deployed what, to where, and when. */
export function deploymentRow(e: CanonicalEvent) {
  const c = e.correlation;
  return {
    eventId: e.id,
    seq: e.seq,
    when: e.occurredAt,
    source: e.source,
    action: e.action,
    outcome: e.outcome,
    who: {
      type: e.actor.type,
      id: e.actor.id ?? null,
      login: e.actor.login ?? null,
      name: e.actor.name ?? null,
      onBehalfOf: e.actor.onBehalfOf ?? null,
      triggeredBy: e.actor.triggeredBy ?? null,
    },
    what: {
      commitShas: c.commitShas ?? [],
      refs: c.refs ?? (e.target.ref ? [e.target.ref] : []),
      imageRefs: c.imageRefs ?? [],
      imageDigests: c.imageDigests ?? [],
      deploymentIds: c.deploymentIds ?? [],
    },
    where: {
      environment: e.target.environment ?? c.environments?.[0] ?? null,
      targetType: e.target.type,
      targetId: e.target.id,
      targetName: e.target.name ?? null,
      repository: e.target.repository ?? null,
      project: e.target.project ?? null,
      application: e.target.application ?? null,
      cluster: e.target.cluster ?? null,
      namespace: e.target.namespace ?? null,
      url: e.target.url ?? null,
    },
    how: e.trigger,
    provenance: provenanceOf(e),
  };
}

function single(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) throw new BadRequest(`${key} may only be given once`);
  return String(v);
}

function pageParams(q: Record<string, unknown>) {
  const order = single(q, "order") ?? "desc";
  if (order !== "asc" && order !== "desc") throw new BadRequest("order must be asc or desc");
  const limitRaw = single(q, "limit");
  const limit = limitRaw === undefined ? DEFAULT_PAGE_SIZE : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new BadRequest(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return { order: order as "asc" | "desc", limit, cursor: single(q, "cursor") ?? null };
}

function deploymentsFilter(filter: EventFilter): EventFilter {
  if (filter.actions) return filter;
  return normaliseEventFilter({ ...filter, actions: [...DEPLOYMENT_VIEW_ACTIONS] });
}

function sendError(reply: FastifyReply, err: unknown) {
  if (
    err instanceof BadRequest ||
    err instanceof EventFilterError ||
    err instanceof InvalidCursorError
  ) {
    return reply.code(400).send({ error: "bad_request", message: err.message });
  }
  throw err;
}

export function createEventsApiModule(options: EventsApiOptions = {}): ConnectorModule {
  const tenants = options.tenantResolver;
  return {
    source: "api",
    routes(app, ctx: ServerContext) {
      const tenantOf = async (req: FastifyRequest) => {
        const tenantId = requestTenant(req);
        return tenants
          ? tenants.resolveTenant({ headers: req.headers, principal: req.principal })
          : tenantId;
      };
      const query = (req: FastifyRequest) => (req.query ?? {}) as Record<string, unknown>;

      app.get("/api/events", async (req, reply) => {
        try {
          const tenantId = await tenantOf(req);
          const q = query(req);
          const page = pageParams(q);
          const filter = parseEventFilterParams(q, PAGE_PARAMS);
          const result = await queryEvents(ctx.pool, tenantId, { filter, ...page });
          return {
            items: result.events.map((event) => ({ event, provenance: provenanceOf(event) })),
            nextCursor: result.nextCursor,
            snapshotSeq: result.snapshotSeq,
          };
        } catch (err) {
          return sendError(reply, err);
        }
      });

      app.get("/api/deployments", async (req, reply) => {
        try {
          const tenantId = await tenantOf(req);
          const q = query(req);
          const page = pageParams(q);
          const filter = deploymentsFilter(parseEventFilterParams(q, PAGE_PARAMS));
          const result = await queryEvents(ctx.pool, tenantId, { filter, ...page });
          return {
            items: result.events.map(deploymentRow),
            nextCursor: result.nextCursor,
            snapshotSeq: result.snapshotSeq,
          };
        } catch (err) {
          return sendError(reply, err);
        }
      });

      app.get<{ Params: { id: string } }>("/api/events/:id", async (req, reply) => {
        const tenantId = await tenantOf(req);
        if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
        const event = await getEvent(ctx.pool, tenantId, req.params.id);
        if (!event) return reply.code(404).send({ error: "not_found" });
        const raw = event.rawPayload
          ? await getRawPayload(ctx.pool, tenantId, event.rawPayload.id)
          : null;
        return {
          event,
          provenance: provenanceOf(event),
          rawPayload: event.rawPayload
            ? {
                id: event.rawPayload.id,
                sha256: event.rawPayload.sha256,
                contentType: raw?.contentType ?? null,
                sizeBytes: raw?.sizeBytes ?? null,
                receivedAt: raw?.receivedAt ?? null,
                url: `/api/events/${event.id}/raw`,
              }
            : null,
        };
      });

      app.get<{ Params: { id: string } }>("/api/events/:id/raw", async (req, reply) => {
        const tenantId = await tenantOf(req);
        if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
        const event = await getEvent(ctx.pool, tenantId, req.params.id);
        if (!event?.rawPayload) return reply.code(404).send({ error: "not_found" });
        const raw = await getRawPayload(ctx.pool, tenantId, event.rawPayload.id);
        if (!raw) return reply.code(404).send({ error: "not_found" });
        // Raw payloads are stored without secrets (docs/security/data-inventory.md).
        // Serve them as inert downloads: never let a browser render source content.
        const safeType = /^(application\/json|text\/plain)\b/i.test(raw.contentType)
          ? raw.contentType
          : "application/octet-stream";
        return reply
          .header("content-type", safeType)
          .header("content-disposition", `attachment; filename="${raw.id}.raw"`)
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .header("x-afe-raw-sha256", raw.sha256)
          .header("x-afe-original-content-type", raw.contentType.replace(/[^\x20-\x7e]/g, ""))
          .send(raw.body);
      });
    },
  };
}

/** The module registered by default (tenant from the authenticated principal). */
export const eventsApiModule: ConnectorModule = createEventsApiModule();
