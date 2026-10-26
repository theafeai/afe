import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";

export interface CreateAfeOptions {
  pool: pg.Pool;
  logLevel?: string;
}

/**
 * Composition root (ADR 0002). Every replaceable capability is passed in here so
 * the hosted/paid build can supply its own implementations.
 */
export async function createAfe(options: CreateAfeOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: options.logLevel ?? "info" } });

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
