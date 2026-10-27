/**
 * Environment and service mapping (AFE-19) as a server module: the mapping
 * API, `ctx.mapping` (read-time placement used by `GET /api/deployments`),
 * and the job that appends pending mapping audit events.
 * Reference: docs/environment-mapping.md, docs/api.md.
 */
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import { registerMappingRoutes } from "./routes.ts";
import { MappingService } from "./service.ts";

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
      ];
    },
  };
}

export const mappingModule: MappingModule = createMappingModule();
