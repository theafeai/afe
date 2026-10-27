/**
 * Audit query API and verifiable export (AFE-14). Reference: docs/api.md and
 * docs/export-verification.md.
 *
 * Authentication (AFE-27, ADR 0006): the server's auth hook authenticates
 * every request before these handlers run; the tenant is the authenticated
 * principal's (`requestTenant`), never a request field.
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createDefaultAuditExporter,
  DEPLOYMENT_VIEW_ACTIONS,
  EventFilterError,
  ExportFormatError,
  exportSignerFromEnv,
  hashEvent,
  normaliseEventFilter,
  parseEventFilterParams,
  type AuditExporter,
  type CanonicalEvent,
  type EventFilter,
  type ExportSigner,
  type TenantResolver,
} from "@afe/core";
import {
  getChainHead,
  getEvent,
  getEventBySeq,
  getRawPayload,
  InvalidCursorError,
  openEventExport,
  queryEvents,
  verifyTenantChain,
} from "@afe/db";
import { requestTenant } from "../auth/index.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";

export interface EventsApiOptions {
  /**
   * Overrides the tenant of a request (receives the authenticated principal).
   * Default: the tenant set by the server's auth hook.
   */
  tenantResolver?: TenantResolver;
  /** Defaults to CSV/JSON with integrity proof, signed when a signer is available. */
  exporter?: AuditExporter;
  /** Manifest signer for the default exporter; defaults to AFE_EXPORT_SIGNING_KEY (unsigned if unset). */
  signer?: ExportSigner | null;
}

