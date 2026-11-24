/**
 * Access checks for long-lived read streams (ADR 0020). A stream (SSE, or a long poll with `?since=seq`) holds one
 * request open, so the per-request check is not enough. Call `check()` before
 * each push: it closes the stream (returns null) when the session expired or the
 * user was disabled, deleted or had their credential reset, and re-reads the
 * user's access through the read cache on every call, so a local change applies
 * at once and an upstream change within the cache TTL (a failed refresh denies).
 */
import type { FastifyRequest } from "fastify";
import type { EventAccessRule } from "@afe/core";
import { getLocalUser } from "@afe/db";
import type { ServerContext } from "../context.ts";
import { requestEventAccess } from "./permissions.ts";

export interface StreamAccessGuard {
  /** Current rules (undefined: unrestricted principal), or null: close the stream now. */
  check(): Promise<EventAccessRule[] | undefined | null>;
}

export function streamAccessGuard(req: FastifyRequest, ctx: ServerContext): StreamAccessGuard {
  const now = () => ctx.access?.now() ?? Date.now();
  return {
    async check() {
      const t = now();
      if (req.webSession && t >= req.webSession.expiresAt) return null;
      const principal = req.principal;
      if (!principal) return null;
      // As the auth hook does: a session is checked with the method it was started with.
      const p = req.webSession ? { ...principal, kind: req.webSession.via } : principal;
      if (p.localUserId) {
        const user = await getLocalUser(ctx.pool, req.tenantId!, p.localUserId);
        if (!user || user.disabled || user.credentialVersion !== p.credentialVersion) return null;
        if (ctx.auth.isActive && !(await ctx.auth.isActive(p))) return null;
      }
      return requestEventAccess(ctx.pool, req, ctx);
    },
  };
}
