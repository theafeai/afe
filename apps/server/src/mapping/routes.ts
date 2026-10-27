/**
 * Mapping API (AFE-19), reference in docs/api.md "Environment and service
 * mapping". Reads are viewer, changes admin (ADR 0006 defaults); the preview
 * is a dry run and only needs viewer. The tenant is always the authenticated
 * principal's (`requestTenant`); another tenant's ids answer 404.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ACTIONS,
  sourceEventId,
  type CanonicalEvent,
  type CanonicalEventInputLike,
  type JsonObject,
  type Principal,
} from "@afe/core";
import {
  BUILTIN_RULES,
  compileMapping,
  describeIssues,
  environmentInputSchema,
  MAPPING_FIELDS,
  MAPPING_ID_PATTERN,
  MAPPING_LIMITS,
  observationsOf,
  proposedRuleSchema,
  reorderInputSchema,
  ruleInputSchema,
  serviceInputSchema,
  slugify,
  builtinToggleSchema,
  toRule,
  ENVIRONMENT_KINDS,
  type Environment,
  type MappingConfig,
  type MappingRule,
  type PlacementConfidence,
  type RuleKind,
  type Service,
} from "@afe/core/mapping";
import {
  changeMapping,
  countMappingServices,
  deleteMappingEnvironment,
  deleteMappingRule,
  deleteMappingService,
  getMappingEnvironment,
  getMappingRule,
  getMappingService,
  insertMappingEnvironment,
  insertMappingRule,
  insertMappingService,
  listMappingEnvironments,
  listMappingRules,
  mappingRulesReferencing,
  MappingConflictError,
  maxMappingRulePriority,
  setBuiltinRuleOverride,
  setMappingRuleOrder,
  updateMappingEnvironment,
  updateMappingRule,
  updateMappingService,
  type MappingChange,
} from "@afe/db";
import { requestTenant } from "../auth/index.ts";
import type { ServerContext } from "../context.ts";
import { placementView, type MappingService, type PlacementView } from "./service.ts";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const notFound = () => new HttpError(404, "not_found", "not found");

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, "bad_request", describeIssues(r.error));
  return r.data;
}

function send(reply: FastifyReply, err: unknown) {
  if (err instanceof HttpError) {
    return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
  }
  if (err instanceof MappingConflictError) {
    return reply.code(409).send({ error: "conflict", message: err.message });
  }
  throw err;
}

/** Who made the change, from the authenticated principal (never a request field). */
function actorOf(p: Principal | undefined) {
  if (!p) return { type: "unknown" as const };
  const type = p.kind === "token" || p.kind === "session" ? ("token" as const) : ("user" as const);
  return { type, id: p.id, ...(p.name ? { name: p.name } : {}) };
}

type Summary = JsonObject | null;
const serviceSummary = (s: Service | null): Summary =>
  s ? { id: s.id, name: s.name, description: s.description ?? null } : null;
const environmentSummary = (e: Environment | null): Summary =>
  e ? { id: e.id, name: e.name, kind: e.kind, order: e.order } : null;
const ruleSummary = (r: MappingRule | null): Summary =>
  r
    ? {
        id: r.id,
        kind: r.kind,
        field: r.field,
        match: r.match,
        pattern: r.pattern,
        caseSensitive: r.caseSensitive,
        priority: r.priority,
        targetId: r.targetId,
        enabled: r.enabled,
        note: r.note ?? null,
      }
    : null;

interface ChangeDescription {
  entity: "service" | "environment" | "rule" | "builtin_rule" | "rule_order";
  operation: "created" | "updated" | "deleted" | "reordered";
  id: string;
  before: Summary;
  after: Summary;
}

/** The `config.mapping.changed` audit event (source afe) for one change. */
export function mappingChangedEvent(
  principal: Principal | undefined,
  revision: number,
  change: ChangeDescription,
  at: Date = new Date(),
): CanonicalEventInputLike {
  return {
    source: "afe",
    sourceEventId: sourceEventId("config_mapping", revision),
    action: ACTIONS.CONFIG_MAPPING_CHANGED,
    actor: actorOf(principal),
    target: { type: "other", id: "mapping", name: "Environment and service mapping" },
    trigger: { type: "manual", sourceValue: "api" },
    outcome: "succeeded",
    occurredAt: at,
    observedAt: at,
    observation: { method: "internal" },
    data: {
      revision,
      entity: change.entity,
      operation: change.operation,
      id: change.id,
      before: change.before,
      after: change.after,
    },
  };
}

