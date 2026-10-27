import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool } from "@afe/db/testing";
import { createAfe } from "../src/index.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

describe("GET /healthz", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("reports ok when the database is reachable", async () => {
    const app = await createAfe({ authProvider: trustedTestAuth(), pool, logLevel: "silent" });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
