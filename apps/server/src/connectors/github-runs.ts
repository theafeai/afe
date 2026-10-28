import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eventAllowed, type CanonicalEvent } from "@afe/core";
import { getConnection, getEvent } from "@afe/db";
import { GitHubApiError, GitHubNetworkError, GitHubRateLimitError } from "@afe/connector-github";
import { requestTenant } from "../auth/index.ts";
import { requestEventAccess } from "../auth/permissions.ts";
import type { GitHubRuntime } from "./github.ts";
import { downloadGitHubJobLog, JobLogError } from "./github-log-download.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positiveId = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Exact stored run/attempt only: never guess a workflow from a SHA or arbitrary log URL. */
export function githubRunSubject(event: CanonicalEvent) {
  if (event.source !== "github" || !event.connectionId) return null;
  const repository = event.target.repository;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  if (repository.split("/").some((part) => part === "." || part === "..")) return null;
  const run = object(event.data.run);
  const job = object(event.data.job);
  const id = run.id ?? job.runId;
  const attempt = run.attempt ?? job.runAttempt;
  if (!positiveId(id) || !positiveId(attempt)) return null;
  return { repository, id, attempt };
}

class RunError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerGitHubRunRoutes(app: FastifyInstance, rt: GitHubRuntime) {
  const { ctx } = rt;
  // Short-lived, bounded metadata cache only. Authorization and connection checks run before it.
  const cache = new Map<
    string,
    { until: number; value: Promise<Awaited<ReturnType<typeof progress>>> }
  >();
  let activeDownloads = 0;
  let activeProgress = 0;

  async function authorize(req: FastifyRequest, id: string) {
    const tenant = requestTenant(req);
    if (!UUID.test(id)) throw new RunError(404, "not_found", "Event not found.");
    const event = await getEvent(ctx.pool, tenant, id);
    const access = await requestEventAccess(ctx.pool, req, ctx);
    if (!event || (access && !eventAllowed(access, event)))
      throw new RunError(404, "not_found", "Event not found.");
    const subject = githubRunSubject(event);
    if (!subject)
      throw new RunError(
        404,
        "run_unavailable",
        "This event has no exact workflow run and attempt.",
      );
    const connection = await getConnection(ctx.pool, tenant, event.connectionId!);
    if (!connection || connection.source !== "github" || connection.status !== "active")
      throw new RunError(409, "connection_unavailable", "The GitHub connection is inactive.");
    const repos = connection.config.repositories;
    if (
      repos !== "all" &&
      (!Array.isArray(repos) ||
        !repos.some(
          (r) => String(object(r).fullName).toLowerCase() === subject.repository.toLowerCase(),
        ))
    )
      throw new RunError(404, "not_found", "Repository is no longer selected.");
    if (!connection.config.permissions || object(connection.config.permissions).actions !== "read")
      throw new RunError(
        403,
        "github_permission_required",
        "The GitHub App needs Actions read permission.",
      );
    if (!(await rt.app()))
      throw new RunError(503, "github_unavailable", "The GitHub App is not configured.");
    const client = await rt.installationClient(connection);
    const [owner, repo] = subject.repository.split("/") as [string, string];
    return {
      ...subject,
      owner,
      repo,
      client,
      key: JSON.stringify([tenant, connection.id, connection.externalId, subject]),
    };
  }
  type Authorized = Awaited<ReturnType<typeof authorize>>;

