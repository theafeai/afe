import type { FastifyRequest } from "fastify";
import type pg from "pg";
import {
  backfillExternalIdentity,
  getCredential,
  getExternalIdentityForUser,
  getGitHubSignInSettings,
  githubSubject,
  setLocalUserDisabled,
} from "@afe/db";
import { GitHubHttp } from "@afe/connector-github";
import type { EventAccessRule } from "@afe/core";
import { getUserToolPolicy } from "@afe/db";
import type { ServerContext } from "../context.ts";
import { accessFingerprint, canonicalRules } from "./access-cache.ts";
import { allowedOrgMembership } from "./github-membership.ts";
import { sourceAccess, toolAccounts, type ToolAccount } from "./tool-accounts.ts";

export interface EventAccessOptions {
  /**
   * Check upstream access now instead of using the 5-minute read cache. Required
   * for everything that acts or reads protected content: mutations, log reads,
   * downloads, workflow-source reads, automations and notification sends.
   */
  live?: boolean;
}

/**
 * Undefined means an unrestricted legacy/hosted principal; [] means deny all.
 * A cache miss, expiry or refresh error never becomes undefined: it denies that
 * tool's resources.
 */
export async function requestEventAccess(
  pool: pg.Pool,
  req: FastifyRequest,
  ctx?: ServerContext,
  options: EventAccessOptions = {},
): Promise<EventAccessRule[] | undefined> {
  const userId = req.principal?.localUserId;
  if (!userId) return undefined;
  const tenantId = req.tenantId!;
  const rules: EventAccessRule[] = [];
  if (ctx)
    for (const account of await toolAccounts(ctx, tenantId, userId)) {
      const policy = await getUserToolPolicy(pool, tenantId, userId, account.tool);
      if (policy.mode !== "source") continue;
      try {
        rules.push(...(await accountAccess(ctx, tenantId, userId, account, options)));
      } catch {
        /* Unavailable or revoked source access denies access. */
      }
    }
  const out = canonicalRules(rules);
  ctx?.access?.noteFingerprint(tenantId, userId, accessFingerprint(out));
  return out;
}

async function accountAccess(
  ctx: ServerContext,
  tenantId: string,
  userId: string,
  account: ToolAccount,
  options: EventAccessOptions,
): Promise<EventAccessRule[]> {
  const cache = ctx.access;
  if (account.tool !== "github" || !cache) return sourceAccess(ctx, tenantId, account);
  if (!options.live) {
    const hit = await cache.read(tenantId, userId, account.tool, account.credential_id);
    if (hit) return hit;
  }
  return cache.refresh(tenantId, userId, account.tool, account.credential_id, async () => {
    const rules = await sourceAccess(ctx, tenantId, account);
    await githubRefreshChecks(ctx, tenantId, userId, account);
    return rules;
  });
}

/**
 * Runs with every GitHub access refresh:
 * - backfills the numeric GitHub id of links made before migration 0037;
 * - for users created by Sign in with GitHub, re-checks membership of an allowed
 *   organization. Proven loss disables the user (which ends their sessions);
 *   a membership that cannot be proven denies access without disabling.
 */
export async function githubRefreshChecks(
  ctx: ServerContext,
  tenantId: string,
  userId: string,
  account: ToolAccount,
): Promise<void> {
  let identity = null;
  try {
    identity = await getExternalIdentityForUser(ctx.pool, tenantId, userId, "github");
  } catch {
    return; // Accounts without a stored identity row (tests, legacy) skip both checks.
  }
  if (!identity) {
    await backfillIdentity(ctx, tenantId, userId, account);
    return;
  }
  if (!identity.provisioned) return;
  const settings = await getGitHubSignInSettings(ctx.pool, tenantId);
  if (!settings.allowedOrgs.length) return;
  const stored = await getCredential(ctx.pool, ctx.keys, tenantId, account.credential_id);
  if (!stored) throw new Error("credential unavailable");
  const { membership } = await allowedOrgMembership(
    ctx.pool,
    tenantId,
    settings.allowedOrgs,
    stored.secret,
    `user:${tenantId}:${userId}`,
  );
  if (membership === "active") return;
  if (membership === "none") {
    await setLocalUserDisabled(ctx.pool, tenantId, userId, true);
    ctx.access?.forgetUser(tenantId, userId);
    ctx.log.info(
      { tenantId, userId },
      "github sign-in user disabled: organization membership lost",
    );
  }
  throw new Error("organization membership not proven");
}

async function backfillIdentity(
  ctx: ServerContext,
  tenantId: string,
  userId: string,
  account: ToolAccount,
): Promise<void> {
  try {
    const stored = await getCredential(ctx.pool, ctx.keys, tenantId, account.credential_id);
    if (!stored) return;
    const res = await new GitHubHttp({ maxRetries: 0 }).request<{ id?: unknown; login?: unknown }>({
      method: "GET",
      path: "/user",
      token: stored.secret,
      bucket: "user",
    });
    const subject = githubSubject(res.data?.id);
    if (!subject || typeof res.data.login !== "string" || !res.data.login) return;
    await backfillExternalIdentity(ctx.pool, tenantId, userId, {
      provider: "github",
      subject,
      login: res.data.login.slice(0, 100),
    });
  } catch {
    /* Best effort: retried on the next refresh. Access itself is unaffected. */
  }
}
