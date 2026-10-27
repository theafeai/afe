/**
 * Drift and untracked deploy detection (AFE-26) as a server module: the
 * `drift.evaluate` job (every minute: evaluate every tenant, record
 * transition events, send alerts) and the read/settings API. Builds on the
 * correlation module's per-tenant window (AFE-20) and the health module's
 * AlertSink (AFE-13). Docs: docs/drift.md, docs/api.md "Drift findings".
 */
import type { AlertSink } from "@afe/core";
import type { ConnectorModule, ServerContext } from "../context.ts";
import { CorrelationService } from "../correlation/service.ts";
import type { CorrelationModule } from "../correlation/index.ts";
import { createLogAlertSink } from "../health/alert-sink.ts";
import type { HealthModule } from "../health/module.ts";
import type { JobDefinition } from "../jobs.ts";
import { registerDriftRoutes } from "./routes.ts";
import { DRIFT_JOBS, DriftService, type DriftServiceOptions } from "./service.ts";

export {
  DriftService,
  DRIFT_JOBS,
  type DriftServiceOptions,
  type DriftSettings,
  type EvaluationSummary,
} from "./service.ts";

export interface DriftModuleOptions extends DriftServiceOptions {
  /** Environment for AFE_DRIFT_ALERTS (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Cron for `drift.evaluate`. Default every minute. */
  schedule?: string;
  /** Correlation service to read from (default: the registered correlation module's). */
  correlation?: (ctx: ServerContext) => CorrelationService;
}

export interface DriftModule extends ConnectorModule {
  service(ctx: ServerContext): DriftService;
}

/** The registered correlation module's service, or a private one. */
function correlationFor(ctx: ServerContext, own: { s?: CorrelationService }): CorrelationService {
  const m = ctx.modules?.find(
    (x): x is CorrelationModule =>
      x.source === "correlation" && typeof (x as Partial<CorrelationModule>).service === "function",
  );
  if (m) return m.service(ctx);
  return (own.s ??= new CorrelationService(ctx.pool, ctx.retention, ctx.log));
}

/** The health module's AlertSink (AFE_ALERT_WEBHOOK_URL etc.), else a log sink. */
function alertSinkFor(ctx: ServerContext): AlertSink {
  const m = ctx.modules?.find(
    (x): x is HealthModule =>
      x.source === "afe" && typeof (x as Partial<HealthModule>).service === "function",
  );
  return m ? m.service(ctx).alertSink : createLogAlertSink(ctx.log);
}

export function createDriftModule(options: DriftModuleOptions = {}): DriftModule {
  const services = new WeakMap<ServerContext, DriftService>();
  const service = (ctx: ServerContext): DriftService => {
    let s = services.get(ctx);
    if (!s) {
      const own: { s?: CorrelationService } = {};
      // Fails at startup on an unknown type in AFE_DRIFT_ALERTS.
      const defaultAlertTypes =
        options.defaultAlertTypes ??
        DriftService.parseAlertTypes((options.env ?? process.env).AFE_DRIFT_ALERTS);
      s = new DriftService(
        ctx,
        () => (options.correlation ? options.correlation(ctx) : correlationFor(ctx, own)),
        { ...options, defaultAlertTypes },
        () => options.alertSink ?? alertSinkFor(ctx),
      );
      services.set(ctx, s);
    }
    return s;
  };
  return {
    source: "drift",
    service,
    routes(app, ctx) {
      registerDriftRoutes(app, service(ctx));
    },
    jobs(ctx): JobDefinition[] {
      const s = service(ctx);
      return [
        {
          name: DRIFT_JOBS.EVALUATE,
          schedule: options.schedule ?? "* * * * *",
          retryLimit: 0,
          handler: async () => {
            await s.evaluateAll();
          },
        },
      ];
    },
  };
}

export const driftModule: DriftModule = createDriftModule();
