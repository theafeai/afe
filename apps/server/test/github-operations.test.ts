import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type pg from "pg";
import { createTestPool, seedLegacyToolPolicy } from "@afe/db/testing";
import { createLocalUser, upsertConnection, storeCredential, revokeCredential } from "@afe/db";
import { type GitHubOperation } from "@afe/core";
import { EnvKeyProvider } from "@afe/core/security";
import { buildAfe, type AfeApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { githubActionsModule } from "../src/actions/github.ts";
vi.mock("../src/connectors/github-log-download.ts", async (original) => {
  const actual = await original<typeof GitHubLogDownload>();
  return {
    ...actual,
    downloadGitHubJobLog: vi.fn(
      async () => "2026-11-01T00:00:00Z Build output <script>inert</script>",
    ),
  };
});
import type * as GitHubLogDownload from "../src/connectors/github-log-download.ts";
import { downloadGitHubJobLog } from "../src/connectors/github-log-download.ts";
const admin = "a".repeat(40),
  sha = "a".repeat(40);
const yaml =
  "name: Deploy\non:\n  workflow_dispatch:\n    inputs:\n      deploy:\n        type: boolean\n        required: true\n      size:\n        type: number\n        default: 1\n      region:\n        type: choice\n        options: [east, west]\n        default: east\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n";
let pool: pg.Pool,
  afe: AfeApp,
  user: Awaited<ReturnType<typeof createLocalUser>>,
  connectionId: string;
let status: string,
  conclusion: string,
  attempt: number,
  write: boolean,
  sourceAdmin: boolean,
  reviewer: boolean,
  jobRun: number,
  workflowState: string,
  fileSha: string,
  failure: number | "network" | null,
  mutations: { path: string; method: string; body: unknown }[],
  currentAction: GitHubOperation;
const headers = () => ({ authorization: `Bearer ${user.token}` });
const root = "/api/actions/github/repositories/acme/app";
const q = (view: string, extra: Record<string, string> = {}) =>
  `${root}?${new URLSearchParams({ connectionId, view, ...extra })}`;
const run = () => ({
  id: 123,
  run_attempt: attempt,
  status,
  conclusion,
  event: currentAction === "github.approve_run" ? "pull_request" : "workflow_dispatch",
  repository: { full_name: "acme/app" },
  updated_at: "2026-10-28T00:00:00Z",
});
const environment = () => ({
  id: 9,
  name: "production",
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [],
});
beforeEach(async () => {
  pool = await createTestPool();
  status = "completed";
  conclusion = "failure";
  attempt = 1;
  write = true;
  sourceAdmin = true;
  reviewer = true;
  jobRun = 123;
  workflowState = "active";
  fileSha = sha;
  failure = null;
  mutations = [];
  vi.mocked(downloadGitHubJobLog).mockClear();
  currentAction = "github.rerun";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url),
      path = u.pathname,
      method = init.method ?? "GET";
    if (method !== "GET") {
      mutations.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (failure === "network") throw new Error("private-upstream-secret");
      return new Response(
        failure ? '{"message":"private-upstream-secret"}' : JSON.stringify({ id: 555, sha }),
        { status: failure ?? 201 },
      );
    }
    if (path === "/user") return Response.json({ id: 1, login: "alice" });
    if (path === "/user/repos")
      return Response.json([
        { id: 1, full_name: "acme/app" },
        { id: 2, full_name: "acme/hidden" },
      ]);
    if (path === "/repos/acme/app")
      return Response.json({
        id: 1,
        default_branch: "trunk",
        permissions: { push: write, admin: sourceAdmin },
      });
    if (path === "/repos/acme/app/actions/runs/123/attempts/1") return Response.json(run());
    if (path === "/repos/acme/app/actions/jobs/234/logs")
      return failure
        ? Response.json({ message: "private-upstream-secret" }, { status: Number(failure) })
        : new Response(null, {
            status: 302,
            headers: {
              location: "https://results.blob.core.windows.net/log?sig=private-signed-secret",
            },
          });
    if (path === "/repos/acme/app/actions/runs/123") return Response.json(run());
    if (path === "/repos/acme/app/actions/jobs/234")
      return Response.json({
        id: 234,
        run_id: jobRun,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        steps: [],
      });
    if (path === "/repos/acme/app/actions/runs/123/pending_deployments")
      return Response.json([
        { environment: { id: 9, name: "production" }, current_user_can_approve: reviewer },
      ]);
    if (path === "/repos/acme/app/actions/workflows/42")
      return Response.json({
        id: 42,
        path: ".github/workflows/deploy.yml",
        state: workflowState,
        updated_at: "today",
      });
    if (path === "/repos/acme/app/contents/.github/workflows/deploy.yml")
      return Response.json({
        type: "file",
        encoding: "base64",
        size: yaml.length,
        sha: fileSha,
        content: Buffer.from(yaml).toString("base64"),
      });
    if (path === "/repos/acme/app/commits/main") return Response.json({ sha });
    if (path === "/repos/acme/app/deployments/77")
      return Response.json({ id: 77, sha, environment: "production" });
    if (path === "/repos/acme/app/deployments/77/statuses")
      return Response.json([{ id: 3, state: "inactive" }]);
    if (path === "/repos/acme/app/actions/artifacts/88")
      return Response.json({ id: 88, expired: false, created_at: "today" });
    if (path === "/repos/acme/app/environments/production") return Response.json(environment());
    if (path === "/repos/acme/app/environments/production/deployment-branch-policies/91")
      return Response.json({ id: 91, name: "main", type: "branch" });
    if (path === "/repos/acme/app/environments/production/deployment-branch-policies")
      return Response.json({ branch_policies: [{ id: 91, name: "main", type: "branch" }] });
    if (path === "/repos/acme/app/environments/production/deployment_protection_rules")
      return Response.json({
        custom_deployment_protection_rules: [{ id: 94, app: { id: 95, slug: "policy-check" } }],
      });
    if (path === "/repos/acme/app/environments/production/deployment_protection_rules/apps")
      return Response.json({
        available_custom_deployment_protection_rule_integrations: [
          { id: 96, slug: "another-policy" },
        ],
      });
    if (path === "/repos/acme/app/actions/caches")
      return Response.json({
        actions_caches: [{ id: 92, key: "build", ref: "main", created_at: "today" }],
      });
    if (path === "/repos/acme/app/actions/workflows")
      return Response.json({ workflows: [{ id: 42, name: "Deploy", state: workflowState }] });
    if (path === "/repos/acme/app/actions/runs") return Response.json({ workflow_runs: [run()] });
    if (path === "/repos/acme/app/actions/runs/123/attempts/1/jobs")
      return Response.json({
        jobs: [
          {
            id: 234,
            name: "deploy",
            run_id: 123,
            run_attempt: 1,
            status: "completed",
            steps: [{ number: 1, name: "Build", status: "completed" }],
          },
        ],
      });
    if (path === "/repos/acme/app/deployments")
      return Response.json([{ id: 77, ref: "main", payload: { secret: "private-payload" } }]);
    if (path === "/repos/acme/app/environments")
      return Response.json({ environments: [environment()] });
    if (path === "/repos/acme/app/actions/artifacts")
      return Response.json({ artifacts: [{ id: 88, name: "build", expired: false }] });
    if (path === "/repos/acme/app/collaborators")
      return Response.json([{ id: 3, login: "reviewer" }]);
    if (path === "/repos/acme/app/teams") return Response.json([{ id: 4, name: "Release" }]);
    throw new Error(`Unexpected fixture request ${path}`);
  });
  const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });
  afe = await buildAfe({
    pool,
    keys,
    logLevel: "silent",
    config: loadConfig({ DATABASE_URL: "unused", AFE_ADMIN_TOKEN: admin }),
    connectors: [githubActionsModule],
  });
  user = await createLocalUser(pool, "default", "alice");
  connectionId = (
    await upsertConnection(pool, "default", {
      source: "github",
      externalId: "9",
      name: "acme",
      status: "active",
      config: { repositories: [{ id: 1, fullName: "acme/app" }] },
    })
  ).id;
  await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
    mode: "source",
    custom: [],
  });
  const credential = await storeCredential(pool, keys, "default", {
    kind: "user_github_token",
    secret: "fine-grained-test-token",
  });
  await pool.query(
    "INSERT INTO user_tool_accounts (tenant_id,user_id,tool,account_name,credential_id,context) VALUES ('default',$1,'github','alice',$2,'{}')",
    [user.user.id, credential.id],
  );
});
afterEach(async () => {
  await afe?.app.close();
  await pool?.end();
  vi.unstubAllGlobals();
});
async function prepare(action: GitHubOperation, params: Record<string, unknown>) {
  currentAction = action;
  return afe.app.inject({
    method: "POST",
    url: root + "/prepare",
    headers: headers(),
    payload: { connectionId, action, params },
  });
}
async function execute(
  action: GitHubOperation,
  params: Record<string, unknown>,
  version: string,
  requestId = randomUUID(),
) {
  return afe.app.inject({
    method: "POST",
    url: root,
    headers: headers(),
    payload: { connectionId, action, params, expectedVersion: version, requestId, confirmed: true },
  });
}
const cases: [
  GitHubOperation,
  Record<string, unknown>,
  string,
  string,
  Record<string, unknown> | undefined,
][] = [
  [
    "github.dispatch",
    { workflowId: 42, ref: "main", inputs: { deploy: false } },
    "POST",
    "/actions/workflows/42/dispatches",
    { ref: "main", inputs: { deploy: false, size: 1, region: "east" } },
  ],
  ["github.enable", { workflowId: 42 }, "PUT", "/actions/workflows/42/enable", undefined],
  ["github.disable", { workflowId: 42 }, "PUT", "/actions/workflows/42/disable", undefined],
  ["github.cancel", { runId: 123, attempt: 1 }, "POST", "/actions/runs/123/cancel", undefined],
  [
    "github.force_cancel",
    { runId: 123, attempt: 1 },
    "POST",
    "/actions/runs/123/force-cancel",
    undefined,
  ],
  [
    "github.rerun",
    { runId: 123, attempt: 1, enableDebugLogging: true },
    "POST",
    "/actions/runs/123/rerun",
    { enable_debug_logging: true },
  ],
  [
    "github.rerun_failed",
    { runId: 123, attempt: 1 },
    "POST",
    "/actions/runs/123/rerun-failed-jobs",
    { enable_debug_logging: false },
  ],
  [
    "github.rerun_job",
    { runId: 123, attempt: 1, jobId: 234, enableDebugLogging: true },
    "POST",
    "/actions/jobs/234/rerun",
    { enable_debug_logging: true },
  ],
  [
    "github.approve_run",
    { runId: 123, attempt: 1 },
    "POST",
    "/actions/runs/123/approve",
    undefined,
  ],
  [
    "github.review_deployment",
    { runId: 123, attempt: 1, environmentIds: [9], state: "rejected", comment: "Hold" },
    "POST",
    "/actions/runs/123/pending_deployments",
    { environment_ids: [9], state: "rejected", comment: "Hold" },
  ],
  ["github.delete_run", { runId: 123, attempt: 1 }, "DELETE", "/actions/runs/123", undefined],
  ["github.delete_logs", { runId: 123, attempt: 1 }, "DELETE", "/actions/runs/123/logs", undefined],
  [
    "github.deployment_create",
    { ref: "main" },
    "POST",
    "/deployments",
    {
      ref: "main",
      environment: "production",
      task: "deploy",
      description: "",
      auto_merge: false,
      transient_environment: false,
    },
  ],
  [
    "github.deployment_status",
    { deploymentId: 77, state: "success" },
    "POST",
    "/deployments/77/statuses",
    { state: "success", description: "", auto_inactive: false },
  ],
  ["github.deployment_delete", { deploymentId: 77 }, "DELETE", "/deployments/77", undefined],
  ["github.artifact_delete", { artifactId: 88 }, "DELETE", "/actions/artifacts/88", undefined],
  [
    "github.environment_save",
    {
      environment: "production",
      waitTimer: 5,
      preventSelfReview: true,
      reviewers: [{ type: "User", id: 3 }],
      branchPolicy: null,
    },
    "PUT",
    "/environments/production",
    {
      wait_timer: 5,
      prevent_self_review: true,
      reviewers: [{ type: "User", id: 3 }],
      deployment_branch_policy: null,
    },
  ],
  [
    "github.environment_delete",
    { environment: "production" },
    "DELETE",
    "/environments/production",
    undefined,
  ],
  [
    "github.branch_policy_save",
    { environment: "production", name: "release/*", type: "branch" },
    "POST",
    "/environments/production/deployment-branch-policies",
    { name: "release/*", type: "branch" },
  ],
  [
    "github.branch_policy_delete",
    { environment: "production", policyId: 91 },
    "DELETE",
    "/environments/production/deployment-branch-policies/91",
    undefined,
  ],
  [
    "github.protection_rule_enable",
    { environment: "production", appId: 96 },
    "POST",
    "/environments/production/deployment_protection_rules",
    { integration_id: 96 },
  ],
  [
    "github.protection_rule_delete",
    { environment: "production", ruleId: 94 },
    "DELETE",
    "/environments/production/deployment_protection_rules/94",
    undefined,
  ],
  [
    "github.branch_policy_save",
    { environment: "production", name: "release/*", type: "branch", policyId: 91 },
    "PUT",
    "/environments/production/deployment-branch-policies/91",
    { name: "release/*" },
  ],
  ["github.cache_delete", { cacheId: 92 }, "DELETE", "/actions/caches/92", undefined],
];
it.each(cases)(
  "prepares and executes %s with the exact provider contract",
  async (action, params, method, path, body) => {
    if (action === "github.enable") workflowState = "disabled_manually";
    if (["github.cancel", "github.force_cancel"].includes(action)) status = "in_progress";
    if (action === "github.approve_run") {
      status = "waiting";
      conclusion = "action_required";
    }
    const p = await prepare(action, params);
    expect(p.statusCode, p.body).toBe(200);
    const result = await execute(action, params, p.json().version);
    expect(result.statusCode, result.body).toBe(202);
    expect(mutations).toEqual([{ path: "/repos/acme/app" + path, method, body }]);
    expect(
      (
        await pool.query(
          "SELECT state,actor_id,input_digest FROM github_action_requests WHERE tenant_id=$1",
          ["default"],
        )
      ).rows[0],
    ).toMatchObject({
      state: "accepted",
      actor_id: `local:${user.user.id}`,
      input_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  },
);
it("validates dispatch types, choices, unknown fields and required inputs before any mutation", async () => {
  for (const inputs of [
    { deploy: "false" },
    { deploy: false, region: "north" },
    { deploy: false, extra: "value" },
    {},
    { deploy: false, size: "2" },
  ])
    expect(
      (await prepare("github.dispatch", { workflowId: 42, ref: "main", inputs })).statusCode,
    ).toBe(400);
  expect(mutations).toHaveLength(0);
});
it("never treats repository write access or an Afe grant as source reviewer eligibility", async () => {
  reviewer = false;
  expect(
    (
      await prepare("github.review_deployment", {
        runId: 123,
        attempt: 1,
        environmentIds: [9],
        state: "approved",
        comment: "Ship",
      })
    ).statusCode,
  ).toBe(403);
  sourceAdmin = false;
  expect(
    (await prepare("github.environment_delete", { environment: "production" })).statusCode,
  ).toBe(403);
  write = false;
  expect((await prepare("github.rerun", { runId: 123, attempt: 1 })).statusCode).toBe(403);
  expect(mutations).toHaveLength(0);
});
it("binds job IDs to the selected run and keeps attempts separate", async () => {
  jobRun = 999;
  expect(
    (await prepare("github.rerun_job", { runId: 123, attempt: 1, jobId: 234 })).statusCode,
  ).toBe(409);
  jobRun = 123;
  attempt = 2;
  expect((await prepare("github.rerun", { runId: 123, attempt: 1 })).statusCode).toBe(409);
  expect(mutations).toHaveLength(0);
});
it("rejects changed source state between preparation and execution", async () => {
  const params = { runId: 123, attempt: 1 };
  const p = await prepare("github.rerun", params);
  conclusion = "cancelled";
  expect((await execute("github.rerun", params, p.json().version)).statusCode).toBe(409);
  expect(mutations).toHaveLength(0);
});
it("removes workflow definition mutations from capabilities and rejects direct API calls", async () => {
  const caps = await afe.app.inject({ url: q("capabilities"), headers: headers() });
  expect(caps.statusCode).toBe(200);
  const actions = caps.json().items.map((c: { action: string }) => c.action);
  for (const action of ["github.workflow_save", "github.workflow_delete"]) {
    expect(actions).not.toContain(action);
    for (const suffix of ["/prepare", ""]) {
      const response = await afe.app.inject({
        method: "POST",
        url: root + suffix,
        headers: headers(),
        payload: {
          connectionId,
          action,
          params: {
            path: ".github/workflows/deploy.yml",
            branch: "main",
            sha,
            message: "Edit",
            content: yaml,
          },
          confirmed: true,
          requestId: randomUUID(),
          expectedVersion: "a".repeat(64),
        },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().message).toMatch(/Unknown.*operation/i);
    }
  }
  expect(mutations).toHaveLength(0);
  expect((await pool.query("SELECT * FROM github_action_requests")).rows).toHaveLength(0);
});
it("preserves read-only workflow definitions and dispatch input discovery", async () => {
  const file = await afe.app.inject({
    url: q("workflow_file", { id: "42", ref: "main" }),
    headers: headers(),
  });
  expect(file.statusCode, file.body).toBe(200);
  expect(file.json()).toMatchObject({
    path: ".github/workflows/deploy.yml",
    sha,
    content: yaml,
    dispatchable: true,
  });
  expect(file.json().inputs.map((i: { name: string }) => i.name)).toEqual([
    "deploy",
    "size",
    "region",
  ]);
  await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
    mode: "source",
    custom: [],
    denied: [{ resource: "repository:acme/app", action: "github.dispatch" }],
  });
  expect(
    (
      await afe.app.inject({
        url: q("workflow_file", { id: "42", ref: "main" }),
        headers: headers(),
      })
    ).statusCode,
  ).toBe(403);
  expect(mutations).toHaveLength(0);
});
it("keeps personal repositories outside the installation selection hidden", async () => {
  const list = await afe.app.inject({ url: "/api/actions/github/resources", headers: headers() });
  expect(list.json().items).toEqual([
    { connectionId, connectionName: "acme", repository: "acme/app" },
  ]);
  const hidden = await afe.app.inject({
    url:
      root.replace("/app", "/hidden") + "?" + new URLSearchParams({ connectionId, view: "runs" }),
    headers: headers(),
  });
  expect(hidden.statusCode).toBe(404);
});
it("does not expose deployment payloads, and exposes per-attempt steps and reviewer choices", async () => {
  const deployments = await afe.app.inject({ url: q("deployments"), headers: headers() });
  expect(deployments.body).not.toContain("private-payload");
  const jobs = await afe.app.inject({
    url: q("jobs", { runId: "123", attempt: "1" }),
    headers: headers(),
  });
  expect(jobs.json().items[0].steps[0].name).toBe("Build");
  const options = await afe.app.inject({ url: q("reviewers"), headers: headers() });
  expect(options.json().items).toEqual([
    { id: 3, name: "reviewer", type: "User" },
    { id: 4, name: "Release", type: "Team" },
  ]);
});
it("revalidates permissions on replay and compares all inputs when reusing an ID", async () => {
  const params = { runId: 123, attempt: 1 };
  const p = await prepare("github.rerun", params),
    requestId = randomUUID();
  expect((await execute("github.rerun", params, p.json().version, requestId)).statusCode).toBe(202);
  expect(
    (
      await execute(
        "github.rerun",
        { ...params, enableDebugLogging: true },
        p.json().version,
        requestId,
      )
    ).statusCode,
  ).toBe(409);
  expect((await execute("github.rerun", params, p.json().version, requestId)).json().state).toBe(
    "accepted",
  );
  await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
    mode: "source + custom",
    custom: [],
  });
  expect((await execute("github.rerun", params, p.json().version, requestId)).statusCode).toBe(403);
  expect(mutations).toHaveLength(1);
});
it("deduplicates concurrent re-runs across both the old event UI and new workspace", async () => {
  const params = { runId: 123, attempt: 1 };
  const p = await prepare("github.rerun", params);
  const responses = await Promise.all([
    execute("github.rerun", params, p.json().version),
    execute(
      "github.rerun_failed",
      params,
      (await prepare("github.rerun_failed", params)).json().version,
    ),
  ]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([202, 409]);
  expect(mutations).toHaveLength(1);
});
it("records uncertainty without retrying and requires explicit duplicate-risk acknowledgement for recovery", async () => {
  const params = { runId: 123, attempt: 1 },
    p = await prepare("github.rerun", params),
    requestId = randomUUID();
  failure = "network";
  const result = await execute("github.rerun", params, p.json().version, requestId);
  expect(result.statusCode).toBe(502);
  expect(result.json().state).toBe("unknown");
  expect(result.body).not.toContain("private-upstream-secret");
  expect((await execute("github.rerun", params, p.json().version, requestId)).json().state).toBe(
    "unknown",
  );
  expect(mutations).toHaveLength(1);
  const release = root + `/requests/${requestId}/release`;
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: release,
        headers: headers(),
        payload: { connectionId, confirmed: true },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: release,
        headers: headers(),
        payload: { connectionId, confirmed: true, acknowledgeDuplicateRisk: true },
      })
    ).json().state,
  ).toBe("released");
  failure = null;
  expect((await execute("github.rerun", params, p.json().version)).statusCode).toBe(202);
});
it("allows a new intent after explicit rejection but preserves the original receipt", async () => {
  const params = { workflowId: 42, ref: "main", inputs: { deploy: false } },
    p = await prepare("github.dispatch", params),
    requestId = randomUUID();
  failure = 403;
  expect((await execute("github.dispatch", params, p.json().version, requestId)).json().state).toBe(
    "rejected",
  );
  failure = null;
  expect((await execute("github.dispatch", params, p.json().version)).statusCode).toBe(202);
  expect((await execute("github.dispatch", params, p.json().version, requestId)).json().state).toBe(
    "rejected",
  );
  expect(mutations).toHaveLength(2);
});
it("blocks legacy custom-only account linking and operations", async () => {
  await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
    mode: "custom",
    custom: [{ resource: "repository:acme/app", action: "read" }],
  });
  const response = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/github/token",
    headers: headers(),
    payload: { token: "new-fine-grained-test-token" },
  });
  expect(response.statusCode).toBe(403);
  expect(response.body).not.toContain("new-fine-grained");
  expect((await afe.app.inject({ url: q("runs"), headers: headers() })).statusCode).toBe(403);
  expect((await prepare("github.rerun", { runId: 123, attempt: 1 })).statusCode).toBe(403);
});
it("lets a linked administrator inherit operations and rejects custom policy updates", async () => {
  const adminHeaders = { authorization: `Bearer ${admin}` };
  expect(
    (
      await afe.app.inject({
        method: "POST",
        url: "/api/profile/tools/github/token",
        headers: adminHeaders,
        payload: { token: "admin-personal-test-token", userId: user.user.id },
      })
    ).statusCode,
  ).toBe(200);
  const resources = await afe.app.inject({
    url: "/api/actions/github/resources",
    headers: adminHeaders,
  });
  expect(resources.statusCode).toBe(200);
  expect(resources.json().items[0].repository).toBe("acme/app");
  const body = { connectionId, action: "github.rerun", params: { runId: 123, attempt: 1 } };
  const prepareAdmin = () =>
    afe.app.inject({
      method: "POST",
      url: root + "/prepare",
      headers: adminHeaders,
      payload: body,
    });
  expect((await prepareAdmin()).statusCode).toBe(200);
  expect(mutations).toEqual([]);
  const uid = (await pool.query<{ user_id: string }>("SELECT user_id FROM github_admin_identities"))
    .rows[0]!.user_id;
  expect(uid).not.toBe(user.user.id);
  expect(
    (
      await afe.app.inject({
        method: "PUT",
        url: `/api/admin/users/${uid}/permissions/github`,
        headers: adminHeaders,
        payload: {
          mode: "source + custom",
          custom: [{ resource: "repository:acme/app", action: "github.rerun" }],
        },
      })
    ).statusCode,
  ).toBe(400);
  const prepared = await prepareAdmin();
  expect(prepared.statusCode).toBe(200);
  const executed = await afe.app.inject({
    method: "POST",
    url: root,
    headers: adminHeaders,
    payload: {
      ...body,
      expectedVersion: prepared.json().version,
      requestId: randomUUID(),
      confirmed: true,
    },
  });
  expect(executed.statusCode).toBe(202);
  expect(mutations).toHaveLength(1);
  await afe.app.inject({
    method: "DELETE",
    url: "/api/profile/tools/github",
    headers: adminHeaders,
  });
  expect((await prepareAdmin()).statusCode).toBe(403);
});
it("enforces tenant isolation for browsing, execution and history", async () => {
  await pool.query("INSERT INTO tenants (id,name) VALUES ('other','Other')");
  const other = await createLocalUser(pool, "other", "bob");
  for (const url of [q("history"), q("runs"), "/api/actions/github/resources"]) {
    const result = await afe.app.inject({
      url,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect([403, 404]).toContain(result.statusCode);
    expect(result.body).not.toContain("acme/app");
  }
  expect((await afe.app.inject({ url: q("runs") })).statusCode).toBe(401);
});
it("shares the attempt lock with the original event control endpoint", async () => {
  const { ingestEvent } = await import("@afe/db");
  const event = await ingestEvent(pool, "default", {
    source: "github",
    sourceEventId: "run-compat",
    connectionId,
    action: "workflow_run.completed",
    actor: { type: "user", login: "alice" },
    target: { type: "workflow_run", id: "acme/app/actions/runs/123", repository: "acme/app" },
    trigger: { type: "manual" },
    outcome: "failed",
    occurredAt: new Date(),
    observedAt: new Date(),
    observation: { method: "webhook" },
    correlation: { runIds: ["github:123"] },
    data: {},
  });
  const params = { runId: 123, attempt: 1 },
    p = await prepare("github.rerun", params);
  expect((await execute("github.rerun", params, p.json().version)).statusCode).toBe(202);
  const old = await afe.app.inject({
    method: "POST",
    url: `/api/actions/github/events/${event.event!.id}`,
    headers: headers(),
    payload: {
      action: "github.rerun_failed",
      expectedAttempt: 1,
      requestId: randomUUID(),
      confirmed: true,
    },
  });
  expect(old.statusCode).toBe(409);
  expect(mutations).toHaveLength(1);
});
it("uses an explicit hosted identity mapping while keeping tenant account lookup scoped", async () => {
  const keys = afe.context.keys;
  await afe.app.close();
  let tenant = "default";
  const seen: string[] = [];
  afe = await buildAfe({
    pool,
    keys,
    logLevel: "silent",
    authProvider: {
      authenticate: () => ({
        id: "hosted:alice",
        tenantId: tenant,
        roles: ["viewer"],
        kind: "sso",
      }),
    },
    githubUserId: async (tid, p) => {
      seen.push(`${tid}:${p.id}`);
      return user.user.id;
    },
    connectors: [githubActionsModule],
  });
  expect((await afe.app.inject({ url: q("runs") })).statusCode).toBe(200);
  expect(seen).toContain("default:hosted:alice");
  await pool.query("UPDATE users SET disabled=true WHERE tenant_id=$1 AND id=$2", [
    "default",
    user.user.id,
  ]);
  expect((await afe.app.inject({ url: q("runs") })).statusCode).toBe(403);
  await pool.query("UPDATE users SET disabled=false WHERE tenant_id=$1 AND id=$2", [
    "default",
    user.user.id,
  ]);
  tenant = "other";
  expect((await afe.app.inject({ url: q("runs") })).statusCode).toBe(403);
});
it("never requests OAuth workflow scope, including legacy consent payloads", async () => {
  vi.stubEnv("AFE_USER_GITHUB_CLIENT_ID", "test-client");
  vi.stubEnv("AFE_USER_GITHUB_CLIENT_SECRET", "test-secret");
  const keys = afe.context.keys;
  await afe.app.close();
  afe = await buildAfe({
    pool,
    keys,
    logLevel: "silent",
    config: loadConfig({
      DATABASE_URL: "unused",
      AFE_ADMIN_TOKEN: admin,
      AFE_PUBLIC_URL: "https://afe.example",
    }),
    connectors: [githubActionsModule],
  });
  const login = await afe.app.inject({
    method: "POST",
    url: "/api/session",
    payload: { token: user.token },
  });
  const cookie = (login.headers["set-cookie"] as string[]).map((s) => s.split(";")[0]).join("; "),
    csrf = login.json().csrfToken;
  for (const workflowAccess of [false, true]) {
    const response = await afe.app.inject({
      method: "POST",
      url: "/api/profile/tools/github/login",
      headers: { cookie, "x-afe-csrf": csrf },
      payload: { workflowAccess },
    });
    expect(response.statusCode, response.body).toBe(200);
    const scopes = new URL(response.json().url).searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual(["repo", "read:user"]);
  }
  vi.unstubAllEnvs();
});

it("publishes machine-readable input contracts alongside state-aware capabilities", async () => {
  const result = await afe.app.inject({
    url: q("capabilities", { runId: "123" }),
    headers: headers(),
  });
  expect(result.statusCode, result.body).toBe(200);
  const dispatch = result
    .json()
    .items.find((x: { action: string }) => x.action === "github.dispatch");
  expect(dispatch.paramsSchema.required).toContain("workflowId");
  expect(dispatch.paramsSchema.additionalProperties).toBe(false);
  expect(dispatch.method).toBe("POST");
  expect(
    result.json().items.find((x: { action: string }) => x.action === "github.artifact_download")
      .method,
  ).toBe("GET");
  expect(
    result.json().items.find((x: { action: string }) => x.action === "github.cancel").enabled,
  ).toBe(false);
});

it("does not mistake a deployment-review receipt for a prior re-run in the legacy panel", async () => {
  const { ingestEvent } = await import("@afe/db");
  const e = await ingestEvent(pool, "default", {
    source: "github",
    sourceEventId: "review-compat",
    connectionId,
    action: "workflow_run.completed",
    actor: { type: "user", login: "alice" },
    target: { type: "workflow_run", id: "acme/app/actions/runs/123", repository: "acme/app" },
    trigger: { type: "manual" },
    outcome: "failed",
    occurredAt: new Date(),
    observedAt: new Date(),
    observation: { method: "webhook" },
    correlation: { runIds: ["github:123"] },
    data: {},
  });
  const params = {
      runId: 123,
      attempt: 1,
      environmentIds: [9],
      state: "approved",
      comment: "Ship",
    },
    p = await prepare("github.review_deployment", params);
  expect((await execute("github.review_deployment", params, p.json().version)).statusCode).toBe(
    202,
  );
  const controls = await afe.app.inject({
    url: `/api/actions/github/events/${e.event!.id}`,
    headers: headers(),
  });
  expect(
    controls.json().capabilities.find((c: { action: string }) => c.action === "github.rerun")
      .enabled,
  ).toBe(true);
});

it("rejects a branch policy type change because the source only permits name-pattern updates", async () => {
  expect(
    (
      await prepare("github.branch_policy_save", {
        environment: "production",
        policyId: 91,
        name: "release/*",
        type: "tag",
      })
    ).statusCode,
  ).toBe(409);
  expect(mutations).toHaveLength(0);
});

it.each(["success", "failure"])(
  "views completed %s job logs using the linked PAT without an App",
  async (result) => {
    conclusion = result;
    const res = await afe.app.inject({
      url: q("job_log", { runId: "123", attempt: "1", jobId: "234" }),
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({
      jobId: 234,
      attempt: 1,
      text: expect.stringContaining("Build output"),
    });
    expect(res.body).not.toMatch(
      /fine-grained-test-token|private-signed-secret|blob.core.windows.net/,
    );
    expect(downloadGitHubJobLog).toHaveBeenCalledTimes(1);
    expect(mutations).toHaveLength(0);
  },
);
it("pins logs to the selected run and attempt before requesting storage", async () => {
  jobRun = 999;
  const res = await afe.app.inject({
    url: q("job_log", { runId: "123", attempt: "1", jobId: "234" }),
    headers: headers(),
  });
  expect(res.statusCode).toBe(404);
  expect(downloadGitHubJobLog).not.toHaveBeenCalled();
  jobRun = 123;
  attempt = 2;
  expect(
    (
      await afe.app.inject({
        url: q("job_log", { runId: "123", attempt: "1", jobId: "234" }),
        headers: headers(),
      })
    ).statusCode,
  ).toBe(404);
  expect(downloadGitHubJobLog).not.toHaveBeenCalled();
});
it.each([403, 404, 410])("reports log availability/permission status %s safely", async (code) => {
  failure = code;
  const res = await afe.app.inject({
    url: q("job_log", { runId: "123", attempt: "1", jobId: "234" }),
    headers: headers(),
  });
  expect(res.statusCode).toBe(code);
  expect(res.body).not.toContain("private-upstream-secret");
  expect(downloadGitHubJobLog).not.toHaveBeenCalled();
});
it("reports pending logs and enforces exact log grants", async () => {
  const url = q("job_log", { runId: "123", attempt: "1", jobId: "234" });
  status = "in_progress";
  expect((await afe.app.inject({ url, headers: headers() })).statusCode).toBe(409);
  await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
    mode: "source + custom",
    custom: [],
  });
  expect((await afe.app.inject({ url, headers: headers() })).statusCode).toBe(403);
  expect(downloadGitHubJobLog).not.toHaveBeenCalled();
});

it("inherits all Afe action gates in Source mode and still applies provider roles", async () => {
  await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
    mode: "source",
    custom: [],
  });
  const caps = await afe.app.inject({ url: q("capabilities"), headers: headers() });
  expect(caps.statusCode).toBe(200);
  expect(caps.json().items.every((c: { enabled: boolean }) => c.enabled)).toBe(true);
  expect((await prepare("github.rerun", { runId: 123, attempt: 1 })).statusCode).toBe(200);
  expect(
    (
      await afe.app.inject({
        url: q("job_log", { runId: "123", attempt: "1", jobId: "234" }),
        headers: headers(),
      })
    ).statusCode,
  ).toBe(200);
  write = false;
  sourceAdmin = false;
  const restricted = (await afe.app.inject({ url: q("capabilities"), headers: headers() })).json()
    .items;
  expect(
    restricted.find((c: { action: string }) => c.action === "github.logs_download").enabled,
  ).toBe(true);
  expect(restricted.find((c: { action: string }) => c.action === "github.rerun").reason).toContain(
    "GitHub repository write",
  );
  expect(
    restricted.find((c: { action: string }) => c.action === "github.environment_save").reason,
  ).toContain("GitHub repository admin");
  expect((await prepare("github.rerun", { runId: 123, attempt: 1 })).statusCode).toBe(403);
  expect(
    (
      await afe.app.inject({
        url: q("workflow_file", { id: "42", ref: "main" }),
        headers: headers(),
      })
    ).statusCode,
  ).toBe(403);
});
it("applies admin restrictions over Source access and rechecks them on replay", async () => {
  const params = { runId: 123, attempt: 1 };
  await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
    mode: "source",
    custom: [],
  });
  const p = await prepare("github.rerun", params),
    requestId = randomUUID();
  expect((await execute("github.rerun", params, p.json().version, requestId)).statusCode).toBe(202);
  const target = `/api/admin/users/${user.user.id}/permissions/github`;
  const denied = [{ resource: "repository:acme/app", action: "github.rerun" }];
  expect(
    (
      await afe.app.inject({
        method: "PUT",
        url: target,
        headers: { authorization: `Bearer ${admin}` },
        payload: { mode: "source", custom: [], denied },
      })
    ).statusCode,
  ).toBe(200);
  expect((await execute("github.rerun", params, p.json().version, requestId)).statusCode).toBe(403);
  // Older clients that omit the new field must not erase administrator restrictions.
  expect(
    (
      await afe.app.inject({
        method: "PUT",
        url: target,
        headers: { authorization: `Bearer ${admin}` },
        payload: { mode: "source", custom: [] },
      })
    ).statusCode,
  ).toBe(200);
  const caps = (await afe.app.inject({ url: q("capabilities"), headers: headers() })).json().items;
  expect(caps.find((c: { action: string }) => c.action === "github.rerun").reason).toContain(
    "Afe policy restricts",
  );
  expect(caps.find((c: { action: string }) => c.action === "github.logs_download").enabled).toBe(
    true,
  );
  expect(mutations).toHaveLength(1);
  expect(
    (
      await afe.app.inject({
        method: "PUT",
        url: target,
        headers: { authorization: `Bearer ${admin}` },
        payload: { mode: "source", custom: [], denied: [] },
      })
    ).statusCode,
  ).toBe(200);
  expect((await execute("github.rerun", params, p.json().version, requestId)).json().state).toBe(
    "accepted",
  );
  expect(mutations).toHaveLength(1);
});
it.each(["github.*", "read", "github.unknown"])(
  "rejects invalid action restriction %s",
  async (action) => {
    expect(
      (
        await afe.app.inject({
          method: "PUT",
          url: `/api/admin/users/${user.user.id}/permissions/github`,
          headers: { authorization: `Bearer ${admin}` },
          payload: {
            mode: "source",
            custom: [],
            denied: [{ resource: "repository:acme/app", action }],
          },
        })
      ).statusCode,
    ).toBe(400);
  },
);

