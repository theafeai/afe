/**
 * AFE-22: commit containment against a fake GitHub compare endpoint.
 * "Is commit X included in what is live, per environment."
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { CanonicalEventInputLike } from "@afe/core";
import { EnvKeyProvider, Secret } from "@afe/core/security";
import { ingestEvent, upsertConnection } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import type { GitHubAppConfig } from "@afe/connector-github";
import {
  installationFixture,
  json,
  testKeyPair,
} from "../../../packages/connector-github/test/fixtures.ts";
import { buildAfe, InlineJobQueue, type AfeApp } from "../src/index.ts";
import { createGitHubModule, githubRuntime } from "../src/connectors/github.ts";
import { createMappingModule } from "../src/mapping/index.ts";
import {
  CONTAINMENT_JOBS,
  ContainmentService,
  containmentService,
  createContainmentModule,
  type ContainmentReport,
} from "../src/containment/index.ts";
import { tokenMapAuth } from "./helpers/auth.ts";

const TOKEN = "ghs_AFE22_INSTALLATION_TOKEN";
const { privatePem } = testKeyPair();
const appConfig: GitHubAppConfig = {
  appId: "77",
  slug: "afe-test",
  privateKey: new Secret(privatePem),
  webhookSecret: new Secret("whsec-AFE22-TEST-SECRET"),
};
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });
const PERMS = { actions: "read", deployments: "read", metadata: "read", contents: "read" };
const NO_CONTENTS = { actions: "read", deployments: "read", metadata: "read" };

const A = { authorization: "Bearer viewer-a" };
const B = { authorization: "Bearer viewer-b" };
const C = { authorization: "Bearer viewer-c" };
const auth = tokenMapAuth({
  "viewer-a": { tenantId: "default", roles: ["viewer"] },
  "viewer-b": { tenantId: "other", roles: ["viewer"] },
  "viewer-c": { tenantId: "noperm", roles: ["viewer"] },
});

const sha = (c: string) => c.repeat(40);
/** Live commits. */
const L_PROD = sha("1");
const L_OLD = sha("0");
const L_STAGING = sha("2");
const L_CANARY = sha("3");

let n = 0;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function placement(o: {
  env: string;
  commit: string | null;
  minutesAgo: number;
  source?: "github" | "argocd";
  repository?: string;
}): CanonicalEventInputLike {
  n++;
  const argo = o.source === "argocd";
  return {
    source: o.source ?? "github",
    sourceEventId: `afe22:${n}`,
    action: argo ? "argocd.sync.succeeded" : "deployment.status_updated",
    actor: { type: "user", id: "1", login: "octocat" },
    target: argo
      ? {
          type: "application",
          id: `argocd/${o.env}`,
          application: `web-${o.env}`,
          environment: o.env,
          repository: `https://github.com/${o.repository ?? "acme/web"}.git`,
        }
      : {
          type: "environment",
          id: `${o.repository ?? "acme/web"}:${o.env}`,
          environment: o.env,
          repository: o.repository ?? "acme/web",
        },
    trigger: { type: "manual" },
    outcome: "succeeded",
    occurredAt: ago(o.minutesAgo),
    observedAt: ago(o.minutesAgo),
    observation: { method: "webhook" },
    correlation: {
      repositories: [`github.com/${o.repository ?? "acme/web"}`],
      ...(o.commit ? { commitShas: [o.commit] } : {}),
    },
  };
}

interface CompareCall {
  base: string;
  head: string;
  perPage: string | null;
  auth: string | undefined;
}

