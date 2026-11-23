/**
 * The inference job (D-0012, D-0013): reads a tenant's retained deployment
 * and approval events, runs the deterministic rules of `@afe/core/setup`
 * and replaces the tenant's inferred facts.
 *
 * Its only write is `replaceInferredSetup`. It has no path to admin
 * overrides: this module must not import an override writer (a test checks
 * the imports), and the database refuses override writes from the inference
 * writer anyway (migration 0040).
 */
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import type { CanonicalEvent } from "@afe/core";
import { compileMapping } from "@afe/core/mapping";
import { inferSetup, type SignalExtractor } from "@afe/core/setup";
import {
  getMappingConfig,
  listTenantsWithEvents,
  queryEvents,
  replaceInferredSetup,
} from "@afe/db";

export const SETUP_INFER_JOB = "setup.infer";

/** Events read per run (newest first): enough history for order and cadence. */
export const INFERENCE_EVENT_LIMIT = 10_000;
const PAGE = 1000;

/** Deployments, syncs, approval waits and protection rules. */
const INFERENCE_ACTIONS = ["deployment.*", "argocd.sync.*"];

export interface InferenceResult {
  tenantId: string;
  events: number;
  facts: number;
  environments: number;
}

export interface InferenceOptions {
  /** Signal extractors per source (default: the built-in ones). */
  extractors?: Readonly<Record<string, SignalExtractor>>;
  limit?: number;
  now?: () => Date;
}

/** Infers one tenant's setup from its own events and stores the facts. */
export async function inferTenantSetup(
  pool: pg.Pool,
  tenantId: string,
  options: InferenceOptions = {},
): Promise<InferenceResult> {
  const limit = options.limit ?? INFERENCE_EVENT_LIMIT;
  const events: CanonicalEvent[] = [];
  let cursor: string | null = null;
  do {
    const page = await queryEvents(pool, tenantId, {
      filter: { actions: INFERENCE_ACTIONS },
      order: "desc",
      limit: Math.min(PAGE, limit - events.length),
      cursor,
    });
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor && events.length < limit);

  // The admin's own mapping only: inference must not build on its own output.
  const own = await getMappingConfig(pool, tenantId);
  const facts = inferSetup(events, {
    mapping: compileMapping(own),
    adminEnvironmentIds: own.environments.map((e) => e.id),
    ...(options.extractors ? { extractors: options.extractors } : {}),
  });
  await replaceInferredSetup(pool, tenantId, facts, options.now?.() ?? new Date());
  return {
    tenantId,
    events: events.length,
    facts: facts.length,
    environments: new Set(facts.map((f) => f.subject)).size,
  };
}

/** Runs inference for every tenant with events, one tenant at a time (R5.6). */
export async function inferAllTenants(
  pool: pg.Pool,
  log: FastifyBaseLogger,
  options: InferenceOptions = {},
): Promise<{ tenants: number; failed: number }> {
  let failed = 0;
  const tenants = await listTenantsWithEvents(pool);
  for (const tenantId of tenants) {
    try {
      await inferTenantSetup(pool, tenantId, options);
    } catch (err) {
      failed++;
      log.warn({ tenantId, err: (err as Error).message }, "setup inference failed");
    }
  }
  return { tenants: tenants.length, failed };
}
