import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { LOG_REDACT_OPTIONS } from "@afe/core/security";

export interface CreateAfeOptions {
  pool: pg.Pool;
  logLevel?: string;
  /** Log destination; defaults to stdout. */
  logStream?: NodeJS.WritableStream;
}

/**
 * Composition root (ADR 0002). Every replaceable capability is passed in here so
 * the hosted/paid build can supply its own implementations.
 */
export async function createAfe(options: CreateAfeOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? "info",
      // Never log credentials, tokens or webhook signatures (docs/security/rules.md).
      redact: { paths: [...LOG_REDACT_OPTIONS.paths], censor: LOG_REDACT_OPTIONS.censor },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
  });

  app.get("/healthz", async (_req, reply) => {
    try {
      await options.pool.query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  return app;
}
