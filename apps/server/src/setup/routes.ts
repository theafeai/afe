/**
 * Setup API (D-0012, D-0024): the merged setup with provenance per field,
 * admin overrides, and "Afe noticed". Reference: docs/api.md "Setup".
 *
 * - `GET /api/setup` (viewer): environments in effective order, each field
 *   as `{value, origin, via?, confidence?, reason?, evidence?, setBy?, setAt?,
 *   inferred}`, plus `noticed` (inference that disagrees with an admin value,
 *   or environments that appeared since the admin adjusted the setup).
 *   Reported, never applied.
 * - `PATCH /api/setup` (admin): set, clear ("Use Afe's guess") or keep
 *   ("Keep yours") overrides, atomically, audited as one
 *   `config.mapping.changed` event (entity `setup`).
 * - `POST /api/setup/infer` (admin): queue an inference run now.
 *
 * Only admin routes write overrides; the tenant is always the principal's.
 */
import type { FastifyInstance } from "fastify";
import type { JsonObject } from "@afe/core";
import {
  BATCHING_VALUES,
  environmentSubject,
  GATING_VALUES,
  OVERRIDE_FIELDS,
  setupChangesSchema,
  type EffectiveEnvironment,
  type SetupValue,
} from "@afe/core/setup";
import { clearSetupOverrides, setSetupOverride } from "@afe/db";
import { requestTenant } from "../auth/index.ts";
import type { ServerContext } from "../context.ts";
import { auditedMappingChange, HttpError, parse, send, setupActorOf } from "../mapping/routes.ts";
import type { LoadedMapping, MappingService } from "../mapping/service.ts";
import { SETUP_INFER_JOB } from "./inference.ts";

function view(loaded: LoadedMapping) {
  const { setup } = loaded;
  return {
    revision: loaded.config.revision,
    computedAt: setup.computedAt,
    environments: setup.environments,
    noticed: setup.noticed,
    fields: OVERRIDE_FIELDS,
    gatingValues: GATING_VALUES,
    batchingValues: BATCHING_VALUES,
  };
}

const fieldOf = (e: EffectiveEnvironment, field: (typeof OVERRIDE_FIELDS)[number]) =>
  e[field] as SetupValue<unknown>;

export function registerSetupRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  service: MappingService,
): void {
  const queueInference = (tenantId: string) =>
    ctx.jobs.send(SETUP_INFER_JOB, { tenantId }, { singletonKey: `setup.infer:${tenantId}` });

  app.get("/api/setup", async (req) => {
    const tenantId = requestTenant(req);
    const loaded = await service.load(tenantId);
    // Never inferred yet (new tenant or just upgraded): start a run.
    if (!loaded.setup.computedAt) await queueInference(tenantId).catch(() => {});
    return view(loaded);
  });

  app.patch("/api/setup", async (req, reply) => {
    try {
      const tenantId = requestTenant(req);
      const input = parse(setupChangesSchema, req.body);
      const actor = setupActorOf(req.principal);
      const { setup } = await service.load(tenantId);
      const byId = new Map(setup.environments.map((e) => [e.id, e]));
      for (const c of input.changes) {
        const env = byId.get(c.environment);
        if (!env) {
          throw new HttpError(404, "not_found", `environment ${c.environment} does not exist`);
        }
        if (c.field === "included" && env.origin === "admin") {
          throw new HttpError(
            400,
            "bad_request",
            `${c.environment} was created by an admin; delete it on the Mapping page instead`,
          );
        }
        if (c.keep && !fieldOf(env, c.field).inferred) {
          throw new HttpError(
            400,
            "bad_request",
            `Afe has no guess for ${c.field} to keep against`,
          );
        }
      }
      const { revision } = await auditedMappingChange(ctx.pool, service, req, async (tx) => {
        const before: JsonObject[] = [];
        const after: JsonObject[] = [];
        for (const c of input.changes) {
          const env = byId.get(c.environment)!;
          const current = fieldOf(env, c.field);
          const subject = environmentSubject(c.environment);
          before.push({
            environment: c.environment,
            field: c.field,
            value: current.value as JsonObject[string],
            origin: current.origin,
          });
          if (c.clear) {
            await clearSetupOverrides(tx, tenantId, subject, [c.field]);
            after.push({
              environment: c.environment,
              field: c.field,
              value: null,
              origin: "inferred",
            });
            continue;
          }
          const value = c.keep ? current.value : c.value;
          await setSetupOverride(
            tx,
            tenantId,
            {
              subject,
              field: c.field,
              value,
              keptInferred: c.keep ? current.inferred!.value : null,
            },
            actor,
          );
          after.push({
            environment: c.environment,
            field: c.field,
            value: value as JsonObject[string],
            origin: "admin",
          });
        }
        return {
          result: null,
          change: {
            entity: "setup",
            operation: "updated",
            id: "setup",
            before: { changes: before },
            after: { changes: after },
          },
        };
      });
      return { ...view(await service.load(tenantId)), revision };
    } catch (err) {
      return send(reply, err);
    }
  });

  app.post("/api/setup/infer", async (req, reply) => {
    await queueInference(requestTenant(req));
    return reply.code(202).send({ queued: true });
  });
}
