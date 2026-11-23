import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { InferredFact } from "@afe/core/setup";
import {
  changeMapping,
  clearSetupOverrides,
  getMappingConfig,
  getSetupVersion,
  listInferredSetup,
  listSetupOverrides,
  replaceInferredSetup,
  setSetupOverride,
} from "../src/index.ts";
import { createTestPool, seedPreInferenceMapping } from "../src/testing.ts";
import { createLocalUser, deleteLocalUser } from "../src/users.ts";

let pool: pg.Pool;
beforeAll(async () => {
  pool = await createTestPool();
  await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
});
afterAll(async () => {
  await pool.end();
});

const fact = (env: string, field: InferredFact["field"], value: unknown): InferredFact =>
  ({
    subject: `environment:${env}`,
    field,
    value,
    confidence: "strong",
    reason: "test",
    evidence: [{ rule: "test", detail: "test" }],
  }) as InferredFact;

/** Runs `fn` in a transaction (as admin API calls do), then commits. */
async function inTx<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const r = await fn(tx);
    await tx.query("COMMIT");
    return r;
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}

const admin = { id: "token:admin", name: "Priya" };

describe("inferred setup store", () => {
  it("replaces a run's facts, keeps first_inferred_at, removes facts no longer produced", async () => {
    const first = new Date("2026-10-01T10:00:00Z");
    await replaceInferredSetup(
      pool,
      "default",
      [fact("staging", "order", 10), fact("prod", "order", 20)],
      first,
    );
    const v1 = await getSetupVersion(pool, "default");
    const second = new Date("2026-10-01T11:00:00Z");
    const r = await replaceInferredSetup(pool, "default", [fact("staging", "order", 15)], second);
    expect(r).toEqual({ written: 1, removed: 1 });
    const rows = await listInferredSetup(pool, "default");
    expect(rows).toEqual([
      expect.objectContaining({
        subject: "environment:staging",
        value: 15,
        computedAt: second.toISOString(),
      }),
    ]);
    expect(rows[0]!.firstInferredAt < second.toISOString()).toBe(true);
    expect(await getSetupVersion(pool, "default")).not.toBe(v1);
    // Tenant-scoped: another tenant has none.
    expect(await listInferredSetup(pool, "other")).toEqual([]);
  });

  it("refuses writes without the inference writer, and the admin writer cannot write it", async () => {
    await expect(
      pool.query("DELETE FROM inferred_setup WHERE tenant_id = 'default'"),
    ).rejects.toThrow(/only the inference writer/);
    await expect(
      inTx(async (tx) => {
        await tx.query("SELECT set_config('afe.setup_writer', 'admin', true)");
        await tx.query("UPDATE inferred_setup SET value = '1' WHERE tenant_id = 'default'");
      }),
    ).rejects.toThrow(/only the inference writer/);
  });
});

describe("setup overrides store", () => {
  it("sets and clears overrides inside an admin transaction, per tenant", async () => {
    const set = await inTx((tx) =>
      setSetupOverride(
        tx,
        "default",
        { subject: "environment:prod", field: "productionLike", value: true },
        admin,
      ),
    );
    expect(set).toMatchObject({ value: true, setBy: admin, keptInferred: null });
    await inTx((tx) =>
      setSetupOverride(
        tx,
        "other",
        { subject: "environment:prod", field: "productionLike", value: false },
        admin,
      ),
    );
    // Clearing in one tenant leaves the other alone.
    expect(
      await inTx((tx) => clearSetupOverrides(tx, "other", "environment:prod", ["productionLike"])),
    ).toHaveLength(1);
    expect((await listSetupOverrides(pool, "default")).map((o) => o.value)).toEqual([true]);
    expect(await listSetupOverrides(pool, "other")).toEqual([]);
  });

  it("refuses writes outside the admin writer: the inference job's write path cannot reach it", async () => {
    await expect(
      pool.query(
        `INSERT INTO setup_overrides (tenant_id, subject, field, value, set_by)
         VALUES ('default', 'environment:x', 'name', '"x"', 'job')`,
      ),
    ).rejects.toThrow(/only the admin writer/);
    await expect(
      inTx(async (tx) => {
        await tx.query("SELECT set_config('afe.setup_writer', 'inference', true)");
        await tx.query("DELETE FROM setup_overrides WHERE tenant_id = 'default'");
      }),
    ).rejects.toThrow(/only the admin writer/);
    // A full inference run leaves overrides exactly as they were.
    const before = await listSetupOverrides(pool, "default");
    await replaceInferredSetup(pool, "default", [fact("prod", "productionLike", false)]);
    expect(await listSetupOverrides(pool, "default")).toEqual(before);
  });

  it("user deletion keeps the override but forgets who set it", async () => {
    const { user } = await createLocalUser(pool, "default", "setter");
    await inTx((tx) =>
      setSetupOverride(
        tx,
        "default",
        { subject: "environment:prod", field: "gating", value: "approval" },
        { id: `local:${user.id}`, name: "setter" },
      ),
    );
    expect(await deleteLocalUser(pool, "default", user.id)).toBe("deleted");
    const row = (await listSetupOverrides(pool, "default")).find((o) => o.field === "gating")!;
    expect(row).toMatchObject({ value: "approval", setBy: { id: "deleted-user", name: null } });
  });
});

describe("no seeded environments (D-0009)", () => {
  it("a tenant's first mapping change seeds nothing and leaves built-in rules off", async () => {
    await pool.query("INSERT INTO tenants (id, name) VALUES ('fresh', 'Fresh')");
    await changeMapping(pool, "fresh", async () => ({
      result: null,
      event: {
        source: "afe",
        sourceEventId: "config_mapping:1",
        action: "config.mapping.changed",
        actor: { type: "unknown" },
        target: { type: "other", id: "mapping" },
        trigger: { type: "manual" },
        outcome: "succeeded",
        occurredAt: new Date(),
        observedAt: new Date(),
        observation: { method: "internal" },
      },
    }));
    const config = await getMappingConfig(pool, "fresh");
    expect(config).toMatchObject({
      customised: true,
      environments: [],
      builtinDefaultEnabled: false,
    });
  });

  it("an upgraded tenant keeps its rows and built-in rules", async () => {
    await seedPreInferenceMapping(pool, "other");
    const config = await getMappingConfig(pool, "other");
    expect(config.environments.map((e) => e.id)).toEqual([
      "production",
      "staging",
      "preview",
      "development",
    ]);
    expect(config.builtinDefaultEnabled).toBe(true);
  });
});
