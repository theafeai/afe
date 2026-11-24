import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool, seedLegacyToolPolicy } from "@afe/db/testing";
import { createLocalUser } from "@afe/db";
import { EnvKeyProvider } from "@afe/core/security";
import { buildAfe, type AfeApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { argocdActionsModule } from "../src/actions/argocd.ts";
import { githubActionsModule } from "../src/actions/github.ts";
import { terraformActionsModule } from "../src/actions/terraform.ts";
import { vercelActionsModule } from "../src/actions/vercel.ts";
import { namedUserRequired, serveToolLinkErrors, toolNotLinked } from "../src/actions/tool-link.ts";

// AFE-118: "link your account first" is an expected state (ADR 0020), so its 403 says why.
describe("serveToolLinkErrors", () => {
  async function app() {
    const a = Fastify({ logger: false });
    serveToolLinkErrors(a, "/api/actions/x");
    a.get("/api/actions/x/unlinked", async () => {
      throw toolNotLinked("vercel", "Link your personal Vercel account in Profile.");
    });
    a.get("/api/actions/x/shared", async () => {
      throw namedUserRequired("terraform", "Sign in as a named Afe user.");
    });
    a.get("/api/actions/x/denied", async () => {
      throw Object.assign(new Error("Vercel source access is disabled for this user."), {
        statusCode: 403,
      });
    });
    a.get("/api/other", async () => {
      throw toolNotLinked("github", "outside the prefix");
    });
    return a;
  }

  it("adds reason and tool to tool-not-linked 403s", async () => {
    const a = await app();
    const res = await a.inject({ url: "/api/actions/x/unlinked" });
    expect(res.statusCode).toBe(403);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      statusCode: 403,
      error: "forbidden",
      reason: "tool_not_linked",
      tool: "vercel",
      message: "Link your personal Vercel account in Profile.",
    });
    expect((await a.inject({ url: "/api/actions/x/shared" })).json()).toMatchObject({
      reason: "named_user_required",
      tool: "terraform",
    });
    await a.close();
  });

  it("leaves real permission errors and other routes unchanged", async () => {
    const a = await app();
    const denied = await a.inject({ url: "/api/actions/x/denied" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      statusCode: 403,
      error: "Forbidden",
      message: "Vercel source access is disabled for this user.",
    });
    const other = await a.inject({ url: "/api/other" });
    expect(other.statusCode).toBe(403);
    expect(other.json().reason).toBeUndefined();
    await a.close();
  });
});

describe("tool pages for people without a linked account", () => {
  const admin = "a".repeat(40);
  let pool: pg.Pool, afe: AfeApp;
  let alice: Awaited<ReturnType<typeof createLocalUser>>;
  let bob: Awaited<ReturnType<typeof createLocalUser>>;
  const tools = ["vercel", "terraform", "github", "argocd"] as const;
  const url = {
    vercel: "/api/actions/vercel/resources",
    terraform: "/api/actions/terraform/resources",
    github: "/api/actions/github/resources",
    argocd: "/api/actions/argocd/applications",
  };
  const get = (tool: (typeof tools)[number], token: string) =>
    afe.app.inject({ url: url[tool], headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    pool = await createTestPool();
    afe = await buildAfe({
      pool,
      keys: new EnvKeyProvider({ keys: { k1: randomBytes(32) } }),
      logLevel: "silent",
      config: loadConfig({ DATABASE_URL: "unused", AFE_ADMIN_TOKEN: admin }),
      connectors: [
        vercelActionsModule,
        terraformActionsModule,
        githubActionsModule,
        argocdActionsModule,
      ],
    });
    alice = await createLocalUser(pool, "default", "alice");
    bob = await createLocalUser(pool, "default", "bob");
    for (const tool of tools) {
      await seedLegacyToolPolicy(pool, "default", alice.user.id, tool, {
        mode: "source",
        custom: [],
      });
      await seedLegacyToolPolicy(pool, "default", bob.user.id, tool, {
        mode: "none",
        custom: [],
      });
    }
  });
  afterAll(async () => {
    await afe?.app.close();
    await pool?.end();
  });

  it.each(tools)(
    "%s: a named user with access but no linked account gets tool_not_linked",
    async (tool) => {
      const res = await get(tool, alice.token);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "forbidden", reason: "tool_not_linked", tool });
    },
  );

  it.each(["vercel", "terraform", "argocd"] as const)(
    "%s: the shared administrator password needs a named user",
    async (tool) => {
      const res = await get(tool, admin);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ reason: "named_user_required", tool });
    },
  );

  it("github: the administrator password can link GitHub in Profile", async () => {
    const res = await get("github", admin);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "tool_not_linked", tool: "github" });
  });

  it.each(tools)("%s: disabled Source access stays a plain permission error", async (tool) => {
    const res = await get(tool, bob.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBeUndefined();
  });
});
