import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type pg from "pg";
import type {
  AuthProvider,
  ConnectorHealthHooks,
  EventSink,
  HealthReporter,
  RetentionPolicy,
  TenantResolver,
} from "@afe/core";
import type { KeyProvider } from "@afe/core/security";
import type { AfeConfig } from "./config.ts";
import type { JobDefinition, JobQueue } from "./jobs.ts";
import type { MappingService } from "./mapping/service.ts";

/** Shared services handed to every connector module and server feature. */
export interface ServerContext {
  pool: pg.Pool;
  /** Store events. Connectors never write events directly. */
  sink: EventSink;
  /**
   * How long events are kept (ADR 0008). The sink drops events outside the
   * window; connectors clamp backfill/lookback windows to it; the
   * `retention.purge` job deletes what falls out of it.
   */
  retention: RetentionPolicy;
  keys: KeyProvider;
  jobs: JobQueue;
  config: AfeConfig;
  log: FastifyBaseLogger;
  /** All registered modules (set by buildAfe), e.g. to collect health hooks. */
  modules?: readonly ConnectorModule[];
  /**
   * Connection health reporting (AFE-13), set when the health module is
   * registered. Connectors call `ctx.health?.reportSuccess/reportFailure`.
   */
  health?: HealthReporter;
  /**
   * Authentication (ADR 0006). The server authenticates every `/api/*`
   * request before handlers run; handlers read the tenant with
   * `requestTenant(req)` (apps/server/src/auth), never from request fields.
   */
  auth: AuthProvider;
  /** Maps the authenticated principal to its tenant (ADR 0002). */
  tenantResolver: TenantResolver;
  /**
   * Environment/service mapping (AFE-19), set when the mapping module is
   * registered. Resolves events to a service and environment at read time.
   */
  mapping?: Pick<MappingService, "placements">;
}

/**
 * A connector's server-side wiring. The pure logic lives in the connector
 * package (`@afe/connector-*`); a module adapts it to HTTP routes and jobs.
 * Register modules in `createAfe({ connectors })`.
 */
export interface ConnectorModule {
  source: string;
  /** HTTP routes: webhook receivers under `/webhooks/<source>`, API under `/api/connections/<source>`. */
  routes?(app: FastifyInstance, ctx: ServerContext): void | Promise<void>;
  /** Background jobs (webhook processing, polling, reconciliation). */
  jobs?(ctx: ServerContext): JobDefinition[];
  /** Probe and backfill hooks used by connection health (AFE-13). */
  health?(ctx: ServerContext): ConnectorHealthHooks;
}
