import { afterAll, beforeAll, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool, seedLegacyToolPolicy } from "../src/testing.ts";
import {
  authenticateLocalUser,
  createLocalUser,
  getUserToolPolicy,
  listLocalUsers,
  resetLocalCredential,
  setLocalUserDisabled,
  setUserToolPolicy,
} from "../src/users.ts";

let pool: pg.Pool;
beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool?.end();
});

it("stores only a hash, isolates tenants, rotates and disables credentials", async () => {
  await pool.query("INSERT INTO tenants (id,name) VALUES ('other','Other')");
  const issued = await createLocalUser(pool, "default", "Alice");
  expect(issued.user.username).toBe("alice");
  expect(await authenticateLocalUser(pool, "default", issued.token)).toEqual(issued.user);
  expect(await authenticateLocalUser(pool, "other", issued.token)).toBeNull();
  expect(await listLocalUsers(pool, "other")).toEqual([]);
  const stored = await pool.query(
    "SELECT credential_digest FROM users WHERE tenant_id=$1 AND id=$2",
    ["default", issued.user.id],
  );
  expect(stored.rows[0].credential_digest).not.toContain(issued.token.split(".")[3]);
  expect(await resetLocalCredential(pool, "other", issued.user.id)).toBeNull();
  const rotated = await resetLocalCredential(pool, "default", issued.user.id);
  expect(await authenticateLocalUser(pool, "default", issued.token)).toBeNull();
  expect((await authenticateLocalUser(pool, "default", rotated!))?.credentialVersion).toBe(2);
  await setLocalUserDisabled(pool, "default", issued.user.id, true);
  expect(await authenticateLocalUser(pool, "default", rotated!)).toBeNull();
});

it("defaults to none and isolates per-tool grants by tenant", async () => {
  const { user } = await createLocalUser(pool, "default", "bob");
  const policy = {
    mode: "source" as const,
    custom: [],
  };
  expect(await getUserToolPolicy(pool, "default", user.id, "github")).toEqual({
    mode: "none",
    custom: [],
  });
  await setUserToolPolicy(pool, "default", user.id, "github", policy);
  expect(await getUserToolPolicy(pool, "default", user.id, "github")).toEqual(policy);
  expect(await getUserToolPolicy(pool, "other", user.id, "github")).toEqual({
    mode: "none",
    custom: [],
  });
  expect(await getUserToolPolicy(pool, "default", user.id, "vercel")).toEqual({
    mode: "none",
    custom: [],
  });
  await expect(setUserToolPolicy(pool, "other", user.id, "github", policy)).rejects.toThrow();
});

it("rejects new custom grants and preserves legacy policies until explicit tenant-scoped review", async () => {
  const { user } = await createLocalUser(pool, "default", "legacy");
  const denied = [{ resource: "repository:acme/app", action: "github.delete_run" }];
  for (const mode of ["custom", "source + custom"] as const) {
    const legacy = { mode, custom: [{ resource: "repository:acme/app", action: "read" }], denied };
    await seedLegacyToolPolicy(pool, "default", user.id, "github", legacy);
    for (const policy of [
      legacy,
      { mode, custom: [] },
      { mode: "source" as const, custom: legacy.custom },
    ])
      await expect(setUserToolPolicy(pool, "default", user.id, "github", policy)).rejects.toThrow(
        "invalid tool policy",
      );
    expect(await getUserToolPolicy(pool, "default", user.id, "github")).toEqual(legacy);
    await expect(
      setUserToolPolicy(pool, "other", user.id, "github", { mode: "source", custom: [] }),
    ).rejects.toThrow();
    expect(await getUserToolPolicy(pool, "default", user.id, "github")).toEqual(legacy);
    await setUserToolPolicy(pool, "default", user.id, "github", { mode: "none", custom: [] });
    expect(await getUserToolPolicy(pool, "default", user.id, "github")).toEqual({
      mode: "none",
      custom: [],
      denied,
    });
    await setUserToolPolicy(pool, "default", user.id, "github", { mode: "source", custom: [] });
    expect(await getUserToolPolicy(pool, "default", user.id, "github")).toEqual({
      mode: "source",
      custom: [],
      denied,
    });
  }
});
