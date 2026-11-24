/**
 * Environment and service mapping (AFE-19) as a server module: the mapping
 * API, the setup API (inferred setup and admin overrides, ADR 0019),
 * `ctx.mapping` (read-time placement used by `GET /api/deployments`), the
 * job that appends pending mapping audit events, and the setup inference job.
 * Reference: docs/environment-mapping.md, docs/api.md.
 */
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import { inferAllTenants, inferTenantSetup, SETUP_INFER_JOB } from "../setup/inference.ts";
import { registerSetupRoutes } from "../setup/routes.ts";
import { registerMappingRoutes } from "./routes.ts";
import { MappingService } from "./service.ts";

export { SETUP_INFER_JOB } from "../setup/inference.ts";

export { mappingChangedEvent } from "./routes.ts";
export { MappingService, placementView, type PlacementView } from "./service.ts";

export const MAPPING_AUDIT_OUTBOX_JOB = "mapping.audit-outbox";

export interface MappingModule extends ConnectorModule {
  service(ctx: ServerContext): MappingService;
}

export function createMappingModule(): MappingModule {
  const services = new WeakMap<ServerContext, MappingService>();
  const service = (ctx: ServerContext): MappingService => {
    let s = services.get(ctx);
    if (!s) {
      s = new MappingService(ctx.pool, ctx.sink, ctx.log);
      services.set(ctx, s);
      ctx.mapping = s;
    }
    return s;
  };
  return {
    source: "mapping",
    service,
    routes(app, ctx) {
      registerMappingRoutes(app, ctx, service(ctx));
      registerSetupRoutes(app, ctx, service(ctx));
    },
    jobs(ctx): JobDefinition[] {
      return [
        {
          name: MAPPING_AUDIT_OUTBOX_JOB,
          schedule: "* * * * *",
          scheduleData: {},
          async handler() {
            await service(ctx).flushOutbox();
          },
        },
        {
          // Every 10 minutes for every tenant with events, or for one tenant
          // on demand (`POST /api/setup/infer`, first `GET /api/setup`).
          name: SETUP_INFER_JOB,
          schedule: "*/10 * * * *",
          scheduleData: {},
          retryLimit: 1,
          async handler(data: { tenantId?: string }) {
            if (typeof data.tenantId === "string") await inferTenantSetup(ctx.pool, data.tenantId);
            else await inferAllTenants(ctx.pool, ctx.log);
          },
        },
      ];
    },
  };
}

export const mappingModule: MappingModule = createMappingModule();
