/**
 * Retention purge (ADR 0008): the `retention.purge` job deletes, per tenant,
 * events whose occurredAt is before the tenant's cutoff (`ctx.retention`)
 * together with their raw payloads. Batched, so it never holds long locks;
 * when a run hits its batch limit it enqueues a follow-up run.
 */
import { listTenantsWithEvents, purgeEventsBefore, type PurgeOptions } from "@afe/db";
import type { ConnectorModule, ServerContext } from "./context.ts";
import type { JobDefinition } from "./jobs.ts";

export const RETENTION_JOBS = {
  PURGE: "retention.purge",
} as const;

export interface RetentionModuleOptions {
  /** Cron (UTC). Default: hourly at minute 23. */
  schedule?: string;
  purge?: PurgeOptions;
  now?: () => Date;
}

export interface RetentionRunResult {
  tenants: number;
  events: number;
  rawPayloads: number;
  /** Tenants that still have expired events after this run (a follow-up was enqueued). */
  incomplete: string[];
}

/** One purge pass over every tenant. Exported for tests and operators. */
export async function runRetentionPurge(
  ctx: Pick<ServerContext, "pool" | "retention" | "log" | "jobs">,
  options: Pick<RetentionModuleOptions, "purge" | "now"> = {},
): Promise<RetentionRunResult> {
  const now = options.now?.() ?? new Date();
  const out: RetentionRunResult = { tenants: 0, events: 0, rawPayloads: 0, incomplete: [] };
  for (const tenantId of await listTenantsWithEvents(ctx.pool)) {
    const cutoff = await ctx.retention.cutoff(tenantId, now);
    if (cutoff === null) continue;
    out.tenants += 1;
    const r = await purgeEventsBefore(ctx.pool, tenantId, cutoff, options.purge);
    out.events += r.events;
    out.rawPayloads += r.rawPayloads;
    if (r.more) out.incomplete.push(tenantId);
    if (r.events > 0 || r.rawPayloads > 0) {
      ctx.log.info(
        {
          tenantId,
          cutoff: cutoff.toISOString(),
          events: r.events,
          rawPayloads: r.rawPayloads,
          more: r.more,
        },
        "retention.purge: deleted expired events",
      );
    }
  }
  if (out.incomplete.length > 0) {
    await ctx.jobs.send(RETENTION_JOBS.PURGE, {}, { singletonKey: `${RETENTION_JOBS.PURGE}:more` });
  }
  return out;
}

export function createRetentionModule(options: RetentionModuleOptions = {}): ConnectorModule {
  return {
    source: "retention",
    jobs(ctx): JobDefinition[] {
      return [
        {
          name: RETENTION_JOBS.PURGE,
          schedule: options.schedule ?? "23 * * * *",
          handler: async () => {
            await runRetentionPurge(ctx, options);
          },
        },
      ];
    },
  };
}

/** Registered by default: hourly purge with the server's retention policy. */
export const retentionModule: ConnectorModule = createRetentionModule();
