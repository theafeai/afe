import { Agent, fetch as downloadFetch } from "undici";
import { createSafeLookup, validateOutboundUrl } from "@afe/core/security";
import { Readable, Transform } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { FastifyInstance } from "fastify";
import type { GitHubOperation } from "@afe/core";
import {
  type GitHubOperations,
  githubOperationError as fail,
  type RepoParams,
} from "./github-operations.ts";

/** Only GitHub's documented archive storage hosts; no arbitrary outbound proxy. */
export function githubArchiveUrl(location: string): URL {
  const u = new URL(location);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    ![".blob.core.windows.net", ".actions.githubusercontent.com", ".githubusercontent.com"].some(
      (s) => u.hostname.endsWith(s),
    )
  )
    throw fail(502, "GitHub returned an unsupported archive host.");
  return u;
}
const LIMIT = 10 * 1024 * 1024 * 1024;
export function registerGitHubDownloads(app: FastifyInstance, service: GitHubOperations) {
  const active = new Map<string, number>();
  let total = 0;
  const dispatcher = new Agent({
    connect: { lookup: createSafeLookup() },
    headersTimeout: 15000,
    bodyTimeout: 60000,
  });
  app.addHook("onClose", async () => {
    await dispatcher.close();
  });
  app.get<{
    Params: RepoParams;
    Querystring: { connectionId?: string; kind?: string; id?: string; attempt?: string };
  }>("/api/actions/github/repositories/:owner/:repo/download", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return service.guarded(async () => {
      const q = req.query,
        c = await service.scope(
          req,
          q.connectionId,
          `${req.params.owner}/${req.params.repo}`.toLowerCase(),
        );
      const id = Number(q.id);
      if (!Number.isSafeInteger(id) || id < 1 || !["artifact", "logs"].includes(q.kind ?? ""))
        throw fail(400, "Select an artifact or completed run archive.");
      const action: GitHubOperation =
        q.kind === "artifact" ? "github.artifact_download" : "github.logs_download";
      service.require(c, action);
      let path: string;
      if (q.kind === "artifact") {
        const artifact = (
          await service.request<{ id: number; expired: boolean }>(
            c,
            `${c.path}/actions/artifacts/${id}`,
          )
        ).data;
        if (artifact.id !== id || artifact.expired) throw fail(410, "This artifact has expired.");
        path = `${c.path}/actions/artifacts/${id}/zip`;
      } else {
        const attempt = Number(q.attempt);
        if (!Number.isSafeInteger(attempt) || attempt < 1) throw fail(400, "Select a run attempt.");
        const run = await service.run(c, id);
        if (run.status !== "completed")
          throw fail(
            409,
            "GitHub exposes archived logs after completion. Live capture is tracked separately in AFE-52.",
          );
        if (attempt > Number(run.run_attempt)) throw fail(404, "Run attempt not found.");
        path = `${c.path}/actions/runs/${id}/attempts/${attempt}/logs`;
      }
      const key = `${c.tid}:${c.uid}`;
      if (total >= 8 || (active.get(key) ?? 0) >= 2)
        throw fail(429, "Too many archive downloads. Wait for the current transfer to finish.");
      total++;
      active.set(key, (active.get(key) ?? 0) + 1);
      let streaming = false,
        released = false;
      const release = () => {
        if (released) return;
        released = true;
        total--;
        const n = (active.get(key) ?? 1) - 1;
        if (n) active.set(key, n);
        else active.delete(key);
      };
      const abort = new AbortController();
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(300000), abort.signal]);
        const response = await fetch("https://api.github.com" + path, {
          headers: {
            authorization: `Bearer ${c.token.secret.reveal()}`,
            accept: "application/vnd.github+json",
            "user-agent": "afe-github-operations",
            "x-github-api-version": "2022-11-28",
          },
          redirect: "manual",
          signal,
        });
        if (response.status !== 302) {
          await response.body?.cancel();
          throw fail(
            response.status === 404
              ? 404
              : response.status === 410
                ? 410
                : response.status === 403
                  ? 403
                  : 502,
            "GitHub did not provide this archive. It may be unavailable or access may have changed.",
          );
        }
        const url = githubArchiveUrl(response.headers.get("location") ?? "");
        await response.body?.cancel();
        await validateOutboundUrl(url.toString());
        // The signed destination gets no GitHub bearer token, cookies or custom headers.
        const archive = await downloadFetch(url, { dispatcher, redirect: "manual", signal });
        if (!archive.ok) {
          await archive.body?.cancel();
          throw fail(502, "The archive could not be downloaded.");
        }
        if (Number(archive.headers.get("content-length") ?? 0) > LIMIT) {
          await archive.body?.cancel();
          throw fail(413, "Archive exceeds Afe's 10 GiB download limit.");
        }
        if (!archive.body) throw fail(502, "The archive is empty.");
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > LIMIT) done(new Error("GitHub archive exceeds the 10 GiB transfer limit."));
            else done(null, chunk);
          },
        });
        const source = Readable.fromWeb(archive.body as unknown as ReadableStream);
        source.on("error", () => bounded.destroy(new Error("GitHub archive transfer failed.")));
        bounded.on("close", () => {
          source.destroy();
          abort.abort();
          release();
        });
        reply.raw.on("close", () => {
          if (!bounded.destroyed) bounded.destroy();
        });
        streaming = true;
        return reply
          .header("content-type", "application/zip")
          .header(
            "content-disposition",
            `attachment; filename="github-${q.kind}-${id}${q.kind === "logs" ? `-attempt-${q.attempt}` : ""}.zip"`,
          )
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .send(source.pipe(bounded));
      } finally {
        if (!streaming) {
          abort.abort();
          release();
        }
      }
    });
  });
}
