import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { EventSink } from "@afe/core";
import { LOG_REDACT_OPTIONS, type KeyProvider } from "@afe/core/security";
import { createPgEventSink } from "@afe/db";
import { loadConfig, type AfeConfig } from "./config.ts";
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
  sink?: EventSink;
  connectors?: ConnectorModule[];
  /** Built web UI to serve; defaults to `config.webDir` (`AFE_WEB_DIR`). */
  webDir?: string;
}

export interface AfeApp {
  app: FastifyInstance;
  context: ServerContext;
  /** All job definitions from registered connectors and features. */
  jobDefinitions: JobDefinition[];
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

  const context: ServerContext = {
    pool: options.pool,
    sink: options.sink ?? createPgEventSink(options.pool),
    keys: options.keys ?? missingKeys,
    jobs: options.jobs ?? new InlineJobQueue(),
    config: options.config ?? loadConfig({ DATABASE_URL: "unused" }),
    log: app.log,
  };

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

  const webDir = options.webDir ?? options.config?.webDir;
  if (webDir) await registerWebUi(app, webDir);

  return { app, context, jobDefinitions };
}

/** Convenience wrapper returning only the HTTP app. */
export async function createAfe(options: CreateAfeOptions): Promise<FastifyInstance> {
  return (await buildAfe(options)).app;
}
