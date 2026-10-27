/**
 * Connection health as a server module (source "afe"). Collects the
 * `health` hooks of every registered connector module, exposes
 * `ctx.health` (HealthReporter) to connectors, registers the probe /
 * backfill / alert-check jobs and the read API.
 */
import type { FastifyRequest } from "fastify";
import type { AlertSink, ConnectorHealthHooks } from "@afe/core";
import { requestTenant } from "../auth/index.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import { createDefaultAlertSink, createLogAlertSink } from "./alert-sink.ts";
import { loadHealthConfig, type HealthConfig } from "./config.ts";
import { registerHealthRoutes } from "./routes.ts";
import { HEALTH_JOBS, HealthService, type BackfillJobData } from "./service.ts";

export interface HealthModuleOptions {
  /** Overrides on top of the environment (AFE_HEALTH_*). */
  config?: Partial<HealthConfig>;
  env?: NodeJS.ProcessEnv;
  /** Replaces the default (log + optional webhook) sink: the ADR 0002 AlertSink extension point. */
  alertSink?: AlertSink;
  /** Tenant of API requests. Default: the authenticated principal's (`requestTenant`). */
  resolveTenant?: (req: FastifyRequest) => string | Promise<string>;
  /** Cron for probe and alert-check jobs. Default every minute. */
  schedule?: string;
  /** Test hooks. */
  now?: () => Date;
  random?: () => number;
}

export interface HealthModule extends ConnectorModule {
  /** The service for a given server context (created on first use). */
  service(ctx: ServerContext): HealthService;
}

export function collectHealthHooks(ctx: ServerContext): Map<string, ConnectorHealthHooks> {
  const hooks = new Map<string, ConnectorHealthHooks>();
  for (const m of ctx.modules ?? []) {
    if (!m.health) continue;
    const h = m.health(ctx);
    if (!hooks.has(h.source)) hooks.set(h.source, h);
  }
  return hooks;
}

export function createHealthModule(options: HealthModuleOptions = {}): HealthModule {
  const services = new WeakMap<ServerContext, HealthService>();
  let config: HealthConfig | undefined;
  const getConfig = () =>
    (config ??= { ...loadHealthConfig(options.env ?? process.env), ...options.config });

  const service = (ctx: ServerContext): HealthService => {
    let s = services.get(ctx);
    if (!s) {
      let hooks: Map<string, ConnectorHealthHooks> | undefined;
      s = new HealthService({
        pool: ctx.pool,
        sink: ctx.sink,
        jobs: ctx.jobs,
        log: ctx.log,
        config: getConfig(),
        hooks: () => (hooks ??= collectHealthHooks(ctx)),
        alertSink: options.alertSink ?? createLogAlertSink(ctx.log),
        ...(options.now ? { now: options.now } : {}),
        ...(options.random ? { random: options.random } : {}),
      });
      services.set(ctx, s);
      ctx.health = s;
    }
    return s;
  };

  return {
    source: "afe",
    service,
    async routes(app, ctx) {
      const s = service(ctx);
      if (!options.alertSink) {
        // Validates AFE_ALERT_WEBHOOK_URL at startup (fails fast on an unsafe URL).
        s.alertSink = await createDefaultAlertSink({
          log: ctx.log,
          webhookUrl: getConfig().alertWebhookUrl,
          policy: {
            allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets,
            allowInsecureHttp: ctx.config.allowInsecureHttpTargets,
          },
        });
      }
      registerHealthRoutes(app, ctx.pool, options.resolveTenant ?? requestTenant);
    },
    jobs(ctx): JobDefinition[] {
      const s = service(ctx);
      const schedule = options.schedule ?? "* * * * *";
      return [
        {
          name: HEALTH_JOBS.PROBE,
          schedule,
          retryLimit: 0,
          handler: async () => {
            await s.probeDue();
          },
        },
        {
          name: HEALTH_JOBS.ALERT_CHECK,
          schedule,
          retryLimit: 0,
          handler: async () => {
            await s.checkAlerts();
          },
        },
        {
          name: HEALTH_JOBS.BACKFILL,
          retryLimit: 5,
          handler: (data) => s.runBackfill(data as BackfillJobData),
        },
      ];
    },
  };
}

/** The module registered by default. */
export const healthModule = createHealthModule();