const previewSchema = z.strictObject({
  rules: z.array(proposedRuleSchema).max(MAPPING_LIMITS.rulesPerKind * 2).optional(),
  services: z
    .array(serviceInputSchema)
    .max(MAPPING_LIMITS.services)
    .optional(),
  environments: z.array(environmentInputSchema).max(MAPPING_LIMITS.environments).optional(),
  builtinOverrides: z.record(z.string().max(80), z.boolean()).optional(),
  /** How many recent deployment events to classify (default 200). */
  limit: z.number().int().min(1).max(1000).optional(),
  /** How many classified events to return (default 50; changed ones first). */
  items: z.number().int().min(0).max(500).optional(),
});

function labelOf(e: CanonicalEvent): string {
  const t = e.target;
  const projectName = typeof e.data?.projectName === "string" ? e.data.projectName : undefined;
  return t.application ?? projectName ?? t.name ?? t.project ?? t.repository ?? t.id;
}

function counts(views: PlacementView[]): Record<PlacementConfidence, number> {
  const c: Record<PlacementConfidence, number> = {
    configured: 0,
    default: 0,
    partial: 0,
    unmapped: 0,
  };
  for (const v of views) c[v.confidence]++;
  return c;
}

const sameView = (a: PlacementView, b: PlacementView) =>
  a.service?.id === b.service?.id &&
  a.environment?.id === b.environment?.id &&
  a.confidence === b.confidence;

function limitParam(q: Record<string, unknown>, def: number): number {
  const raw = q.limit;
  if (raw === undefined) return def;
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isInteger(n) || n < 1 || n > 1000) {
    throw new HttpError(400, "bad_request", "limit must be an integer from 1 to 1000");
  }
  return n;
}

