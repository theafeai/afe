import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  GITHUB_RUN_ACTIONS,
  type GitHubRunAction,
  type GitHubRunControls,
  type GitHubActionState,
} from "@afe/core";
import { GitHubHttp, GitHubApiError, GitHubRateLimitError } from "@afe/connector-github";
import { getEvent, getConnection, getCredential, getUserToolPolicy } from "@afe/db";
import { requestTenant } from "../auth/index.ts";
import { toolAccounts } from "../auth/tool-accounts.ts";
import type { ConnectorModule, ServerContext } from "../context.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const messages: Record<GitHubActionState, string> = {
  requested: "Request recorded; verify the source state before trying another action.",
  accepted: "GitHub accepted the request. Refresh to observe the resulting run state.",
  rejected: "GitHub rejected the request. Refresh and check your source permissions and run state.",
  unknown:
    "GitHub's response was not confirmed. Check the source state before submitting another request.",
};

type Params = { eventId: string };
type Run = {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  repository: { full_name: string };
};

/** Independent from log transport and from the read-only installation client. */
export function registerGitHubActions(app: FastifyInstance, ctx: ServerContext) {
  // Shared transport retains rate-limit buckets; mutations never retry automatically.
  const http = new GitHubHttp({ maxRetries: 0, maxResponseBytes: 1024 * 1024 });
  async function context(req: FastifyRequest<{ Params: Params }>) {
    const tid = requestTenant(req),
      uid = req.principal?.localUserId;
    if (!uid)
      throw fail(
        403,
        "Run controls require a managed user with a linked GitHub account and explicit action grants.",
      );
    if (!uuid.test(req.params.eventId)) throw fail(404, "Event not found.");
    const event = await getEvent(ctx.pool, tid, req.params.eventId);
    const repo = event?.target.repository?.toLowerCase();
    // Only primary GitHub workflow-run records can select a mutation target.
    if (
      !event ||
      event.source !== "github" ||
      event.target.type !== "workflow_run" ||
      !event.connectionId ||
      !repo ||
      !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)
    )
      throw fail(404, "GitHub workflow run not found.");
    const runId = Number(/^github:(\d+)$/.exec(event.correlation.runIds?.[0] ?? "")?.[1]);
    if (!Number.isSafeInteger(runId) || runId <= 0)
      throw fail(404, "GitHub workflow run not found.");
    const policy = await getUserToolPolicy(ctx.pool, tid, uid, "github");
    if (policy.mode === "none") throw fail(404, "GitHub workflow run not found.");
    const read =
      policy.mode === "source" ||
      policy.mode === "source + custom" ||
      policy.custom.some(
        (g) =>
          g.action === "read" &&
          [`repository:${repo}`, `connection:${event.connectionId}`].includes(g.resource),
      );
    if (!read) throw fail(404, "GitHub workflow run not found.");
    const connection = await getConnection(ctx.pool, tid, event.connectionId);
    if (!connection || connection.source !== "github" || connection.status !== "active")
      throw fail(409, "The GitHub connection is not active.");
    const account = (await toolAccounts(ctx, tid, uid)).find((a) => a.tool === "github");
    const stored = account && (await getCredential(ctx.pool, ctx.keys, tid, account.credential_id));
    if (!stored) throw fail(403, "Link your GitHub account in Profile to use run controls.");
    const options = { token: stored.secret, bucket: `actions:${tid}:${uid}` };
    const path = `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
    const upstream = (
      await http.request<{ permissions?: { push?: boolean; admin?: boolean; maintain?: boolean } }>(
        { method: "GET", path, ...options },
      )
    ).data;
    const custom = policy.mode === "custom" || policy.mode === "source + custom";
    const write =
      upstream.permissions?.push === true ||
      upstream.permissions?.admin === true ||
      upstream.permissions?.maintain === true;
    const grants = GITHUB_RUN_ACTIONS.filter(
      (action) =>
        custom &&
        policy.custom.some((g) => g.resource === `repository:${repo}` && g.action === action),
    );
    return {
      tid,
      uid,
      repo,
      runId,
      connectionId: connection.id,
      options,
      path: `${path}/actions/runs/${runId}`,
      write,
      grants,
    };
  }
  async function readRun(c: Awaited<ReturnType<typeof context>>) {
    const run = (await http.request<Run>({ method: "GET", path: c.path, ...c.options })).data;
    if (
      run.id !== c.runId ||
      run.repository?.full_name?.toLowerCase() !== c.repo ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1
    )
      throw fail(502, "GitHub returned an invalid run context.");
    return run;
  }
  function enabled(action: GitHubRunAction, run: Run) {
    return action === "github.cancel"
      ? ["queued", "in_progress", "waiting", "pending", "requested"].includes(run.status)
      : run.status === "completed" &&
          (action !== "github.rerun_failed" ||
            ["failure", "timed_out"].includes(run.conclusion ?? ""));
  }
  async function guarded<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GitHubRateLimitError)
        throw fail(429, "GitHub is rate limiting requests. Wait before refreshing.");
      if (err instanceof GitHubApiError)
        throw fail(
          err.status === 404 ? 404 : err.status === 401 || err.status === 403 ? 403 : 502,
          "GitHub could not authorize or complete this request. Check your account and run state.",
        );
      if (err instanceof Error && "statusCode" in err) throw err;
      throw fail(502, "GitHub is unavailable. Refresh to check the current state.");
    }
  }
  const url = "/api/actions/github/events/:eventId";
  app.get<{ Params: Params }>(url, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return guarded(async (): Promise<GitHubRunControls> => {
      const c = await context(req),
        run = await readRun(c);
      const prior = (
        await ctx.pool.query<{ action: string }>(
          "SELECT action FROM github_action_requests WHERE tenant_id=$1 AND repository=$2 AND run_id=$3 AND run_attempt=$4",
          [c.tid, c.repo, c.runId, run.run_attempt],
        )
      ).rows;
      return {
        context: {
          connectionId: c.connectionId,
          repository: c.repo,
          runId: c.runId,
          runAttempt: run.run_attempt,
        },
        status: run.status,
        conclusion: run.conclusion,
        capabilities: GITHUB_RUN_ACTIONS.map((action) => {
          const reason = !c.grants.includes(action)
            ? "Ask your administrator for this repository action grant."
            : !c.write
              ? "Your GitHub account needs write access to this repository."
              : prior.some(
                    (p) =>
                      p.action === action ||
                      (action !== "github.cancel" && p.action !== "github.cancel"),
                  )
                ? "Already requested for this attempt. Check GitHub before retrying."
                : !enabled(action, run)
                  ? "Unavailable in the current run state."
                  : null;
          return { action, enabled: reason === null, reason };
        }),
      };
    });
  });
  app.post<{
    Params: Params;
    Body: { action?: unknown; expectedAttempt?: unknown; requestId?: unknown; confirmed?: unknown };
  }>(url, { config: { access: "viewer" }, bodyLimit: 4096 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    return guarded(async () => {
      if (!req.principal?.localUserId)
        throw fail(
          403,
          "Run controls require a managed user with a linked GitHub account and explicit action grants.",
        );
      const b = req.body;
      if (
        !b ||
        !GITHUB_RUN_ACTIONS.includes(b.action as GitHubRunAction) ||
        !Number.isSafeInteger(b.expectedAttempt) ||
        Number(b.expectedAttempt) < 1 ||
        typeof b.requestId !== "string" ||
        !uuid.test(b.requestId) ||
        b.confirmed !== true
      )
        throw fail(400, "Supply action, expectedAttempt, UUID requestId and confirmed: true.");
      const action = b.action as GitHubRunAction,
        requestId = b.requestId;
      const c = await context(req);
      if (!c.write || !c.grants.includes(action))
        throw fail(
          403,
          "Both an explicit Afe repository action grant and GitHub write access are required.",
        );
      const prior = (
        await ctx.pool.query<{
          actor_id: string;
          repository: string;
          run_id: string;
          run_attempt: number;
          action: string;
          state: GitHubActionState;
        }>(
          "SELECT actor_id,repository,run_id,run_attempt,action,state FROM github_action_requests WHERE tenant_id=$1 AND request_id=$2",
          [c.tid, requestId],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.actor_id !== req.principal!.id ||
          prior.repository !== c.repo ||
          Number(prior.run_id) !== c.runId ||
          prior.run_attempt !== b.expectedAttempt ||
          prior.action !== action
        )
          throw fail(409, "Request ID was already used for another operation.");
        return { requestId, state: prior.state, message: messages[prior.state] };
      }
      const run = await readRun(c);
      if (run.run_attempt !== b.expectedAttempt || !enabled(action, run))
        throw fail(
          409,
          "The run changed or this action is unavailable. Refresh before continuing.",
        );
      const inserted = await ctx.pool.query(
        `INSERT INTO github_action_requests (tenant_id,request_id,actor_id,connection_id,repository,run_id,run_attempt,action)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING request_id`,
        [
          c.tid,
          requestId,
          req.principal!.id,
          c.connectionId,
          c.repo,
          c.runId,
          run.run_attempt,
          action,
        ],
      );
      if (!inserted.rowCount)
        throw fail(
          409,
          "This action was already requested for this attempt. Refresh to check the source state.",
        );
      let state: GitHubActionState = "unknown";
      try {
        await http.request({
          method: "POST",
          path: `${c.path}/${action === "github.cancel" ? "cancel" : action === "github.rerun" ? "rerun" : "rerun-failed-jobs"}`,
          ...c.options,
        });
        state = "accepted";
      } catch (err) {
        // A timeout/5xx can occur after GitHub accepted the request. Never retry it.
        state =
          err instanceof GitHubApiError && err.status >= 400 && err.status < 500
            ? "rejected"
            : "unknown";
      }
      await ctx.pool.query(
        "UPDATE github_action_requests SET state=$3 WHERE tenant_id=$1 AND request_id=$2",
        [c.tid, requestId, state],
      );
      ctx.log.info(
        {
          tenantId: c.tid,
          actorId: req.principal!.id,
          repository: c.repo,
          runId: c.runId,
          runAttempt: run.run_attempt,
          action,
          state,
          requestId,
        },
        "GitHub action request",
      );
      return reply
        .code(state === "accepted" ? 202 : state === "rejected" ? 409 : 502)
        .send({ requestId, state, message: messages[state] });
    });
  });
}
export const githubActionsModule: ConnectorModule = {
  source: "github-actions",
  routes: registerGitHubActions,
  jobs: (ctx) => [
    {
      name: "github-actions.purge",
      schedule: "29 * * * *",
      handler: async () => {
        // Explicit cross-tenant maintenance: discover tenants, then delete scoped rows.
        const tenants = await ctx.pool.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM github_action_requests",
        );
        for (const { tenant_id: tid } of tenants.rows) {
          const cutoff = await ctx.retention.cutoff(tid, new Date());
          if (cutoff)
            await ctx.pool.query(
              "DELETE FROM github_action_requests WHERE tenant_id=$1 AND created_at < $2",
              [tid, cutoff],
            );
        }
      },
    },
  ],
};