it.each(["ghp_classic_fixture", "github_pat_fine_grained_fixture"])(
  "inherits Source operations with a linked %s",
  async (token) => {
    await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
      mode: "source",
      custom: [],
    });
    expect(
      (
        await afe.app.inject({
          method: "POST",
          url: "/api/profile/tools/github/token",
          headers: headers(),
          payload: { token },
        })
      ).statusCode,
    ).toBe(200);
    expect((await prepare("github.rerun", { runId: 123, attempt: 1 })).statusCode).toBe(200);
  },
);
it("denies Source operations after credential revocation", async () => {
  await seedLegacyToolPolicy(pool, "default", user.user.id, "github", {
    mode: "source",
    custom: [],
  });
  const id = (
    await pool.query<{ credential_id: string }>(
      "SELECT credential_id FROM user_tool_accounts WHERE tenant_id='default' AND user_id=$1 AND tool='github'",
      [user.user.id],
    )
  ).rows[0]!.credential_id;
  await revokeCredential(pool, "default", id);
  expect((await prepare("github.rerun", { runId: 123, attempt: 1 })).statusCode).toBe(403);
  expect(mutations).toHaveLength(0);
});

it("returns the source repository default branch within the authorized repository scope", async () => {
  const response = await afe.app.inject({
    method: "GET",
    url: q("repository"),
    headers: headers(),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ defaultBranch: "trunk" });
});