export const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;
const PAGE_PARAMS = ["order", "limit", "cursor"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

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
    err instanceof InvalidCursorError ||
    err instanceof ExportFormatError
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
      const signer =
        options.signer !== undefined
          ? options.signer
          : options.exporter
            ? null
            : exportSignerFromEnv();
      const exporter = options.exporter ?? createDefaultAuditExporter({ signer });
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
          // Service/environment from the tenant's mapping (AFE-19), resolved at read time.
          const placements = ctx.mapping
            ? await ctx.mapping.placements(tenantId, result.events)
            : null;
          return {
            items: result.events.map((e) => ({
              ...deploymentRow(e),
              ...(placements ? { placement: placements.get(e.id) ?? null } : {}),
            })),
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
        const prev = event.seq > 1 ? await getEventBySeq(ctx.pool, tenantId, event.seq - 1) : null;
        const raw = event.rawPayload
          ? await getRawPayload(ctx.pool, tenantId, event.rawPayload.id)
          : null;
        const head = await getChainHead(ctx.pool, tenantId);
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
                // Bytes as stored now hash to the value covered by the event hash.
                verified: raw !== null && raw.actualSha256 === event.rawPayload.sha256,
                url: `/api/events/${event.id}/raw`,
              }
            : null,
          chain: {
            seq: event.seq,
            prevHash: event.prevHash,
            hash: event.hash,
            hashVerified: hashEvent(event) === event.hash,
            prevLinkVerified:
              event.seq === 1 ? event.prevHash === "0".repeat(64) : prev?.hash === event.prevHash,
            head,
          },
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
          .header("x-afe-raw-verified", String(raw.actualSha256 === event.rawPayload.sha256))
          .header("x-afe-original-content-type", raw.contentType.replace(/[^\x20-\x7e]/g, ""))
          .send(raw.body);
      });

      app.get("/api/audit/verify", async (req, reply) => {
        try {
          const tenantId = await tenantOf(req);
          const q = query(req);
          for (const k of Object.keys(q)) {
            if (k !== "anchorSeq" && k !== "anchorHash")
              throw new BadRequest(`unknown query parameter ${k}`);
          }
          const anchorSeqRaw = single(q, "anchorSeq");
          const anchorHash = single(q, "anchorHash");
          if ((anchorSeqRaw === undefined) !== (anchorHash === undefined)) {
            throw new BadRequest("anchorSeq and anchorHash go together");
          }
          const result = await verifyTenantChain(ctx.pool, tenantId);
          const head = await getChainHead(ctx.pool, tenantId);
          let anchor: { seq: number; hash: string; found: boolean; matches: boolean } | null = null;
          if (anchorSeqRaw !== undefined && anchorHash !== undefined) {
            const seq = Number(anchorSeqRaw);
            if (!Number.isSafeInteger(seq) || seq < 0 || !HEX64.test(anchorHash)) {
              throw new BadRequest("anchorSeq must be an integer and anchorHash 64 hex characters");
            }
            const ev = seq === 0 ? null : await getEventBySeq(ctx.pool, tenantId, seq);
            const actual = seq === 0 ? "0".repeat(64) : (ev?.hash ?? null);
            anchor = {
              seq,
              hash: anchorHash,
              found: actual !== null,
              matches: actual === anchorHash,
            };
          }
          // Chain anchors outside the database (AFE-29); null when the module is not registered.
          const anchors = ctx.anchors ? await ctx.anchors.status(tenantId) : null;
          return {
            ok: result.ok && (anchor === null || anchor.matches) && (anchors?.ok ?? true),
            verification: result,
            head,
            anchor,
            anchors,
          };
        } catch (err) {
          return sendError(reply, err);
        }
      });

      app.get("/api/export/public-key", async (_req, reply) => {
        if (!signer)
          return reply.code(404).send({ error: "not_found", message: "exports are not signed" });
        return { algorithm: signer.algorithm, keyId: signer.keyId, publicKey: signer.publicKey };
      });

      app.get("/api/export", async (req, reply) => {
        let format: string;
        let filter: EventFilter;
        let includeRaw: boolean;
        let tenantId: string;
        try {
          tenantId = await tenantOf(req);
          const q = query(req);
          format = single(q, "format") ?? "json";
          if (!exporter.formats.includes(format)) {
            throw new BadRequest(`format must be one of ${exporter.formats.join(", ")}`);
          }
          const rawParam = single(q, "raw") ?? "false";
          if (rawParam !== "true" && rawParam !== "false")
            throw new BadRequest("raw must be true or false");
          includeRaw = rawParam === "true";
          const view = single(q, "view");
          if (view !== undefined && view !== "events" && view !== "deployments") {
            throw new BadRequest("view must be events or deployments");
          }
          filter = parseEventFilterParams(q, ["format", "raw", "view"]);
          if (view === "deployments") filter = deploymentsFilter(filter);
        } catch (err) {
          return sendError(reply, err);
        }

        const snapshot = await openEventExport(ctx.pool, tenantId, filter, {
          includeRawPayloads: includeRaw,
        });
        const exportId = randomUUID();
        // Anchor the exported head and embed the newest receipts (AFE-29).
        const anchors = ctx.anchors
          ? await ctx.anchors.receiptsForExport(tenantId, snapshot.chainHead)
          : [];
        const createdAt = new Date();
        let result;
        try {
          result = exporter.export({
            tenantId,
            format,
            filter,
            chainHead: snapshot.chainHead,
            exportId,
            createdAt,
            includeRawPayloads: includeRaw,
            ...(anchors.length > 0 ? { anchors } : {}),
            records: snapshot.records,
          });
        } catch (err) {
          await snapshot.close();
          return sendError(reply, err);
        }
        const stamp = createdAt
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d+Z$/, "Z");
        const safeTenant = tenantId.replace(/[^A-Za-z0-9_-]/g, "_");
        const stream = Readable.from(result.chunks);
        stream.on("close", () => void snapshot.close());
        return reply
          .header("content-type", result.contentType)
          .header(
            "content-disposition",
            `attachment; filename="afe-export-${safeTenant}-${stamp}.${result.fileExtension}"`,
          )
          .header("x-afe-export-id", exportId)
          .header("cache-control", "no-store")
          .send(stream);
      });
    },
  };
}

/** The module registered by default (OSS tenant resolver and exporter). */
export const eventsApiModule: ConnectorModule = createEventsApiModule();
