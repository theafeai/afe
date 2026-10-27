/**
 * Commit containment (AFE-22) as a server module: `GET /api/containment`
 * ("is commit X included in what is live, per environment"), the reusable
 * `ContainmentService` (`containmentService(ctx)`, also for the correlation
 * service, AFE-20) and the job that prunes the comparison cache table.
 * Reference: docs/containment.md, docs/api.md.
 */
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import { requestTenant } from "../auth/index.ts";
import { githubRuntime } from "../connectors/github.ts";
import { pruneComparisons } from "./cache.ts";
import {
  commitArgument,
  ContainmentService,
  githubRepositoryName,
  RepositoryNotFoundError,
  type ContainmentOptions,
} from "./service.ts";

export { ComparisonCache, pruneComparisons } from "./cache.ts";
export {
  liveDeployments,
  isPlacement,
  placedCommit,
  type LiveDeployment,
  type LiveResult,
} from "./live.ts";
export * from "./service.ts";

export const CONTAINMENT_ROUTE = "/api/containment";
export const CONTAINMENT_JOBS = { PRUNE: "containment.prune" } as const;

const DAY_MS = 24 * 3600_000;
/** Cache rows unused for this long are deleted when retention has no maximum. */
const DEFAULT_PRUNE_AFTER_MS = 60 * DAY_MS;

export interface ContainmentModuleOptions extends ContainmentOptions {
  /** Cron (UTC) of the cache prune job. Default daily at 03:41. */
  pruneSchedule?: string;
}

export interface ContainmentModule extends ConnectorModule {
  service(ctx: ServerContext): ContainmentService;
}

const services = new WeakMap<ServerContext, ContainmentService>();

/** The containment service bound to a server context, when the module is registered. */
export function containmentService(ctx: ServerContext): ContainmentService | undefined {
  return services.get(ctx);
}

export function createContainmentModule(options: ContainmentModuleOptions = {}): ContainmentModule {
  const service = (ctx: ServerContext): ContainmentService => {
    let s = services.get(ctx);
    if (!s) {
      // `ctx.mapping` is read on each request (the mapping module may register later).
      const view = {
        pool: ctx.pool,
        retention: ctx.retention,
        log: ctx.log,
        get mapping() {
          return ctx.mapping;
        },
      };
      s = new ContainmentService(view, () => githubRuntime(ctx), options);
      services.set(ctx, s);
    }
    return s;
  };

  return {
    source: "containment",
    service,
    routes(app, ctx) {
      const svc = service(ctx);
      app.get(CONTAINMENT_ROUTE, { config: { access: "viewer" } }, async (req, reply) => {
        const tenantId = requestTenant(req);
        const q = (req.query ?? {}) as Record<string, unknown>;
        const repository =
          typeof q.repository === "string" ? githubRepositoryName(q.repository) : null;
        const commit = commitArgument(q.commit);
        if (!repository || !commit) {
          return reply.code(400).send({
            error: "bad_request",
            message:
              "repository (owner/name of a GitHub repository) and commit (7 to 64 hex characters) are required",
          });
        }
        try {
          return await svc.check(tenantId, repository, commit);
        } catch (err) {
          if (err instanceof RepositoryNotFoundError) {
            return reply.code(404).send({ error: "not_found" });
          }
          throw err;
        }
      });
    },
    jobs(ctx): JobDefinition[] {
      return [
        {
          name: CONTAINMENT_JOBS.PRUNE,
          schedule: options.pruneSchedule ?? "41 3 * * *",
          scheduleData: {},
          retryLimit: 1,
          async handler() {
            const window = ctx.retention.maxWindowMs ?? DEFAULT_PRUNE_AFTER_MS;
            const n = await pruneComparisons(ctx.pool, new Date(Date.now() - window));
            if (n > 0) ctx.log.info({ rows: n }, "containment.prune: deleted unused comparisons");
          },
        },
      ];
    },
  };
}

export const containmentModule: ContainmentModule = createContainmentModule();
