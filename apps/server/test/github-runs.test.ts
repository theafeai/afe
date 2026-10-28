import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { EnvKeyProvider, Secret } from "@afe/core/security";
import {
  createLocalUser,
  ingestEvent,
  setUserToolPolicy,
  setConnectionStatus,
  upsertConnection,
} from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { connectionConfig, workflowRunEvent, type GitHubWorkflowRun } from "@afe/connector-github";
import {
  fakeGitHub,
  installationFixture,
  json,
  testKeyPair,
} from "../../../packages/connector-github/test/fixtures.ts";
import { buildAfe, type AfeApp } from "../src/index.ts";
import { createGitHubModule } from "../src/connectors/github.ts";
import { tokenMapAuth } from "./helpers/auth.ts";
import { withLocalUsers } from "../src/auth/local-users.ts";

const { privatePem } = testKeyPair();
const keys = new EnvKeyProvider({ keys: { k: randomBytes(32) } });
const storage = "https://productionresultssa0.blob.core.windows.net/logs/job?sig=SIGNED_SECRET";

describe("GitHub live progress and completed job logs", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let eventId: string;
  let connectionId: string;
  let now: number;
  let run: GitHubWorkflowRun;
  let jobRun: number;
  let jobAttempt: number;
  let logStatus: number;
  let rateLimited: boolean;
  let api: ReturnType<typeof fakeGitHub>;
  let lines: string[];
  let downloads: RequestInit[];
  const base = () => `/api/events/${eventId}/github-run`;
  const get = (url = base(), token = "admin") =>
    afe.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM events; DELETE FROM connections");
    now = Date.now();
    jobRun = 100;
    jobAttempt = 1;
    logStatus = 302;
    rateLimited = false;
    lines = [];
    downloads = [];
    run = {
      id: 100,
      name: "Deploy",
      workflow_id: 1,
      run_number: 3,
      run_attempt: 1,
      event: "push",
      status: "in_progress",
      conclusion: null,
      head_branch: "main",
      head_sha: "a".repeat(40),
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      html_url: "https://github.com/acme/api/actions/runs/100",
    };
    api = fakeGitHub({
      "POST /app/installations/4242/access_tokens": () =>
        json(201, {
          token: "ghs_PRIVATE_TOKEN",
          expires_at: new Date(now + 3600_000).toISOString(),
          permissions: { actions: "read" },
        }),
      "GET /repos/acme/api/actions/runs/100/attempts/1": () =>
        rateLimited
          ? json(429, { message: "secondary rate limit" }, { "retry-after": "60" })
          : json(200, run),
      "GET /repos/acme/api/actions/runs/100/attempts/1/jobs": (req) => {
        const page = new URL(req.url).searchParams.get("page");
        return json(200, {
          total_count: 101,
          jobs: [
            {
              id: page === "1" ? 200 : 201,
              run_id: 100,
              run_attempt: 1,
              name: page === "1" ? "deploy (node 22)" : "deploy (node 24)",
              status: run.status,
              conclusion: run.conclusion,
              steps: [
                { number: 1, name: "Checkout", status: "completed", conclusion: "success" },
                { number: 2, name: "Deploy", status: run.status, conclusion: run.conclusion },
              ],
            },
          ],
        });
      },
      "GET /repos/acme/api/actions/jobs/200": () =>
        json(200, {
          id: 200,
          run_id: jobRun,
          run_attempt: jobAttempt,
          status: "completed",
          conclusion: run.conclusion,
        }),
      "GET /repos/acme/api/actions/jobs/200/logs": () =>
        logStatus === 302
          ? new Response(null, { status: 302, headers: { location: storage } })
          : json(logStatus, { message: "not ready" }),
    });
    connectionId = (
      await upsertConnection(pool, "default", {
        source: "github",
        externalId: "4242",
        name: "GitHub",
        status: "active",
        config: JSON.parse(
          JSON.stringify(
            connectionConfig({ ...installationFixture(), repository_selection: "selected" }, [
              { id: 11, full_name: "acme/api" },
            ]),
          ),
        ),
      })
    ).id;
    eventId = (
      await ingestEvent(
        pool,
        "default",
        workflowRunEvent(run, { id: 11, full_name: "acme/api" }, "in_progress", {
          connectionId,
          observedAt: new Date(now),
          method: "webhook",
        }),
      )
    ).event!.id;
    afe = await buildAfe({
      pool,
      keys,
      authProvider: withLocalUsers(
        pool,
        tokenMapAuth({
          admin: { tenantId: "default", roles: ["admin"] },
          other: { tenantId: "other", roles: ["admin"] },
        }),
      ),
      logStream: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
      connectors: [
        createGitHubModule({
          app: {
            appId: "77",
            slug: "test",
            privateKey: new Secret(privatePem),
            webhookSecret: new Secret("HOOK_SECRET"),
          },
          clock: () => now,
          http: { fetch: api.fetch, maxRetries: 0 },
          logDownload: {
            resolve: async () => ["203.0.113.1"],
            fetch: async (_url, init) => {
              downloads.push(init);
              return new Response(
                "2026-10-29T00:00:00Z deployment output <script>alert(1)</script>",
                { headers: { "content-type": "text/plain" } },
              );
            },
          },
        }),
      ],
    });
  });
  afterEach(async () => {
    await afe.app.close();
    expect(lines.join("")).not.toMatch(
      /ghs_PRIVATE_TOKEN|HOOK_SECRET|SIGNED_SECRET|PRIVATE KEY|deployment output/,
    );
  });

  it("refreshes step progress across jobs/pages, caches snapshots, and pins the stored attempt", async () => {
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json().jobs.map((j: { id: number }) => j.id)).toEqual([200, 201]);
    expect(first.json().jobs[0].steps[1].status).toBe("in_progress");
    const calls = api.requests.length;
    await get();
    expect(api.requests).toHaveLength(calls);
    now += 5001;
    run = { ...run, status: "completed", conclusion: "failure" };
    const last = (await get()).json();
    expect(last.nextPollMs).toBeNull();
    expect(last.jobs[0].steps[1].conclusion).toBe("failure");
    expect(
      api.requests
        .filter((r) => r.method === "GET")
        .every((r) => /\/attempts\/1(?:\/|\?|$)/.test(r.url)),
    ).toBe(true);
  });
  it.each(["success", "failure"])(
    "serves logs after %s without forwarding credentials or URLs",
    async (conclusion) => {
      expect((await get(`${base()}/jobs/200/log`)).statusCode).toBe(409);
      run = { ...run, status: "completed", conclusion };
      const res = await get(`${base()}/jobs/200/log`);
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toContain("deployment output");
      expect(res.body).not.toMatch(/SIGNED_SECRET|blob.core.windows.net|ghs_PRIVATE_TOKEN/);
      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.headers).not.toHaveProperty("authorization");
      expect(api.requests.every((r) => ["GET", "POST"].includes(r.method))).toBe(true);
      expect(
        api.requests
          .filter((r) => r.method === "POST")
          .every((r) => r.url.endsWith("/access_tokens")),
      ).toBe(true);
    },
  );
  it("rejects jobs from another run or rerun before downloading", async () => {
    run.status = "completed";
    jobRun = 999;
    expect((await get(`${base()}/jobs/200/log`)).statusCode).toBe(404);
    jobRun = 100;
    jobAttempt = 2;
    expect((await get(`${base()}/jobs/200/log`)).statusCode).toBe(404);
    expect(downloads).toHaveLength(0);
  });
  it("enforces tenant and user permissions before upstream access, including cache hits", async () => {
    const user = await createLocalUser(pool, "default", `viewer-${now}`);
    expect((await get(base(), "other")).statusCode).toBe(404);
    expect((await get(base(), user.token)).statusCode).toBe(404);
    expect(api.requests).toHaveLength(0);
    await setUserToolPolicy(pool, "default", user.user.id, "github", {
      mode: "custom",
      custom: [{ resource: "repository:acme/api", action: "read" }],
    });
    expect((await get(base(), user.token)).statusCode).toBe(200);
    const calls = api.requests.length;
    await setUserToolPolicy(pool, "default", user.user.id, "github", { mode: "none", custom: [] });
    expect((await get(base(), user.token)).statusCode).toBe(404);
    expect((await get(`${base()}/jobs/200/log`, user.token)).statusCode).toBe(404);
    expect(api.requests).toHaveLength(calls);
  });
  it("rejects inactive connections despite cached progress", async () => {
    expect((await get()).statusCode).toBe(200);
    await setConnectionStatus(pool, "default", connectionId, "revoked", "test");
    expect((await get()).statusCode).toBe(409);
  });
  it("reports missing/expired logs with a safe message", async () => {
    run.status = "completed";
    logStatus = 404;
    const res = await get(`${base()}/jobs/200/log`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("github_not_found");
    expect(downloads).toHaveLength(0);
  });

  it("returns GitHub's rate-limit deadline instead of polling immediately", async () => {
    rateLimited = true;
    const res = await get();
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("github_rate_limited");
    expect(res.json().retryAfterMs).toBeGreaterThanOrEqual(59_000);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(59);
  });

  it("rejects a repository removed from selection even when progress is cached", async () => {
    expect((await get()).statusCode).toBe(200);
    const calls = api.requests.length;
    await pool.query(
      "UPDATE connections SET config=jsonb_set(config,'{repositories}','[]'::jsonb) WHERE tenant_id=$1 AND id=$2",
      ["default", connectionId],
    );
    expect((await get()).statusCode).toBe(404);
    expect(api.requests).toHaveLength(calls);
  });

  it("does not replace a stored attempt with GitHub's newer rerun", async () => {
    run.run_attempt = 2;
    expect((await get()).statusCode).toBe(502);
    expect(api.requests.some((r) => r.url.includes("/jobs"))).toBe(false);
  });
});
