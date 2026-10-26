import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { DecryptionError, EnvKeyProvider, Secret, UnknownKeyError } from "@afe/core/security";
import {
  createDbReplayGuard,
  getCredential,
  getCredentialMetadata,
  listCredentials,
  pruneWebhookDeliveries,
  recordDelivery,
  reencryptAll,
  reencryptAllTenants,
  revokeCredential,
  rotateCredential,
  storeCredential,
  tenantsWithCredentialsNotUnderKey,
} from "../src/index.ts";
import { createTestPool } from "../src/testing.ts";

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const keys = new EnvKeyProvider({ keys: { k1 } });
const T = "default";
const OTHER = "tenant-b";

describe("credentials repository", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'B')", [OTHER]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("stores only ciphertext and decrypts for the owning tenant", async () => {
    const meta = await storeCredential(pool, keys, T, {
      kind: "argocd_token",
      secret: new Secret("argocd-token-value"),
    });
    expect(meta).toMatchObject({ tenantId: T, kind: "argocd_token", keyId: "k1", revokedAt: null });
    expect(JSON.stringify(meta)).not.toContain("argocd-token-value");

    const { rows } = await pool.query("SELECT * FROM credentials WHERE id = $1", [meta.id]);
    const raw = JSON.stringify(rows[0]) + Buffer.concat([rows[0].ciphertext]).toString("latin1");
    expect(raw).not.toContain("argocd-token-value");

    const got = await getCredential(pool, keys, T, meta.id);
    expect(got?.secret.reveal()).toBe("argocd-token-value");
    expect(JSON.stringify(got)).not.toContain("argocd-token-value");
  });

  it("is scoped per tenant", async () => {
    const meta = await storeCredential(pool, keys, T, { kind: "vercel_token", secret: "v" });
    expect(await getCredential(pool, keys, OTHER, meta.id)).toBeNull();
    expect(await getCredentialMetadata(pool, OTHER, meta.id)).toBeNull();
    expect(await revokeCredential(pool, OTHER, meta.id)).toBe(false);
    expect(await rotateCredential(pool, keys, OTHER, meta.id, "x")).toBeNull();
    expect((await listCredentials(pool, OTHER)).map((c) => c.id)).not.toContain(meta.id);
    expect((await getCredential(pool, keys, T, meta.id))?.secret.reveal()).toBe("v");
  });

  it("detects ciphertext moved to another tenant or id in the database", async () => {
    const a = await storeCredential(pool, keys, T, { kind: "vercel_token", secret: "a" });
    const b = await storeCredential(pool, keys, OTHER, { kind: "vercel_token", secret: "b" });
    // An attacker with DB write access copies tenant A's ciphertext into tenant B's row.
    await pool.query(
      `UPDATE credentials dst
          SET key_id = src.key_id, wrapped_key = src.wrapped_key,
              nonce = src.nonce, ciphertext = src.ciphertext
         FROM credentials src
        WHERE src.tenant_id = $1 AND src.id = $2 AND dst.tenant_id = $3 AND dst.id = $4`,
      [T, a.id, OTHER, b.id],
    );
    await expect(getCredential(pool, keys, OTHER, b.id)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("detects tampered ciphertext", async () => {
    const c = await storeCredential(pool, keys, T, { kind: "argocd_token", secret: "t" });
    await pool.query(
      `UPDATE credentials SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)
        WHERE tenant_id = $1 AND id = $2`,
      [T, c.id],
    );
    await expect(getCredential(pool, keys, T, c.id)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rotates a credential value in place", async () => {
    const c = await storeCredential(pool, keys, T, { kind: "vercel_token", secret: "old" });
    const rotated = await rotateCredential(pool, keys, T, c.id, "new");
    expect(rotated?.rotatedAt).toBeInstanceOf(Date);
    expect((await getCredential(pool, keys, T, c.id))?.secret.reveal()).toBe("new");
  });

  it("revokes by destroying key material and keeps metadata", async () => {
    const c = await storeCredential(pool, keys, T, { kind: "vercel_token", secret: "gone" });
    expect(await revokeCredential(pool, T, c.id)).toBe(true);
    expect(await revokeCredential(pool, T, c.id)).toBe(false);
    expect(await getCredential(pool, keys, T, c.id)).toBeNull();
    expect(await rotateCredential(pool, keys, T, c.id, "again")).toBeNull();
    const meta = await getCredentialMetadata(pool, T, c.id);
    expect(meta?.revokedAt).toBeInstanceOf(Date);
    expect(meta?.keyId).toBeNull();
    const { rows } = await pool.query(
      "SELECT ciphertext, nonce, wrapped_key FROM credentials WHERE id = $1",
      [c.id],
    );
    expect(rows[0]).toEqual({ ciphertext: null, nonce: null, wrapped_key: null });
    expect((await listCredentials(pool, T)).map((x) => x.id)).not.toContain(c.id);
    expect((await listCredentials(pool, T, { includeRevoked: true })).map((x) => x.id)).toContain(
      c.id,
    );
  });

  it("rejects rows that would hold neither or partial key material", async () => {
    await expect(
      pool.query(
        "INSERT INTO credentials (tenant_id, id, kind) VALUES ('default', gen_random_uuid(), 'x')",
      ),
    ).rejects.toThrow(/credentials_material_iff_active/);
  });

  it("re-encrypts all credentials of a tenant under a new key", async () => {
    const t = "tenant-rot";
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'rot')", [t]);
    const before = new EnvKeyProvider({ keys: { k1 } });
    const ids = [];
    for (const v of ["one", "two", "three"]) {
      ids.push((await storeCredential(pool, before, t, { kind: "argocd_token", secret: v })).id);
    }
    const revoked = await storeCredential(pool, before, t, { kind: "argocd_token", secret: "r" });
    await revokeCredential(pool, t, revoked.id);

    const both = new EnvKeyProvider({ keys: { k1, k2 }, activeKeyId: "k2" });
    expect(await tenantsWithCredentialsNotUnderKey(pool, "k2")).toContain(t);
    expect(await reencryptAll(pool, both, t, "k2")).toBe(3);
    expect(await reencryptAll(pool, both, t, "k2")).toBe(0); // idempotent
    expect(await tenantsWithCredentialsNotUnderKey(pool, "k2")).not.toContain(t);

    const after = new EnvKeyProvider({ keys: { k2 } });
    const values = [];
    for (const id of ids) {
      const c = await getCredential(pool, after, t, id);
      expect(c?.keyId).toBe("k2");
      expect(c?.rotatedAt).toBeNull();
      values.push(c?.secret.reveal());
    }
    expect(values).toEqual(["one", "two", "three"]);
    // The old key alone can no longer read them.
    await expect(getCredential(pool, before, t, ids[0]!)).rejects.toBeInstanceOf(UnknownKeyError);
    await expect(reencryptAll(pool, before, t, "k9")).rejects.toThrow(/does not hold/);
  });

  it("re-encrypts across all tenants for operator key rotation", async () => {
    const both = new EnvKeyProvider({ keys: { k1, k2 }, activeKeyId: "k2" });
    // A deliberately corrupted credential stops rotation instead of being skipped.
    await expect(reencryptAllTenants(pool, both)).rejects.toBeInstanceOf(DecryptionError);
    // Remove the rows corrupted by the tampering tests above.
    await pool.query("DELETE FROM credentials WHERE tenant_id IN ($1, $2)", [T, OTHER]);
    await storeCredential(pool, keys, T, { kind: "argocd_token", secret: "x" });
    await storeCredential(pool, keys, OTHER, { kind: "argocd_token", secret: "y" });
    const counts = await reencryptAllTenants(pool, both);
    expect(Object.keys(counts).sort()).toEqual([T, OTHER].sort());
    expect(await tenantsWithCredentialsNotUnderKey(pool, "k2")).toEqual([]);
    expect(await reencryptAllTenants(pool, both)).toEqual({});
  });
});

describe("webhook delivery replay protection", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("returns false on replay, per source", async () => {
    expect(await recordDelivery(pool, null, "github", "d-1")).toBe(true);
    expect(await recordDelivery(pool, null, "github", "d-1")).toBe(false);
    expect(await recordDelivery(pool, T, "github", "d-1")).toBe(false);
    expect(await recordDelivery(pool, T, "vercel", "d-1")).toBe(true);
  });

  it("is atomic under concurrent duplicates", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => recordDelivery(pool, T, "github", "race")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("works as a ReplayGuard and can be pruned", async () => {
    const guard = createDbReplayGuard(pool);
    const old = new Date(Date.now() - 40 * 86_400_000);
    expect(
      await guard.recordDelivery({
        tenantId: T,
        source: "vercel",
        deliveryId: "e",
        receivedAt: old,
      }),
    ).toBe(true);
    expect(await guard.recordDelivery({ tenantId: T, source: "vercel", deliveryId: "e" })).toBe(
      false,
    );
    expect(await pruneWebhookDeliveries(pool, new Date(Date.now() - 30 * 86_400_000))).toBe(1);
    expect(await guard.recordDelivery({ tenantId: T, source: "vercel", deliveryId: "e" })).toBe(
      true,
    );
  });

  it("rejects an unknown tenant", async () => {
    await expect(recordDelivery(pool, "nope", "github", "x")).rejects.toThrow();
  });
});
