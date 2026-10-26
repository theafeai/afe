import { describe, expect, it } from "vitest";
import { Secret } from "@afe/core/security";
import {
  ProjectNotSelectedError,
  ScopedVercelReader,
  VercelApiError,
  VercelClient,
  VercelRateLimitError,
  parseSelectionRequest,
} from "../src/index.ts";
import { TEAM, fakeApi } from "./fixtures.ts";

function setup() {
  const api = fakeApi().grant("tok", "usr_alice", [TEAM.id]);
  const client = new VercelClient({
    token: new Secret("tok"),
    fetch: api.fetch,
    sleep: async () => {},
  });
  return { api, client };
}

describe("VercelClient", () => {
  it("reads user, teams and a team with a bearer token", async () => {
    const { api, client } = setup();
    expect((await client.getUser()).id).toBe("usr_alice");
    expect((await client.listTeams()).map((t) => t.id)).toEqual([TEAM.id]);
    expect((await client.getTeam(TEAM.id)).slug).toBe("acme");
    expect(api.requests[0]!.authorization).toBe("Bearer tok");
  });

  it("follows pagination.next as until and strips env values", async () => {
    const { api, client } = setup();
    const projects = await client.listProjects(TEAM.id);
    expect(projects.map((p) => p.id)).toEqual(["prj_web", "prj_api", "prj_secret"]);
    expect(JSON.stringify(projects)).not.toContain("SECRET");
    const projectCalls = api.requests.filter((r) => r.path === "/v9/projects");
    expect(projectCalls).toHaveLength(2);
    expect(projectCalls[0]!.query.teamId).toBe(TEAM.id);
    expect(projectCalls[1]!.query.until).toBe("2000");
  });

  it("passes since/until/projectId for deployments and strips build env", async () => {
    const { api, client } = setup();
    const list = await client.listDeployments({ teamId: TEAM.id, projectId: "prj_web" });
    expect(list.map((d) => d.uid)).toEqual(["dpl_prj_web_2", "dpl_prj_web_1", "dpl_prj_web_0"]);
    const d = await client.getDeployment("dpl_prj_web_1", TEAM.id);
    expect(d.projectId).toBe("prj_web");
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(api.requests.find((r) => r.path === "/v6/deployments")!.query.projectId).toBe("prj_web");
  });

  it("only issues GET requests (R1.4)", async () => {
    const { api, client } = setup();
    await client.getUser();
    await client.listTeams();
    await client.listProjects(TEAM.id);
    await client.listDeployments({ teamId: TEAM.id });
    await client.getDeployment("dpl_prj_api_0", TEAM.id);
    expect(new Set(api.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
  });

  it("reads the token at use time so rotation takes effect", async () => {
    const api = fakeApi().grant("v1", "usr_alice", null).grant("v2", "usr_alice", null);
    let current = "v1";
    const client = new VercelClient({
      token: async () => new Secret(current),
      fetch: api.fetch,
    });
    await client.getUser();
    current = "v2";
    await client.getUser();
    expect(api.requests.map((r) => r.authorization)).toEqual(["Bearer v1", "Bearer v2"]);
  });

  it("maps 401/403 to auth errors without leaking the token", async () => {
    const { api, client } = setup();
    api.revoke("tok");
    const err = await client.getUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VercelApiError);
    expect((err as VercelApiError).isAuthError).toBe(true);
    expect((err as VercelApiError).requestId).toBe("fra1::test");
    expect(String(err)).not.toContain("tok");

    const { client: c2 } = setup();
    const forbidden = await c2.getTeam("team_other").catch((e: unknown) => e);
    expect((forbidden as VercelApiError).status).toBe(403);
  });

  it("retries 429 within bounds and reports rate limits", async () => {
    const { api, client } = setup();
    api.rateLimitNext = 1;
    expect((await client.getUser()).id).toBe("usr_alice");
    api.rateLimitNext = 5;
    const err = await client.getUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VercelRateLimitError);
    expect(client.lastRateLimit?.remaining).toBe(0);
  });

  it("enforces a response size limit", async () => {
    const { api } = setup();
    const client = new VercelClient({
      token: new Secret("tok"),
      fetch: api.fetch,
      maxResponseBytes: 10,
    });
    await expect(client.getUser()).rejects.toThrow(/exceeds/);
  });
});

describe("ScopedVercelReader", () => {
  it("never requests data of unselected projects", async () => {
    const { api, client } = setup();
    const reader = new ScopedVercelReader(client, TEAM.id, {
      mode: "selected",
      projectIds: ["prj_web", "prj_api"],
    });
    expect((await reader.listSelectedProjects()).map((p) => p.id)).toEqual(["prj_web", "prj_api"]);
    const deps = await reader.listAllSelectedDeployments();
    expect(deps.every((d) => d.projectId !== "prj_secret")).toBe(true);
    expect(deps).toHaveLength(6);

    api.requests.length = 0;
    await expect(reader.listDeployments("prj_secret")).rejects.toBeInstanceOf(
      ProjectNotSelectedError,
    );
    await expect(reader.getDeployment("dpl_prj_secret_0", "prj_secret")).rejects.toBeInstanceOf(
      ProjectNotSelectedError,
    );
    expect(api.requests).toHaveLength(0);

    // A lying caller (expected project selected, actual deployment not) gets nothing.
    await expect(reader.getDeployment("dpl_prj_secret_0", "prj_web")).rejects.toBeInstanceOf(
      ProjectNotSelectedError,
    );
  });

  it("reads nothing for an empty selection and everything for 'all'", async () => {
    const { api, client } = setup();
    const none = new ScopedVercelReader(client, TEAM.id, { mode: "none" });
    expect(await none.listAllSelectedDeployments()).toEqual([]);
    expect(await none.listSelectedProjects()).toEqual([]);
    expect(api.requests).toHaveLength(0);
    const all = new ScopedVercelReader(client, TEAM.id, { mode: "all" });
    expect(await all.listAllSelectedDeployments()).toHaveLength(9);
  });

  it("parses selection requests strictly", () => {
    expect(parseSelectionRequest({ projects: "all" })).toEqual({ mode: "all" });
    expect(parseSelectionRequest({ projectIds: [] })).toEqual({ mode: "none" });
    expect(parseSelectionRequest({ projectIds: ["prj_a", "prj_a"] })).toEqual({
      mode: "selected",
      projectIds: ["prj_a"],
    });
    expect(parseSelectionRequest({ projectIds: ["../x"] })).toBeNull();
    expect(parseSelectionRequest({ projects: "some" })).toBeNull();
    expect(parseSelectionRequest({ projects: "all", projectIds: [] })).toBeNull();
  });
});
