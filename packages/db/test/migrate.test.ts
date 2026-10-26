import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { migrate } from "../src/index.ts";
import { createTestPool } from "../src/testing.ts";

describe("migrate", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("creates the default tenant", async () => {
    const { rows } = await pool.query("SELECT id FROM tenants");
    expect(rows).toEqual([{ id: "default" }]);
  });

  it("is idempotent", async () => {
    expect(await migrate(pool)).toEqual([]);
  });
});
