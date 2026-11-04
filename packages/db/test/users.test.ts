import { afterAll, beforeAll, expect, it } from "vitest";
import type pg from "pg";
import { randomBytes } from "node:crypto";
import { EnvKeyProvider } from "@afe/core/security";
import {
  getCredentialMetadata,
  storeCredential,
  upsertConnection,
  ensureGitHubAdminIdentity,
} from "../src/index.ts";
import { createTestPool, seedLegacyToolPolicy } from "../src/testing.ts";
import {
  authenticateLocalUser,
  createLocalUser,
  deleteLocalUser,
  getLocalUser,
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

it("deletes account records and destroys associated secrets atomically within the tenant", async () => {
  const { user, token } = await createLocalUser(pool, "default", "delete-me");
  const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });
  const credentials = await Promise.all(
    ["user_github_token", "argocd_oidc_state", "transactional_email", "unrelated"].map((kind) =>
      storeCredential(pool, keys, "default", { kind, secret: `private-${kind}` }),
    ),
  );
  const [tool, oidc, email, unrelated] = credentials;
  const connection = await upsertConnection(pool, "default", {
    source: "argocd",
    externalId: "delete-test",
    name: "Argo",
    config: {},
  });
  await setUserToolPolicy(pool, "default", user.id, "github", { mode: "source", custom: [] });
  await pool.query(
    "INSERT INTO user_tool_accounts (tenant_id,user_id,tool,account_name,credential_id) VALUES ('default',$1,'github','alice',$2)",
    [user.id, tool!.id],
  );
  await pool.query(
    "INSERT INTO user_oauth_states (tenant_id,user_id,tool,digest,session_binding,expires_at) VALUES ('default',$1,'github','oauth-state','binding',now()+interval '1 hour')",
    [user.id],
  );
  await pool.query(
    "INSERT INTO user_argocd_oidc_states (tenant_id,digest,user_id,connection_id,session_binding,credential_id,expires_at) VALUES ('default','oidc-state',$1,$2,'binding',$3,now()+interval '1 hour')",
    [user.id, connection.id, oidc!.id],
  );
  const link = await pool.query<{ id: string }>(
    "INSERT INTO user_email_links (tenant_id,id,user_id,token_digest,credential_version,email,purpose,expires_at) VALUES ('default',gen_random_uuid(),$1,'digest',1,'alice@example.com','reset',now()+interval '1 hour') RETURNING id",
    [user.id],
  );
  await pool.query(
    "INSERT INTO email_outbox (tenant_id,id,credential_id,link_id,expires_at) VALUES ('default',gen_random_uuid(),$1,$2,now()+interval '1 hour')",
    [email!.id, link.rows[0]!.id],
  );
  expect(await deleteLocalUser(pool, "other", user.id)).toBe("not_found");
  expect(await authenticateLocalUser(pool, "default", token)).toBeTruthy();

  // An unknown future dependency must roll back all deletions and revocations.
  await pool.query(
    "CREATE TABLE deletion_blocker (tenant_id text, user_id uuid, FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id))",
  );
  await pool.query("INSERT INTO deletion_blocker VALUES ('default',$1)", [user.id]);
  await expect(deleteLocalUser(pool, "default", user.id)).rejects.toThrow();
  expect(await getLocalUser(pool, "default", user.id)).toBeTruthy();
  expect((await getCredentialMetadata(pool, "default", tool!.id))?.revokedAt).toBeNull();
  expect(
    (
      await pool.query("SELECT 1 FROM email_outbox WHERE tenant_id='default' AND link_id=$1", [
        link.rows[0]!.id,
      ])
    ).rowCount,
  ).toBe(1);
  await pool.query("DROP TABLE deletion_blocker");

  expect(await deleteLocalUser(pool, "default", user.id)).toBe("deleted");
  expect(await getLocalUser(pool, "default", user.id)).toBeNull();
  expect(await authenticateLocalUser(pool, "default", token)).toBeNull();
  for (const table of [
    "user_tool_permissions",
    "user_tool_accounts",
    "user_oauth_states",
    "user_argocd_oidc_states",
    "user_email_links",
  ])
    expect(
      (
        await pool.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND user_id=$2`, [
          "default",
          user.id,
        ])
      ).rowCount,
    ).toBe(0);
  expect(
    (
      await pool.query("SELECT 1 FROM email_outbox WHERE tenant_id='default' AND link_id=$1", [
        link.rows[0]!.id,
      ])
    ).rowCount,
  ).toBe(0);
  for (const credential of [tool!, oidc!, email!]) {
    const secret = (
      await pool.query(
        "SELECT revoked_at,key_id,ciphertext,wrapped_key,nonce FROM credentials WHERE tenant_id='default' AND id=$1",
        [credential.id],
      )
    ).rows[0];
    expect(secret.revoked_at).toBeTruthy();
    expect([secret.key_id, secret.ciphertext, secret.wrapped_key, secret.nonce]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  }
  expect((await getCredentialMetadata(pool, "default", unrelated!.id))?.revokedAt).toBeNull();
  expect(await deleteLocalUser(pool, "default", user.id)).toBe("not_found");
  expect((await createLocalUser(pool, "default", "delete-me")).user.id).not.toBe(user.id);
});

it("protects administrator-linked account storage from deletion", async () => {
  const id = await ensureGitHubAdminIdentity(pool, "default", "administrator");
  expect(await deleteLocalUser(pool, "default", id)).toBe("administrator");
  expect(await getLocalUser(pool, "default", id)).toBeTruthy();
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
