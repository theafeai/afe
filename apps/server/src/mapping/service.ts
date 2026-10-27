/**
 * Mapping service (AFE-19): loads and compiles a tenant's mapping
 * configuration (cached per revision), resolves events at read time, and
 * appends the audit events of mapping changes from the outbox.
 */
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import {
  normaliseEventFilter,
  DEPLOYMENT_VIEW_ACTIONS,
  type CanonicalEvent,
  type CanonicalEventInputLike,
  type EventSink,
} from "@afe/core";
import {
  compileMapping,
  observationsOf,
  type CompiledMapping,
  type MappableEvent,
  type MappingConfig,
  type PlacementConfidence,
  type PlacementResolution,
} from "@afe/core/mapping";
import {
  deleteMappingAuditOutboxEntry,
  getMappingConfig,
  getMappingRevision,
  listMappingAuditOutboxAcrossTenants,
  queryEvents,
  recordMappingAuditOutboxFailure,
  type StoredMappingConfig,
} from "@afe/db";

/** Resolved placement as returned by the API (ids plus display names). */
export interface PlacementView {
  service: { id: string; name: string } | null;
  environment: { id: string; name: string; kind: string; order: number } | null;
  confidence: PlacementConfidence;
  matchedRuleIds: string[];
  /** Dimensions no rule assigned; shown as "unmapped", never guessed. */
  unmapped: ("service" | "environment")[];
}

export function placementView(config: MappingConfig, r: PlacementResolution): PlacementView {
  const s = r.serviceId ? config.services.find((x) => x.id === r.serviceId) : undefined;
  const e = r.environmentId ? config.environments.find((x) => x.id === r.environmentId) : undefined;
  const unmapped: PlacementView["unmapped"] = [];
  if (!s) unmapped.push("service");
  if (!e) unmapped.push("environment");
  return {
    service: s ? { id: s.id, name: s.name } : null,
    environment: e ? { id: e.id, name: e.name, kind: e.kind, order: e.order } : null,
    confidence: r.confidence,
    matchedRuleIds: r.matchedRuleIds,
    unmapped,
  };
}

/** Raw payload bodies larger than this are not parsed for labels. */
const MAX_LABEL_BODY = 1024 * 1024;

function labelsFromBody(body: Buffer): Record<string, string> | null {
  if (body.length > MAX_LABEL_BODY) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  const o = parsed as {
    application?: { metadata?: { labels?: unknown } };
    metadata?: { labels?: unknown };
  } | null;
  const labels = o?.application?.metadata?.labels ?? o?.metadata?.labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels as Record<string, unknown>).slice(0, 100)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export interface LoadedMapping {
  config: StoredMappingConfig;
  mapping: CompiledMapping;
}

export class MappingService {
  readonly #cache = new Map<string, LoadedMapping>();

  constructor(
    readonly pool: pg.Pool,
    readonly sink: EventSink,
    readonly log: FastifyBaseLogger,
  ) {}

  /** The tenant's current configuration, compiled (cached per revision). */
  async load(tenantId: string): Promise<LoadedMapping> {
    const revision = await getMappingRevision(this.pool, tenantId);
    const hit = this.#cache.get(tenantId);
    if (hit && hit.config.revision === revision) return hit;
    const config = await getMappingConfig(this.pool, tenantId);
    const loaded = { config, mapping: compileMapping(config) };
    if (this.#cache.size > 1000) this.#cache.clear();
    this.#cache.set(tenantId, loaded);
    return loaded;
  }

  /**
   * Events with ArgoCD application labels attached (read from the stored raw
   * payload), for rules on `argocd.label:<key>`. Events without labels are
   * returned as they are.
   */
  async withLabels(tenantId: string, events: CanonicalEvent[]): Promise<MappableEvent[]> {
    const argo = events.filter((e) => e.source === "argocd" && e.rawPayload);
    if (argo.length === 0) return events;
    const { rows } = await this.pool.query<{ id: string; body: Buffer }>(
      `SELECT e.id, r.body FROM events e
         JOIN raw_payloads r ON r.tenant_id = e.tenant_id AND r.id = e.raw_payload_id
        WHERE e.tenant_id = $1 AND e.id = ANY($2::uuid[]) AND r.content_type LIKE 'application/json%'`,
      [tenantId, argo.map((e) => e.id)],
    );
    const labels = new Map<string, Record<string, string>>();
    for (const r of rows) {
      const l = labelsFromBody(r.body);
      if (l) labels.set(r.id, l);
    }
    return events.map((e) => {
      const l = labels.get(e.id);
      return l ? { ...e, labels: l } : e;
    });
  }

  /** Placement of each event under the tenant's current mapping. */
  async placements(tenantId: string, events: CanonicalEvent[]): Promise<Map<string, PlacementView>> {
    const out = new Map<string, PlacementView>();
    if (events.length === 0) return out;
    const { config, mapping } = await this.load(tenantId);
    const mappable = mapping.usesLabels ? await this.withLabels(tenantId, events) : events;
    for (const [i, e] of mappable.entries()) {
      out.set(
        events[i]!.id,
        placementView(config, mapping.resolveObservations(e.source, observationsOf(e))),
      );
    }
    return out;
  }

  /** The most recent deployment-view events (the sample for preview and unmapped values). */
  async recentDeploymentEvents(tenantId: string, limit: number): Promise<CanonicalEvent[]> {
    const filter = normaliseEventFilter({ actions: [...DEPLOYMENT_VIEW_ACTIONS] });
    const page = await queryEvents(this.pool, tenantId, { filter, order: "desc", limit });
    return page.events;
  }

  /** Appends a committed change's audit event and clears its outbox entry. */
  async publish(tenantId: string, outboxId: string, event: CanonicalEventInputLike): Promise<void> {
    try {
      await this.sink.ingest(tenantId, event);
      await deleteMappingAuditOutboxEntry(this.pool, tenantId, outboxId);
    } catch (err) {
      // The outbox job retries; ingestion is idempotent (key: mapping revision).
      this.log.warn({ err: (err as Error).message }, "mapping audit event not appended yet");
      await recordMappingAuditOutboxFailure(
        this.pool,
        tenantId,
        outboxId,
        (err as Error).message,
      ).catch(() => {});
    }
  }

  /** Appends pending audit events (job `mapping.audit-outbox`). Returns how many were appended. */
  async flushOutbox(limit = 100): Promise<number> {
    let done = 0;
    for (const entry of await listMappingAuditOutboxAcrossTenants(this.pool, limit)) {
      try {
        await this.sink.ingest(entry.tenantId, entry.event as unknown as CanonicalEventInputLike);
        await deleteMappingAuditOutboxEntry(this.pool, entry.tenantId, entry.id);
        done++;
      } catch (err) {
        await recordMappingAuditOutboxFailure(
          this.pool,
          entry.tenantId,
          entry.id,
          (err as Error).message,
        );
      }
    }
    return done;
  }
}
