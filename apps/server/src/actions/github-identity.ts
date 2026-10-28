import { getLocalUser } from "@afe/db";
import type { FastifyRequest } from "fastify";
import type { ServerContext } from "../context.ts";
import { requestTenant } from "../auth/index.ts";
export async function githubUserId(
  ctx: ServerContext,
  req: FastifyRequest,
): Promise<string | null> {
  const tid = requestTenant(req);
  const uid = ctx.githubUserId
    ? await ctx.githubUserId(tid, req.principal!)
    : (req.principal?.localUserId ?? null);
  if (!uid) return null;
  const user = await getLocalUser(ctx.pool, tid, uid);
  return user && !user.disabled ? uid : null;
}
