/**
 * Per-route request rate limits (`@fastify/rate-limit`).
 *
 * The plugin is registered once with `global: false`, so only routes that set
 * `config.rateLimit` are limited. Each limited route has its own buckets, in
 * memory per process, bounded to `MAX_KEYS` (least recently used keys are dropped
 * first) and keyed by tenant (docs/security/rules.md R5.7).
 *
 * Client address: `req.ip`. Afe does not enable Fastify's `trustProxy`, so this is
 * the socket peer and a client cannot choose its bucket with `X-Forwarded-For`.
 * Behind a reverse proxy every client shares the proxy's bucket, which is
 * stricter, never looser.
 */
import rateLimit, { type RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Upper bound on tracked keys per limited route. */
const MAX_KEYS = 10_000;

/** Thrown by the plugin when a route's limit is exceeded; routes choose the response. */
export class RateLimitedError extends Error {
  readonly statusCode = 429;
  readonly retryAfterSeconds: number;
  constructor(ttlMs: number) {
    super("rate limited");
    this.retryAfterSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  }
}

export async function registerRateLimit(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, context) => new RateLimitedError(context.ttl),
  });
}

/** Limit per tenant and client address, for unauthenticated routes. */
export function perAddress(tenantId: string, max: number, timeWindowMs: number): RateLimitOptions {
  return {
    max,
    timeWindow: timeWindowMs,
    cache: MAX_KEYS,
    keyGenerator: (req) => `${tenantId}:${req.ip}`,
  };
}

/**
 * Limit per tenant and principal, for authenticated routes. Runs as a preHandler,
 * after authentication, so rejected unauthenticated requests use no bucket.
 */
export function perPrincipal(max: number, timeWindowMs: number): RateLimitOptions {
  return {
    max,
    timeWindow: timeWindowMs,
    cache: MAX_KEYS,
    hook: "preHandler",
    keyGenerator: (req) => `${req.tenantId ?? ""}:${req.principal?.id ?? req.ip}`,
  };
}

/**
 * A route `errorHandler` that answers a rate-limit rejection with `onLimited` and
 * passes every other error to the instance's error handler unchanged.
 */
export function onRateLimited(
  onLimited: (req: FastifyRequest, reply: FastifyReply, error: RateLimitedError) => unknown,
) {
  return (error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (!(error instanceof RateLimitedError)) throw error;
    return onLimited(req, reply.header("retry-after", String(error.retryAfterSeconds)), error);
  };
}

/** The JSON answer most API routes give: 429 `{ error: "rate_limited" }`. */
export const rateLimitedJson = onRateLimited((_req, reply) =>
  reply.code(429).send({ error: "rate_limited", message: "Too many requests. Try again later." }),
);
