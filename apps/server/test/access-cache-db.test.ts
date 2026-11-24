/**
 * Identity, access cache and sign-in data functions against Postgres
 * (wrong-tenant cases, R5.10), and cache invalidation and revocation through the
 * API. Needs Postgres at TEST_DATABASE_URL. No real GitHub API is called.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { EnvKeyProvider } from "@afe/core/security";
import {
  bindExternalIdentity,
  createLocalUser,
  deleteExternalIdentity,
  getExternalIdentityBySubject,
  getExternalIdentityForUser,
  getGitHubSignInSettings,
  getUserSourceAccess,
  ingestEvent,
  purgeUserSourceAccessBefore,
  putGitHubSignInSettings,
  putUserSourceAccess,
  setUserToolPolicy,
} from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, loadConfig, type AfeApp } from "../src/index.ts";
import { eventsApiModule } from "../src/api/events.ts";
import { ACCESS_CACHE_TTL_MS } from "../src/auth/access-cache.ts";

const ADMIN = "a".repeat(40);
const admin = { authorization: `Bearer ${ADMIN}` };
let pool: pg.Pool, afe: AfeApp, now: number;
let repos: unknown, ghUser: { id: number; login: string };
let user: Awaited<ReturnType<typeof createLocalUser>>;
const rule = [{ source: "github", resource: "repository:acme/allowed" }];

beforeEach(async () => {
  pool = await createTestPool();
  await pool.query("INSERT INTO tenants(id,name) VALUES ('other','Other')");
  now = Date.now();
  repos = [{ full_name: "acme/allowed" }];
  ghUser = { id: 7, login: "alice" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(input);
      if (u.pathname === "/user") return Response.json(ghUser);
      if (u.pathname === "/user/repos")
        return repos === "revoked"
          ? Response.json({ message: "Bad credentials" }, { status: 401 })
          : Response.json(repos);
      throw new Error(`unexpected external call ${u.pathname}`);
    }),
  );
  afe = await buildAfe({
    pool,
    logLevel: "silent",
    clock: () => now,
    config: loadConfig({ DATABASE_URL: "unused", AFE_ADMIN_TOKEN: ADMIN }),
    keys: new EnvKeyProvider({ keys: { k1: randomBytes(32) } }),
    connectors: [eventsApiModule],
  });
  user = await createLocalUser(pool, "default", "alice");
  await setUserToolPolicy(pool, "default", user.user.id, "github", { mode: "source", custom: [] });
  for (const repository of ["acme/allowed", "acme/hidden"])
    await ingestEvent(pool, "default", {
      source: "github",
      sourceEventId: repository,
      action: "deployment.created",
      actor: { type: "user", login: "alice" },
      target: { type: "repository", id: repository, repository },
      trigger: { type: "manual" },
      outcome: "succeeded",
      occurredAt: new Date(now),
      observedAt: new Date(now),
      observation: { method: "webhook" },
      correlation: {},
      data: {},
    });
});
afterEach(async () => {
  await afe.app.close();
  await pool.end();
  vi.unstubAllGlobals();
});

const as = { authorization: () => `Bearer ${user.token}` };
const visible = async () =>
  (await afe.app.inject({ url: "/api/events", headers: { authorization: as.authorization() } }))
    .json()
    .items.map((i: { event: { target: { repository: string } } }) => i.event.target.repository);
async function link() {
  const r = await afe.app.inject({
    method: "POST",
    url: "/api/profile/tools/github/token",
    headers: { authorization: as.authorization() },
    payload: { token: "github_pat_fixture-token" },
  });
  expect(r.statusCode, r.body).toBe(200);
}
const cachedRows = async () =>
  (
    await pool.query("SELECT 1 FROM user_source_access WHERE tenant_id='default' AND user_id=$1", [
      user.user.id,
    ])
  ).rowCount;
async function credentialId() {
  return (
    await pool.query<{ credential_id: string }>(
      "SELECT credential_id FROM user_tool_accounts WHERE tenant_id='default' AND user_id=$1",
      [user.user.id],
    )
  ).rows[0]!.credential_id;
}

describe("data functions are tenant scoped (R5.10)", () => {
  it("identities", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      expect(
        await bindExternalIdentity(db, "default", user.user.id, {
          provider: "github",
          subject: "7",
          login: "alice",
        }),
      ).toBe("bound");
      await db.query("COMMIT");
    } finally {
      db.release();
    }
    expect(await getExternalIdentityBySubject(pool, "other", "github", "7")).toBeNull();
    expect(await getExternalIdentityForUser(pool, "other", user.user.id, "github")).toBeNull();
    await deleteExternalIdentity(pool, "other", user.user.id, "github");
    expect(await getExternalIdentityBySubject(pool, "default", "github", "7")).not.toBeNull();
  });

  it("the same GitHub id binds to one user per tenant, and independently per tenant", async () => {
    const bob = await createLocalUser(pool, "default", "bob");
    const outsider = await createLocalUser(pool, "other", "outsider");
    const bind = async (tenant: string, uid: string) => {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        const r = await bindExternalIdentity(db, tenant, uid, {
          provider: "github",
          subject: "7",
          login: "a",
        });
        await db.query("COMMIT");
        return r;
      } finally {
        db.release();
      }
    };
    expect(await bind("default", user.user.id)).toBe("bound");
    expect(await bind("default", bob.user.id)).toBe("conflict");
    expect(await bind("other", outsider.user.id)).toBe("bound");
  });

  it("source access rows", async () => {
    await link();
    const cred = await credentialId();
    expect(
      await putUserSourceAccess(pool, "other", user.user.id, "github", cred, rule, new Date()),
    ).toBe(false);
    expect(
      await putUserSourceAccess(pool, "default", user.user.id, "github", cred, rule, new Date()),
    ).toBe(true);
    expect(await getUserSourceAccess(pool, "other", user.user.id, "github", cred)).toBeNull();
    expect(await purgeUserSourceAccessBefore(pool, "other", new Date(now + 3600_000))).toBe(0);
    expect(await getUserSourceAccess(pool, "default", user.user.id, "github", cred)).not.toBeNull();
  });

  it("source access is only stored for a current credential, an enabled user and Source mode", async () => {
    await link();
    const cred = await credentialId();
    expect(
      await putUserSourceAccess(
        pool,
        "default",
        user.user.id,
        "github",
        "33333333-3333-4333-8333-333333333333",
        rule,
        new Date(),
      ),
    ).toBe(false);
    await setUserToolPolicy(pool, "default", user.user.id, "github", { mode: "none", custom: [] });
    expect(
      await putUserSourceAccess(pool, "default", user.user.id, "github", cred, rule, new Date()),
    ).toBe(false);
  });

  it("sign-in settings", async () => {
    await putGitHubSignInSettings(pool, "default", {
      enabled: true,
      autoProvision: false,
      allowedOrgs: [],
      defaultRole: "viewer",
    });
    expect((await getGitHubSignInSettings(pool, "other")).enabled).toBe(false);
    await expect(
      putGitHubSignInSettings(pool, "default", {
        enabled: true,
        autoProvision: false,
        allowedOrgs: [],
        defaultRole: "admin" as "viewer",
      }),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE github_sign_in SET default_role='admin' WHERE tenant_id='default'"),
    ).rejects.toThrow();
  });
});

describe("access cache through the API", () => {
  it("revocation: visible within the TTL for reads, denied after it; failed refresh deletes the row", async () => {
    await link();
    expect(await visible()).toEqual(["acme/allowed"]);
    expect(await cachedRows()).toBe(1);
    repos = "revoked";
    expect(await visible()).toEqual(["acme/allowed"]);
    now += ACCESS_CACHE_TTL_MS;
    expect(await visible()).toEqual([]);
    expect(await cachedRows()).toBe(0);
  });

  it.each([
    [
      "unlink",
      async () => {
        await afe.app.inject({
          method: "DELETE",
          url: "/api/profile/tools/github",
          headers: { authorization: as.authorization() },
        });
      },
    ],
    ["relink", async () => link()],
    [
      "policy change",
      async () => {
        await afe.app.inject({
          method: "PUT",
          url: `/api/admin/users/${user.user.id}/permissions/github`,
          headers: admin,
          payload: {
            mode: "source",
            custom: [],
            denied: [{ resource: "repository:acme/allowed", action: "github.rerun" }],
          },
        });
      },
    ],
    [
      "disable",
      async () => {
        await afe.app.inject({
          method: "PATCH",
          url: `/api/admin/users/${user.user.id}`,
          headers: admin,
          payload: { disabled: true },
        });
      },
    ],
  ])("%s drops the cached row before the request returns", async (_name, change) => {
    await link();
    expect(await visible()).toEqual(["acme/allowed"]);
    expect(await cachedRows()).toBe(1);
    await change();
    expect(await cachedRows()).toBe(0);
  });

  it("user deletion removes cached access and the identity", async () => {
    await link();
    await visible();
    expect(
      await getExternalIdentityForUser(pool, "default", user.user.id, "github"),
    ).not.toBeNull();
    const r = await afe.app.inject({
      method: "DELETE",
      url: `/api/admin/users/${user.user.id}`,
      headers: admin,
    });
    expect(r.statusCode).toBe(200);
    expect(await cachedRows()).toBe(0);
    expect((await pool.query("SELECT 1 FROM user_external_identities")).rowCount).toBe(0);
  });

  it("backfills the numeric id of links made before migration 0039 on the next refresh", async () => {
    await link();
    await pool.query("DELETE FROM user_external_identities");
    await pool.query("DELETE FROM user_source_access");
    await visible();
    expect(await getExternalIdentityForUser(pool, "default", user.user.id, "github")).toMatchObject(
      {
        subject: "7",
        login: "alice",
        provisioned: false,
      },
    );
  });
});