  async function progress(a: Authorized) {
    if (activeProgress >= 8)
      throw new RunError(
        429,
        "github_busy",
        "Workflow reads are busy. Progress will retry shortly.",
      );
    activeProgress++;
    try {
      const run = await a.client.getWorkflowRunAttempt(a.owner, a.repo, a.id, a.attempt);
      if (run.id !== a.id || (run.run_attempt ?? 1) !== a.attempt)
        throw new RunError(
          502,
          "github_unavailable",
          "GitHub returned a different workflow attempt.",
        );
      const jobs = [];
      let total = 0;
      for (let page = 1; page <= 5; page++) {
        const result = await a.client.workflowJobsPage(a.owner, a.repo, a.id, a.attempt, page);
        total = result.total_count;
        jobs.push(
          ...result.jobs.filter((j) => j.run_id === a.id && (j.run_attempt ?? 1) === a.attempt),
        );
        if (page * 100 >= total || result.jobs.length === 0) break;
      }
      return {
        run: {
          id: run.id,
          attempt: a.attempt,
          name: run.name ?? "Workflow",
          status: run.status,
          conclusion: run.conclusion,
          url: `https://github.com/${a.repository}/actions/runs/${a.id}/attempts/${a.attempt}`,
        },
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          startedAt: j.started_at ?? null,
          completedAt: j.completed_at ?? null,
          steps: (j.steps ?? []).map((s) => ({
            number: s.number,
            name: s.name,
            status: s.status,
            conclusion: s.conclusion,
            startedAt: s.started_at ?? null,
            completedAt: s.completed_at ?? null,
          })),
        })),
        partial: total > jobs.length,
        checkedAt: new Date(rt.clock()).toISOString(),
        nextPollMs: run.status === "completed" ? null : 5000,
      };
    } finally {
      activeProgress--;
    }
  }

  function cached(a: Authorized) {
    const prior = cache.get(a.key);
    if (prior && prior.until > rt.clock()) return prior.value;
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    const entry = { until: rt.clock() + 5000, value: progress(a) };
    cache.set(a.key, entry);
    entry.value.catch(() => {
      if (cache.get(a.key) === entry) cache.delete(a.key);
    });
    return entry.value;
  }

  function failure(reply: FastifyReply, err: unknown) {
    if (err instanceof RunError)
      return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof GitHubRateLimitError) {
      const retryAfterMs = Math.max(5000, err.retryAfter.getTime() - rt.clock());
      return reply
        .code(429)
        .header("retry-after", Math.ceil(retryAfterMs / 1000))
        .send({
          error: "github_rate_limited",
          message: "GitHub is rate limiting requests. Progress will resume automatically.",
          retryAfterMs,
        });
    }
    if (err instanceof JobLogError) {
      const tooLarge = err.code === "logs_too_large";
      return reply.code(tooLarge ? 413 : 502).send({
        error: err.code,
        message: tooLarge
          ? "This job log exceeds Afe's 2 MiB viewing limit. View the full log on GitHub."
          : "GitHub's job log could not be downloaded. Try again or view it on GitHub.",
      });
    }
    if (err instanceof GitHubApiError) {
      if (err.status === 404 || err.status === 410)
        return reply.code(404).send({
          error: "github_not_found",
          message:
            "GitHub could not provide this run or log. It may be unavailable, deleted, expired, or inaccessible.",
        });
      if (err.status === 401 || err.status === 403)
        return reply.code(403).send({
          error: "github_access_denied",
          message: "GitHub denied access. Check the connection and Actions read permission.",
        });
    }
    if (err instanceof GitHubApiError || err instanceof GitHubNetworkError)
      return reply.code(502).send({
        error: "github_unavailable",
        message: "GitHub is unavailable. Try again shortly.",
      });
    throw err;
  }

  app.get<{ Params: { id: string } }>("/api/events/:id/github-run", async (req, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return await cached(await authorize(req, req.params.id));
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.get<{ Params: { id: string; jobId: string } }>(
    "/api/events/:id/github-run/jobs/:jobId/log",
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      try {
        const a = await authorize(req, req.params.id);
        const jobId = Number(req.params.jobId);
        if (!/^\d+$/.test(req.params.jobId) || !positiveId(jobId))
          throw new RunError(400, "bad_request", "Invalid job id.");
        if (activeDownloads >= 4)
          throw new RunError(429, "logs_busy", "Log downloads are busy. Try again shortly.");
        activeDownloads++;
        try {
          const run = await a.client.getWorkflowRunAttempt(a.owner, a.repo, a.id, a.attempt);
          if (run.id !== a.id || (run.run_attempt ?? 1) !== a.attempt)
            throw new RunError(404, "not_found", "Run not found.");
          if (run.status !== "completed")
            throw new RunError(
              409,
              "logs_pending",
              "Logs are available after this workflow attempt finishes.",
            );
          const job = await a.client.getWorkflowJob(a.owner, a.repo, jobId);
          if (job.run_id !== a.id || (job.run_attempt ?? 1) !== a.attempt)
            throw new RunError(404, "not_found", "Job not found in this workflow attempt.");
          const location = await a.client.workflowJobLogLocation(a.owner, a.repo, jobId);
          const text = await downloadGitHubJobLog(location, rt.options.logDownload);
          return { jobId, attempt: a.attempt, text };
        } finally {
          activeDownloads--;
        }
      } catch (err) {
        return failure(reply, err);
      }
    },
  );
}
