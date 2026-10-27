/**
 * Correlation (AFE-20) as a server module: environment state, placement
 * history, per-commit journeys and event links, computed on read from the
 * retention window (docs/correlation.md, docs/api.md).
 *
 * Journeys can be enriched with commit containment (AFE-22): with
 * `include=containment`, live placements of the same repository whose
 * commit differs are checked with `containmentService(ctx).isContained`
 * (override with `createCorrelationModule({ containment })`).
 */
import type { ConnectorModule, ServerContext } from "../context.ts";
import { containmentService } from "../containment/index.ts";
import { registerCorrelationRoutes, type CorrelationRouteOptions } from "./routes.ts";
import { CorrelationService, type CorrelationServiceOptions } from "./service.ts";

export { CorrelationService, type CorrelationServiceOptions, type Snapshot } from "./service.ts";
export type { CorrelationRouteOptions, JourneyContainmentHook } from "./routes.ts";
export { UNMAPPED } from "./views.ts";

export interface CorrelationModuleOptions
  extends CorrelationServiceOptions, CorrelationRouteOptions {}

export interface CorrelationModule extends ConnectorModule {
  service(ctx: ServerContext): CorrelationService;
}

const services = new WeakMap<ServerContext, CorrelationService>();

/** The correlation service bound to a server context, when the module is registered. */
export function correlationService(ctx: ServerContext): CorrelationService | undefined {
  return services.get(ctx);
}

export function createCorrelationModule(options: CorrelationModuleOptions = {}): CorrelationModule {
  const service = (ctx: ServerContext): CorrelationService => {
    let s = services.get(ctx);
    if (!s) {
      s = new CorrelationService(ctx.pool, ctx.retention, ctx.log, options);
      services.set(ctx, s);
    }
    return s;
  };
  return {
    source: "correlation",
    service,
    routes(app, ctx) {
      registerCorrelationRoutes(app, ctx, service(ctx), {
        ...options,
        containment: options.containment ?? ((c) => containmentService(c)),
      });
    },
  };
}

export const correlationModule: CorrelationModule = createCorrelationModule();