describe("commit containment (AFE-22)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let calls: CompareCall[];
  /** Answers of the compare endpoint by "base...head"; missing pairs answer 404. */
  let answers: Record<string, () => Response>;
  /** Base SHAs whose compare never answers. */
  let hanging: Set<string>;

  const compare =
    (status: string, aheadBy = 0, behindBy = 0) =>
    () =>
      json(200, {
        status,
        ahead_by: aheadBy,
        behind_by: behindBy,
        total_commits: aheadBy,
        base_commit: { sha: "x" },
        merge_base_commit: { sha: sha("9") },
        commits: [{ sha: "c", commit: { message: "SECRET COMMIT MESSAGE" } }],
        files: [],
      });

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (init.method === "POST" && u.pathname === "/app/installations/4242/access_tokens") {
      return json(201, {
        token: TOKEN,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: PERMS,
      });
    }
    const m = /^\/repos\/acme\/web\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(u.pathname);
    if (init.method === "GET" && m) {
      calls.push({
        base: m[1]!,
        head: m[2]!,
        perPage: u.searchParams.get("per_page"),
        auth: headers.authorization,
      });
      if (hanging.has(m[1]!)) return new Promise<Response>(() => {});
      const answer = answers[`${m[1]}...${m[2]}`];
      return answer ? answer() : json(404, { message: "Not Found" });
    }
    return json(404, { message: "Not Found" });
  };

  const get = (url: string, headers: Record<string, string> = A) =>
    afe.app.inject({ method: "GET", url, headers });

  async function check(commit: string, headers = A, repository = "acme/web") {
    const res = await get(
      `/api/containment?${new URLSearchParams({ repository, commit }).toString()}`,
      headers,
    );
    return { status: res.statusCode, body: res.json() as ContainmentReport };
  }

  const envOf = (r: ContainmentReport, name: string) => {
    const e = r.environments.find((x) => x.environment === name);
    if (!e) throw new Error(`no environment ${name} in ${JSON.stringify(r.environments)}`);
    return e;
  };

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ('other', 'Other'), ('noperm', 'No permission')",
    );
    const jobs = new InlineJobQueue();
    afe = await buildAfe({
      authProvider: auth,
      pool,
      jobs,
      keys,
      logLevel: "silent",
      connectors: [
        createGitHubModule({
          app: appConfig,
          http: { fetch, maxRetries: 0, sleep: async () => {} },
          reconcile: { enabled: false },
        }),
        createMappingModule(),
        createContainmentModule(),
      ],
    });
    jobs.register(afe.jobDefinitions);

    for (const tenant of ["default", "noperm"]) {
      await upsertConnection(pool, tenant, {
        source: "github",
        externalId: tenant === "default" ? "4242" : "4343",
        name: "acme",
        status: "active",
        config: {
          ...installationFixture({ permissions: tenant === "default" ? PERMS : NO_CONTENTS }),
          installationId: tenant === "default" ? 4242 : 4343,
          repositories: [{ id: 11, fullName: "acme/web" }],
        } as never,
      });
      // Production: L_OLD, then L_PROD twice (a redeploy): live since the first L_PROD.
      await ingestEvent(
        pool,
        tenant,
        placement({ env: "Production – web", commit: L_OLD, minutesAgo: 300 }),
      );
      await ingestEvent(
        pool,
        tenant,
        placement({ env: "Production – web", commit: L_PROD, minutesAgo: 200 }),
      );
      await ingestEvent(
        pool,
        tenant,
        placement({ env: "Production – web", commit: L_PROD, minutesAgo: 100 }),
      );
      // Staging via ArgoCD (repository URL form).
      await ingestEvent(
        pool,
        tenant,
        placement({ env: "staging", commit: L_STAGING, minutesAgo: 50, source: "argocd" }),
      );
      // An environment no mapping rule knows: shown by its raw name.
      await ingestEvent(
        pool,
        tenant,
        placement({ env: "canary-eu", commit: L_CANARY, minutesAgo: 40 }),
      );
      // Live without a commit.
      await ingestEvent(
        pool,
        tenant,
        placement({ env: "hotfix-box", commit: null, minutesAgo: 30 }),
      );
      // Another repository: never listed.
      await ingestEvent(
        pool,
        tenant,
        placement({ env: "production", commit: sha("4"), minutesAgo: 20, repository: "acme/api" }),
      );
    }
  });

  afterAll(async () => {
    await afe.app.close();
    await pool.end();
  });

  beforeEach(() => {
    calls = [];
    answers = {};
    hanging = new Set();
  });

  it("lists the live commit per environment, with mapped names, live-since and evidence", async () => {
    const X = sha("a");
    answers[`${X}...${L_PROD}`] = compare("ahead", 3);
    answers[`${X}...${L_STAGING}`] = compare("behind", 0, 2);
    answers[`${X}...${L_CANARY}`] = compare("diverged", 1, 1);
    const { status, body } = await check(X);
    expect(status).toBe(200);
    expect(body.repository).toBe("acme/web");
    expect(body.commit).toBe(X);
    expect(body.partial).toBe(false);
    expect(body.environments.map((e) => e.environment)).toEqual([
      "hotfix-box",
      "canary-eu",
      "Staging",
      "Production",
    ]);

    const prod = envOf(body, "Production");
    expect(prod).toMatchObject({
      environmentId: "production",
      source: "github",
      liveCommit: L_PROD,
      contained: true,
      reasonCode: "ancestor",
      cached: false,
      comparison: { status: "ahead", aheadBy: 3, behindBy: 0, mergeBaseSha: sha("9") },
    });
    expect(prod.evidence).toHaveLength(2);
    expect(new Date(prod.liveSince).getTime()).toBeCloseTo(ago(200).getTime(), -4);

    expect(envOf(body, "Staging")).toMatchObject({
      environmentId: "staging",
      source: "argocd",
      liveCommit: L_STAGING,
      contained: false,
      reasonCode: "not_yet_live",
    });
    expect(envOf(body, "canary-eu")).toMatchObject({
      environmentId: null,
      contained: false,
      reasonCode: "diverged",
    });
    expect(envOf(body, "hotfix-box")).toMatchObject({
      liveCommit: null,
      contained: "unknown",
      reasonCode: "live_commit_unknown",
    });

    // One compare per live commit, authenticated, asking for a single commit per page.
    expect(calls.map((c) => c.head).sort()).toEqual([L_PROD, L_STAGING, L_CANARY].sort());
    for (const c of calls) {
      expect(c.perPage).toBe("1");
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
    }
    // Nothing of the commits' content is passed on.
    expect(JSON.stringify(body)).not.toContain("SECRET COMMIT MESSAGE");
  });

  it("answers identical without calling GitHub when the live commit is the commit", async () => {
    const { body } = await check(L_PROD);
    expect(envOf(body, "Production")).toMatchObject({ contained: true, reasonCode: "same_commit" });
    expect(calls.some((c) => c.head === L_PROD)).toBe(false);
  });

  it("treats GitHub's identical status (abbreviated SHA) as contained", async () => {
    const X = L_STAGING.slice(0, 12);
    answers[`${X}...${L_STAGING}`] = compare("identical");
    answers[`${X}...${L_PROD}`] = compare("ahead", 1);
    const { body } = await check(X);
    // An abbreviated SHA that prefixes the live commit is the same commit.
    expect(envOf(body, "Staging")).toMatchObject({ contained: true, reasonCode: "same_commit" });

    const svc = containmentService(afe.context)!;
    const v = await svc.isContained("default", "acme/web", sha("e"), L_STAGING);
    expect(v).toMatchObject({ contained: "unknown", reasonCode: "commit_not_found" });
    answers[`${sha("f")}...${L_STAGING}`] = compare("identical");
    expect(await svc.isContained("default", "acme/web", sha("f"), L_STAGING)).toMatchObject({
      contained: true,
      reasonCode: "same_commit",
      comparison: { status: "identical" },
    });
  });

  it("reports an unknown commit (404, e.g. force-pushed away) as unknown", async () => {
    const X = sha("b");
    const { status, body } = await check(X);
    expect(status).toBe(200);
    expect(envOf(body, "Production")).toMatchObject({
      contained: "unknown",
      reasonCode: "commit_not_found",
    });
    expect(envOf(body, "Production").reason).toMatch(/force-push/);
  });

  it("caches comparisons in memory and in the table", async () => {
    const X = sha("c");
    answers[`${X}...${L_PROD}`] = compare("ahead", 5);
    answers[`${X}...${L_STAGING}`] = compare("ahead", 6);
    answers[`${X}...${L_CANARY}`] = compare("behind", 0, 1);
    await check(X);
    expect(calls).toHaveLength(3);

    calls = [];
    const again = await check(X);
    expect(calls).toHaveLength(0);
    expect(envOf(again.body, "Production")).toMatchObject({ contained: true, cached: true });

    // After a restart (empty memory) the table answers.
    const svc = containmentService(afe.context)!;
    svc.cache.clearMemory();
    const before = { ...svc.cache.stats };
    const third = await check(X);
    expect(calls).toHaveLength(0);
    expect(svc.cache.stats.tableHits - before.tableHits).toBe(3);
    expect(envOf(third.body, "canary-eu")).toMatchObject({
      contained: false,
      cached: true,
    });
    const { rows } = await pool.query(
      "SELECT tenant_id, repository, status FROM commit_comparisons WHERE base_sha = $1 ORDER BY status",
      [X],
    );
    expect(rows).toEqual([
      { tenant_id: "default", repository: "acme/web", status: "ahead" },
      { tenant_id: "default", repository: "acme/web", status: "ahead" },
      { tenant_id: "default", repository: "acme/web", status: "behind" },
    ]);

    // Errors are never cached.
    expect(
      (await pool.query("SELECT 1 FROM commit_comparisons WHERE base_sha = $1", [sha("b")]))
        .rowCount,
    ).toBe(0);
  });

  it("degrades to unknown when the installation lacks contents: read", async () => {
    const { status, body } = await check(sha("a"), C);
    expect(status).toBe(200);
    expect(envOf(body, "Production")).toMatchObject({
      contained: "unknown",
      reasonCode: "missing_permission",
    });
    expect(envOf(body, "Production").reason).toContain("contents: read");
    // The cached answer of tenant "default" is not visible to another tenant.
    expect(envOf(body, "Production").cached).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports rate limiting as unknown with retryAfter, and stops calling GitHub", async () => {
    const X = sha("d");
    const limited = () =>
      json(429, { message: "You have exceeded a secondary rate limit" }, { "retry-after": "60" });
    answers[`${X}...${L_PROD}`] = limited;
    answers[`${X}...${L_STAGING}`] = limited;
    answers[`${X}...${L_CANARY}`] = limited;
    const svc = new ContainmentService(afe.context, () => githubRuntime(afe.context), {
      concurrency: 1,
      persistCache: false,
    });
    const report = await svc.check("default", "acme/web", X);
    expect(calls).toHaveLength(1);
    expect(report.partial).toBe(true);
    for (const name of ["Production", "Staging", "canary-eu"]) {
      const e = envOf(report, name);
      expect(e).toMatchObject({ contained: "unknown", reasonCode: "rate_limited" });
      expect(Date.parse(e.retryAfter!)).toBeGreaterThan(Date.now());
    }
  });

  it("bounds the work per request and says so", async () => {
    const X = sha("a");
    const svc = new ContainmentService(afe.context, () => githubRuntime(afe.context), {
      maxEnvironments: 2,
      persistCache: false,
    });
    answers[`${X}...${L_CANARY}`] = compare("ahead", 1);
    const report = await svc.check("default", "acme/web", X);
    expect(report.partial).toBe(true);
    expect(report.environments).toHaveLength(4);
    expect(report.environments.slice(2).map((e) => e.reasonCode)).toEqual([
      "not_checked_limit",
      "not_checked_limit",
    ]);
    expect(report.notes.join(" ")).toMatch(/2 more environment/);

    // A compare slower than the budget is reported as a timeout.
    const slow = new ContainmentService(afe.context, () => githubRuntime(afe.context), {
      compareTimeoutMs: 20,
      persistCache: false,
    });
    hanging.add(sha("5"));
    const timed = await slow.check("default", "acme/web", sha("5"));
    expect(envOf(timed, "Production")).toMatchObject({
      contained: "unknown",
      reasonCode: "timeout",
    });
    expect(timed.partial).toBe(true);
  });

  it("validates parameters", async () => {
    for (const q of [
      "",
      "repository=acme/web",
      "commit=" + sha("a"),
      "repository=acme/web&commit=xyz",
      "repository=acme&commit=" + sha("a"),
      "repository=gitlab.com/acme/web&commit=" + sha("a"),
    ]) {
      const res = await get(`/api/containment?${q}`);
      expect(res.statusCode, q).toBe(400);
    }
    // URL and host forms are accepted.
    answers[`${sha("a")}...${L_PROD}`] = compare("ahead", 1);
    const { status } = await check(sha("a"), A, "https://github.com/Acme/Web.git");
    expect(status).toBe(200);
  });

  it("requires authentication and hides other tenants' repositories (404)", async () => {
    const unauth = await afe.app.inject({
      method: "GET",
      url: `/api/containment?repository=acme/web&commit=${sha("a")}`,
    });
    expect(unauth.statusCode).toBe(401);
    expect(afe.routes.find((r) => r.url === "/api/containment")?.access).toBe("viewer");

    const wrong = await check(sha("a"), B);
    expect(wrong.status).toBe(404);
    expect(wrong.body).toEqual({ error: "not_found" });
    expect(calls).toHaveLength(0);
  });

  it("returns an empty list for a connected repository that is not live anywhere", async () => {
    await upsertConnection(pool, "other", {
      source: "github",
      externalId: "4444",
      name: "acme-all",
      status: "active",
      config: {
        ...installationFixture({ permissions: PERMS }),
        account: { id: 1, login: "acme", type: "Organization" },
        installationId: 4444,
        repositories: "all",
      } as never,
    });
    const { status, body } = await check(sha("a"), B, "acme/infra");
    expect(status).toBe(200);
    expect(body.environments).toEqual([]);
    expect(body.notes.join(" ")).toMatch(/not live/);
  });

  it("prunes cache rows unused within the retention window", async () => {
    await pool.query("UPDATE commit_comparisons SET last_used_at = now() - interval '400 days'");
    const job = afe.jobDefinitions.find((j) => j.name === CONTAINMENT_JOBS.PRUNE)!;
    await job.handler({});
    expect((await pool.query("SELECT 1 FROM commit_comparisons")).rowCount).toBe(0);
  });
});