export function registerMappingRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  service: MappingService,
): void {
  const pool = ctx.pool;

  /** Runs one audited change and appends its audit event after commit. */
  async function change<T>(
    req: FastifyRequest,
    apply: (
      tx: Parameters<Parameters<typeof changeMapping>[2]>[0],
      revision: number,
    ) => Promise<{ result: T; change: ChangeDescription }>,
  ): Promise<{ result: T; revision: number }> {
    const tenantId = requestTenant(req);
    const done = await changeMapping(pool, tenantId, async (tx, revision) => {
      const r = await apply(tx, revision);
      return {
        result: r.result,
        event: mappingChangedEvent(req.principal, revision, r.change),
      } satisfies MappingChange<T>;
    });
    await service.publish(tenantId, done.outboxId, done.event);
    return { result: done.result, revision: done.revision };
  }

  app.get("/api/mapping", async (req) => {
    const tenantId = requestTenant(req);
    const { config, mapping } = await service.load(tenantId);
    const inactive = new Map(mapping.inactive.map((i) => [i.ruleId, i.reason]));
    return {
      revision: config.revision,
      customised: config.customised,
      services: config.services,
      environments: config.environments,
      rules: config.rules.map((r) => ({ ...r, inactiveReason: inactive.get(r.id) ?? null })),
      builtinRules: BUILTIN_RULES.map((r) => ({
        ...r,
        enabled: config.builtinOverrides[r.id] ?? r.enabled,
        inactiveReason: inactive.get(r.id) ?? null,
      })),
      fields: [...MAPPING_FIELDS, "argocd.label:<key>"],
      environmentKinds: ENVIRONMENT_KINDS,
    };
  });

  // --- Services ---------------------------------------------------------------

  app.post("/api/mapping/services", async (req, reply) => {
    try {
      const input = parse(serviceInputSchema, req.body);
      const s: Service = {
        id: input.id ?? slugify(input.name),
        name: input.name,
        description: input.description ?? null,
      };
      if (!MAPPING_ID_PATTERN.test(s.id)) throw new HttpError(400, "bad_request", "invalid id");
      const { result, revision } = await change(req, async (tx, _rev) => {
        if ((await countMappingServices(tx, requestTenant(req))) >= MAPPING_LIMITS.services) {
          throw new HttpError(400, "bad_request", "too many services");
        }
        const created = await insertMappingService(tx, requestTenant(req), s);
        return {
          result: created,
          change: {
            entity: "service",
            operation: "created",
            id: created.id,
            before: null,
            after: serviceSummary(created),
          },
        };
      });
      return reply.code(201).send({ service: result, revision });
    } catch (err) {
      return send(reply, err);
    }
  });

  app.put<{ Params: { id: string } }>("/api/mapping/services/:id", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      if (!(await getMappingService(pool, tenantId, req.params.id))) throw notFound();
      const input = parse(serviceInputSchema, req.body);
      if (input.id && input.id !== req.params.id) {
        throw new HttpError(400, "bad_request", "the id cannot be changed");
      }
      const { result, revision } = await change(req, async (tx) => {
        const before = await getMappingService(tx, tenantId, req.params.id);
        if (!before) throw notFound();
        const after = await updateMappingService(tx, tenantId, {
          id: before.id,
          name: input.name,
          description: input.description ?? null,
        });
        return {
          result: after!,
          change: {
            entity: "service",
            operation: "updated",
            id: before.id,
            before: serviceSummary(before),
            after: serviceSummary(after),
          },
        };
      });
      return { service: result, revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/mapping/services/:id", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      if (!(await getMappingService(pool, tenantId, req.params.id))) throw notFound();
      const { revision } = await change(req, async (tx) => {
        const before = await getMappingService(tx, tenantId, req.params.id);
        if (!before) throw notFound();
        const used = await mappingRulesReferencing(tx, tenantId, "service", before.id);
        if (used.length > 0) {
          throw new HttpError(409, "in_use", "rules assign this service; delete them first", {
            ruleIds: used,
          });
        }
        await deleteMappingService(tx, tenantId, before.id);
        return {
          result: null,
          change: {
            entity: "service",
            operation: "deleted",
            id: before.id,
            before: serviceSummary(before),
            after: null,
          },
        };
      });
      return { ok: true, revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  // --- Environments -------------------------------------------------------------

  app.post("/api/mapping/environments", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const input = parse(environmentInputSchema, req.body);
      const id = input.id ?? slugify(input.name);
      const { result, revision } = await change(req, async (tx) => {
        const existing = await listMappingEnvironments(tx, tenantId);
        if (existing.length >= MAPPING_LIMITS.environments) {
          throw new HttpError(400, "bad_request", "too many environments");
        }
        const order = input.order ?? Math.max(0, ...existing.map((e) => e.order)) + 10;
        const created = await insertMappingEnvironment(tx, tenantId, {
          id,
          name: input.name,
          kind: input.kind,
          order,
        });
        return {
          result: created,
          change: {
            entity: "environment",
            operation: "created",
            id: created.id,
            before: null,
            after: environmentSummary(created),
          },
        };
      });
      return reply.code(201).send({ environment: result, revision });
    } catch (err) {
      return send(reply, err);
    }
  });

  /** Environments exist for the tenant (defaults until the first change). */
  const environmentExists = async (tenantId: string, id: string) => {
    const { config } = await service.load(tenantId);
    return config.environments.some((e) => e.id === id);
  };

  app.put<{ Params: { id: string } }>("/api/mapping/environments/:id", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      if (!(await environmentExists(tenantId, req.params.id))) throw notFound();
      const input = parse(environmentInputSchema, req.body);
      if (input.id && input.id !== req.params.id) {
        throw new HttpError(400, "bad_request", "the id cannot be changed");
      }
      const { result, revision } = await change(req, async (tx) => {
        const before = await getMappingEnvironment(tx, tenantId, req.params.id);
        if (!before) throw notFound();
        const after = await updateMappingEnvironment(tx, tenantId, {
          id: before.id,
          name: input.name,
          kind: input.kind,
          order: input.order ?? before.order,
        });
        return {
          result: after!,
          change: {
            entity: "environment",
            operation: "updated",
            id: before.id,
            before: environmentSummary(before),
            after: environmentSummary(after),
          },
        };
      });
      return { environment: result, revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/mapping/environments/:id", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      if (!(await environmentExists(tenantId, req.params.id))) throw notFound();
      const { revision } = await change(req, async (tx) => {
        const before = await getMappingEnvironment(tx, tenantId, req.params.id);
        if (!before) throw notFound();
        const used = await mappingRulesReferencing(tx, tenantId, "environment", before.id);
        if (used.length > 0) {
          throw new HttpError(409, "in_use", "rules assign this environment; delete them first", {
            ruleIds: used,
          });
        }
        await deleteMappingEnvironment(tx, tenantId, before.id);
        return {
          result: null,
          change: {
            entity: "environment",
            operation: "deleted",
            id: before.id,
            before: environmentSummary(before),
            after: null,
          },
        };
      });
      return { ok: true, revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  // --- Rules ----------------------------------------------------------------------

  async function checkTarget(
    tx: Parameters<typeof getMappingService>[0],
    tenantId: string,
    kind: RuleKind,
    targetId: string,
  ) {
    const exists =
      kind === "service"
        ? await getMappingService(tx, tenantId, targetId)
        : await getMappingEnvironment(tx, tenantId, targetId);
    if (!exists) throw new HttpError(400, "bad_request", `${kind} ${targetId} does not exist`);
  }

  app.post("/api/mapping/rules", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const input = parse(ruleInputSchema, req.body);
      const { result, revision } = await change(req, async (tx) => {
        await checkTarget(tx, tenantId, input.kind, input.targetId);
        const existing = await listMappingRules(tx, tenantId, input.kind);
        if (existing.length >= MAPPING_LIMITS.rulesPerKind) {
          throw new HttpError(400, "bad_request", "too many rules");
        }
        const priority = (await maxMappingRulePriority(tx, tenantId, input.kind)) + 10;
        const created = await insertMappingRule(tx, tenantId, toRule(randomUUID(), input, priority));
        return {
          result: created,
          change: {
            entity: "rule",
            operation: "created",
            id: created.id,
            before: null,
            after: ruleSummary(created),
          },
        };
      });
      return reply.code(201).send({ rule: result, revision });
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post("/api/mapping/rules/reorder", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const input = parse(reorderInputSchema, req.body);
      const { result, revision } = await change(req, async (tx) => {
        const existing = await listMappingRules(tx, tenantId, input.kind);
        const have = new Set(existing.map((r) => r.id));
        if (
          input.ids.length !== have.size ||
          new Set(input.ids).size !== input.ids.length ||
          !input.ids.every((id) => have.has(id))
        ) {
          throw new HttpError(
            400,
            "bad_request",
            `ids must list every ${input.kind} rule exactly once`,
          );
        }
        await setMappingRuleOrder(tx, tenantId, input.ids);
        return {
          result: await listMappingRules(tx, tenantId, input.kind),
          change: {
            entity: "rule_order",
            operation: "reordered",
            id: input.kind,
            before: { ids: existing.map((r) => r.id) },
            after: { ids: input.ids },
          },
        };
      });
      return { rules: result, revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.put<{ Params: { id: string } }>("/api/mapping/rules/:id", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      if (!(await getMappingRule(pool, tenantId, req.params.id))) throw notFound();
      const input = parse(ruleInputSchema, req.body);
      const { result, revision } = await change(req, async (tx) => {
        const before = await getMappingRule(tx, tenantId, req.params.id);
        if (!before) throw notFound();
        await checkTarget(tx, tenantId, input.kind, input.targetId);
        let priority = before.priority;
        if (input.kind !== before.kind && input.priority === undefined) {
          priority = (await maxMappingRulePriority(tx, tenantId, input.kind)) + 10;
        }
        const after = await updateMappingRule(tx, tenantId, toRule(before.id, input, priority));
        return {
          result: after!,
          change: {
            entity: "rule",
            operation: "updated",
            id: before.id,
            before: ruleSummary(before),
            after: ruleSummary(after),
          },
        };
      });
      return { rule: result, revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/mapping/rules/:id", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      if (!(await getMappingRule(pool, tenantId, req.params.id))) throw notFound();
      const { revision } = await change(req, async (tx) => {
        const before = await getMappingRule(tx, tenantId, req.params.id);
        if (!before) throw notFound();
        await deleteMappingRule(tx, tenantId, before.id);
        return {
          result: null,
          change: {
            entity: "rule",
            operation: "deleted",
            id: before.id,
            before: ruleSummary(before),
            after: null,
          },
        };
      });
      return { ok: true, revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.put<{ Params: { id: string } }>("/api/mapping/builtin-rules/:id", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const builtin = BUILTIN_RULES.find((r) => r.id === req.params.id);
      if (!builtin) throw notFound();
      const input = parse(builtinToggleSchema, req.body);
      const { config } = await service.load(tenantId);
      const was = config.builtinOverrides[builtin.id] ?? builtin.enabled;
      const { revision } = await change(req, async (tx) => {
        await setBuiltinRuleOverride(tx, tenantId, builtin.id, input.enabled);
        return {
          result: null,
          change: {
            entity: "builtin_rule",
            operation: "updated",
            id: builtin.id,
            before: { id: builtin.id, enabled: was },
            after: { id: builtin.id, enabled: input.enabled },
          },
        };
      });
      return { rule: { ...builtin, enabled: input.enabled }, revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  // --- Preview and unmapped values -------------------------------------------------

  app.post(
    "/api/mapping/preview",
    // A dry run: nothing is stored, so viewers may use it (ADR 0006 explicit access).
    { config: { access: "viewer" } },
    async (req, reply) => {
      try {
        const tenantId = requestTenant(req);
        const input = parse(previewSchema, req.body);
        const current = await service.load(tenantId);
        const proposedConfig: MappingConfig = {
          services: input.services
            ? input.services.map((s) => ({
                id: s.id ?? slugify(s.name),
                name: s.name,
                description: s.description ?? null,
              }))
            : current.config.services,
          environments: input.environments
            ? input.environments.map((e, i) => ({
                id: e.id ?? slugify(e.name),
                name: e.name,
                kind: e.kind,
                order: e.order ?? (i + 1) * 10,
              }))
            : current.config.environments,
          rules: input.rules
            ? input.rules.map((r, i) => toRule(r.id ?? `proposed:${i + 1}`, r, (i + 1) * 10))
            : current.config.rules,
          builtinOverrides: { ...current.config.builtinOverrides, ...input.builtinOverrides },
        };
        const proposed = compileMapping(proposedConfig);
        const events = await service.recentDeploymentEvents(tenantId, input.limit ?? 200);
        const mappable =
          current.mapping.usesLabels || proposed.usesLabels
            ? await service.withLabels(tenantId, events)
            : events;
        const rows = mappable.map((e, i) => {
          const o = observationsOf(e);
          const ev = events[i]!;
          const before = placementView(
            current.config,
            current.mapping.resolveObservations(e.source, o),
          );
          const after = placementView(proposedConfig, proposed.resolveObservations(e.source, o));
          return {
            eventId: ev.id,
            when: ev.occurredAt,
            source: ev.source,
            action: ev.action,
            label: labelOf(ev),
            observations: o,
            current: before,
            proposed: after,
            changed: !sameView(before, after),
          };
        });
        const changed = rows.filter((r) => r.changed);
        const items = [...changed, ...rows.filter((r) => !r.changed)].slice(0, input.items ?? 50);
        return {
          sampleSize: rows.length,
          summary: {
            current: counts(rows.map((r) => r.current)),
            proposed: counts(rows.map((r) => r.proposed)),
            changed: changed.length,
          },
          inactive: proposed.inactive.filter((i) => i.reason !== "disabled"),
          items,
        };
      } catch (err) {
        return send(reply, err);
      }
    },
  );

  app.get("/api/mapping/unmapped", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const q = (req.query ?? {}) as Record<string, unknown>;
      const limit = limitParam(q, 500);
      const { config, mapping } = await service.load(tenantId);
      const events = await service.recentDeploymentEvents(tenantId, limit);
      // Labels are always read here: they are candidates for new rules.
      const mappable = await service.withLabels(tenantId, events);
      const values = new Map<
        string,
        {
          source: string;
          field: string;
          value: string;
          count: number;
          lastSeen: string;
          missing: Set<"service" | "environment">;
          exampleEventId: string;
        }
      >();
      for (const [i, e] of mappable.entries()) {
        const ev = events[i]!;
        const o = observationsOf(e);
        const view = placementView(config, mapping.resolveObservations(e.source, o));
        if (view.unmapped.length === 0) continue;
        for (const [field, list] of Object.entries(o)) {
          for (const value of list ?? []) {
            const key = JSON.stringify([field, value]);
            let v = values.get(key);
            if (!v) {
              v = {
                source: ev.source,
                field,
                value,
                count: 0,
                lastSeen: ev.occurredAt,
                missing: new Set(),
                exampleEventId: ev.id,
              };
              values.set(key, v);
            }
            v.count++;
            if (ev.occurredAt > v.lastSeen) v.lastSeen = ev.occurredAt;
            for (const d of view.unmapped) v.missing.add(d);
          }
        }
      }
      const list = [...values.values()]
        .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field) || a.value.localeCompare(b.value))
        .slice(0, 300)
        .map((v) => ({ ...v, missing: [...v.missing].sort() }));
      return { sampleSize: events.length, values: list };
    } catch (err) {
      return send(reply, err);
    }
  });
}
