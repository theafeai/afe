import { ensureGitHubAdminIdentity, getGitHubAdminIdentity, getLocalUser } from "@afe/db";
import type { FastifyRequest } from "fastify";
import type { ServerContext } from "../context.ts";
import { requestTenant } from "../auth/index.ts";

export function canLinkAdminGitHub(ctx: ServerContext, req: FastifyRequest): boolean {
  return Boolean(
    !ctx.githubUserId && !req.principal?.localUserId && req.principal?.roles.includes("admin"),
  );
}

export async function githubUserId(
  ctx: ServerContext,
  req: FastifyRequest,
  createAdminIdentity = false,
): Promise<string | null> {
  const tid = requestTenant(req);
  const uid = ctx.githubUserId
    ? await ctx.githubUserId(tid, req.principal!)
    : (req.principal?.localUserId ??
      (canLinkAdminGitHub(ctx, req)
        ? await (createAdminIdentity ? ensureGitHubAdminIdentity : getGitHubAdminIdentity)(
            ctx.pool,
            tid,
            req.principal!.id,
          )
        : null));
  if (!uid) return null;
  const user = await getLocalUser(ctx.pool, tid, uid);
  return user && !user.disabled ? uid : null;
}
