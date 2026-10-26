import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  getConnectionHealth,
  listAlerts,
  listConnectionsWithHealth,
  openAlert,
  recordSuccessWithoutGap,
  resolveOpenAlerts,
  upsertConnection,
} from "../src/index.ts";
import { createTestPool } from "../src/testing.ts";

describe("connection health repository", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("records successes and keeps tenants apart", async () => {
    const c = await upsertConnection(pool, "default", {
      source: "github",
      externalId: "1",
      name: "acme",
      status: "active",
    });
    const at = new Date("2026-10-26T10:00:00Z");
    expect(await recordSuccessWithoutGap(pool, "other", c.id, at, null)).toBe(false);
    expect(await recordSuccessWithoutGap(pool, "default", c.id, at, null)).toBe(true);
    expect((await getConnectionHealth(pool, "default", c.id))!.health).toMatchObject({
      state: "healthy",
      lastSuccessAt: at,
    });
    expect(await getConnectionHealth(pool, "other", c.id)).toBeNull();
    expect(await listConnectionsWithHealth(pool, "other")).toEqual([]);
    // Older success does not move last_success_at back.
    await recordSuccessWithoutGap(pool, "default", c.id, new Date(+at - 1000), null);
    expect((await getConnectionHealth(pool, "default", c.id))!.health!.lastSuccessAt).toEqual(at);
  });

  it("opens at most one alert per kind and resolves within the tenant only", async () => {
    const c = await upsertConnection(pool, "default", {
      source: "vercel",
      externalId: "t1",
      name: "team",
    });
    const base = {
      connectionId: c.id,
      kind: "connection_blind",
      gapId: "g",
      blindSince: null,
      message: "m",
      openedAt: new Date(),
    };
    expect(
      await openAlert(pool, "default", { ...base, id: "00000000-0000-8000-8000-000000000001" }),
    ).not.toBeNull();
    expect(
      await openAlert(pool, "default", { ...base, id: "00000000-0000-8000-8000-000000000002" }),
    ).toBeNull();
    expect(await resolveOpenAlerts(pool, "other", c.id, new Date())).toEqual([]);
    expect(await listAlerts(pool, "other")).toEqual([]);
    expect(await resolveOpenAlerts(pool, "default", c.id, new Date())).toHaveLength(1);
    expect(await listAlerts(pool, "default", { openOnly: true })).toEqual([]);
  });
});
