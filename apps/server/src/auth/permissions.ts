import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { getUserToolPolicy } from "@afe/db";
import type { EventAccessRule } from "@afe/core";
import type { ServerContext } from "../context.ts";
import { sourceAccess, toolAccounts } from "./tool-accounts.ts";
import { USER_TOOLS } from "./user-routes.ts";

/** Undefined means an unrestricted legacy/hosted principal; [] means deny all. */
export async function requestEventAccess(
  pool: pg.Pool,
  req: FastifyRequest,
  ctx?: ServerContext,
): Promise<EventAccessRule[] | undefined> {
  const userId = req.principal?.localUserId;
  if (!userId) return undefined;
  const rules: EventAccessRule[] = [];
  for (const source of USER_TOOLS) {
    const policy = await getUserToolPolicy(pool, req.tenantId!, userId, source);
    if (policy.mode === "custom" || policy.mode === "source + custom") {
      for (const grant of policy.custom)
        if (grant.action === "read") rules.push({ source, resource: grant.resource });
    }
  }
  if (ctx)
    for (const account of await toolAccounts(ctx, req.tenantId!, userId)) {
      const policy = await getUserToolPolicy(pool, req.tenantId!, userId, account.tool);
      if (policy.mode !== "source" && policy.mode !== "source + custom") continue;
      try {
        rules.push(...(await sourceAccess(ctx, req.tenantId!, account)));
      } catch {
        /* Unavailable or revoked source access denies only the source component. */
      }
    }
  return [...new Map(rules.map((r) => [JSON.stringify(r), r])).values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
