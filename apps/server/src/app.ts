import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { randomBytes } from "node:crypto";
import {
  denyAllAuthProvider,
  FixedWindowRetention,
  principalTenantResolver,
  StaticTokenAuthProvider,
  type AuthProvider,
  type EventSink,
  type RetentionPolicy,
  type TenantResolver,
} from "@afe/core";
import { LOG_REDACT_OPTIONS, type KeyProvider } from "@afe/core/security";
import { createPgEventSink } from "@afe/db";
import { registerAuth, type RegisteredRoute } from "./auth/index.ts";
import { deriveSessionKey, SessionCodec } from "./auth/session.ts";
import { DEFAULT_SESSION_TTL_MS, loadConfig, type AfeConfig } from "./config.ts";
import type { ConnectorModule, ServerContext } from "./context.ts";
import { InlineJobQueue, type JobDefinition, type JobQueue } from "./jobs.ts";
import { registerWebUi } from "./web.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Exact request body bytes, for webhook signature verification. */
    rawBody?: Buffer;
  }
}

export interface CreateAfeOptions {
  pool: pg.Pool;
  logLevel?: string;
  /** Log destination; defaults to stdout. */
  logStream?: NodeJS.WritableStream;
  config?: AfeConfig;
  /** Required by connectors that store credentials. */
  keys?: KeyProvider;
  /** Defaults to an in-process queue (tests); the CLI passes PgBossJobRunner. */
  jobs?: JobQueue;
  /**
   * Where events are stored (ADR 0002/0008 extension point). Default: the
   * PostgreSQL sink, which drops events outside `retentionPolicy`'s window.
   * A replacement (e.g. one that also copies events to a long-term store)
   * applies its own retention rules.
   */
  sink?: EventSink;
  /**
   * How long events are kept (ADR 0008 extension point). Default:
   * `FixedWindowRetention` of `config.eventRetentionDays` (AFE_EVENT_RETENTION_DAYS, default 30).
   */
  retentionPolicy?: RetentionPolicy;
  connectors?: ConnectorModule[];
  /** Built web UI to serve; defaults to `config.webDir` (`AFE_WEB_DIR`). */
  webDir?: string;
  /**
   * Authentication (ADR 0006). Default: `StaticTokenAuthProvider` from
   * `config.auth` (AFE_ADMIN_TOKEN, AFE_VIEWER_TOKEN); with no token
   * configured every /api request is rejected.
   */
  authProvider?: AuthProvider;
  /** Tenant of an authenticated request. Default: the principal's tenant. */
  tenantResolver?: TenantResolver;
  /** HMAC key material for web UI sessions; default `config.auth.sessionSecret`, else derived from the tokens. */
  sessionSecret?: string;
  /** Clock for session expiry (tests). */
  clock?: () => number;
}

export interface AfeApp {
  app: FastifyInstance;
  context: ServerContext;
  /** All job definitions from registered connectors and features. */
  jobDefinitions: JobDefinition[];
  /** Every registered HTTP route with its access level (ADR 0006). */
  routes: RegisteredRoute[];
}

const missingKeys: KeyProvider = {
  activeKeyId: () => {
    throw new Error("no KeyProvider configured (set AFE_ENCRYPTION_KEY)");
  },
  hasKey: () => false,
  wrapKey: async () => {
    throw new Error("no KeyProvider configured (set AFE_ENCRYPTION_KEY)");
  },
  unwrapKey: async () => {
    throw new Error("no KeyProvider configured (set AFE_ENCRYPTION_KEY)");
  },
};

/**
 * Composition root (ADR 0002). Every replaceable capability is passed in here so
 * the hosted/paid build can supply its own implementations.
 */
export async function buildAfe(options: CreateAfeOptions): Promise<AfeApp> {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? "info",
      // Never log credentials, tokens or webhook signatures (docs/security/rules.md).
      redact: { paths: [...LOG_REDACT_OPTIONS.paths], censor: LOG_REDACT_OPTIONS.censor },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
  });

  // Keep the exact bytes of JSON bodies: webhook signatures are computed over them.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buf.toString("utf8")));
    } catch {
      const err = new Error("invalid JSON body") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  const config = options.config ?? loadConfig({ DATABASE_URL: "unused" });
  const authConfig = config.auth;
  let authProvider = options.authProvider;
  if (!authProvider) {
    if (authConfig?.adminToken) {
      authProvider = new StaticTokenAuthProvider({
        adminToken: authConfig.adminToken.reveal(),
        ...(authConfig.viewerToken ? { viewerToken: authConfig.viewerToken.reveal() } : {}),
      });
    } else {
      app.log.warn("no AFE_ADMIN_TOKEN configured: every /api request is rejected");
      authProvider = denyAllAuthProvider;
    }
  }
  const sessionSecret = options.sessionSecret ?? authConfig?.sessionSecret?.reveal();
  const sessionKey = sessionSecret
    ? deriveSessionKey("secret", sessionSecret)
    : authConfig?.adminToken
      ? // Rotating either token invalidates every session.
        deriveSessionKey(
          "tokens",
          authConfig.adminToken.reveal(),
          authConfig.viewerToken?.reveal() ?? "",
        )
      : randomBytes(32); // sessions end when the process restarts
  const sessions = new SessionCodec(
    sessionKey,
    authConfig?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    options.clock,
  );

  const retention = options.retentionPolicy ?? new FixedWindowRetention(config.eventRetentionDays);
  const context: ServerContext = {
    pool: options.pool,
    sink: options.sink ?? createPgEventSink(options.pool, { retention }),
    retention,
    keys: options.keys ?? missingKeys,
    jobs: options.jobs ?? new InlineJobQueue(),
    config,
    log: app.log,
    modules: options.connectors ?? [],
    auth: authProvider,
    tenantResolver: options.tenantResolver ?? principalTenantResolver,
  };

  const webDir = options.webDir ?? options.config?.webDir;
  // Before any route: every route gets an access level, /api/* is authenticated.
  const routes = registerAuth(app, {
    provider: context.auth,
    tenantResolver: context.tenantResolver,
    sessions,
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    uiEnabled: Boolean(webDir),
  });

  app.get("/healthz", async (_req, reply) => {
    try {
      await options.pool.query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  const jobDefinitions: JobDefinition[] = [];
  for (const connector of options.connectors ?? []) {
    await connector.routes?.(app, context);
    jobDefinitions.push(...(connector.jobs?.(context) ?? []));
  }

  if (webDir) await registerWebUi(app, webDir);

  return { app, context, jobDefinitions, routes };
}

/** Convenience wrapper returning only the HTTP app. */
export async function createAfe(options: CreateAfeOptions): Promise<FastifyInstance> {
  return (await buildAfe(options)).app;
}
