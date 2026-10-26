import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  findConnectionByExternalId,
  getConnection,
  listActiveConnections,
  listConnections,
  resolveConnectionBySourceIdentity,
  setConnectionStatus,
  updateConnectionConfig,
  upsertConnection,
} from "../src/index.ts";
import { createTestPool } from "../src/testing.ts";

describe("connections", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ('other', 'Other')");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("upserts by (tenant, source, externalId) and keeps the id on reconnect", async () => {
    const a = await upsertConnection(pool, "default", {
      source: "github",
      externalId: "123",
      name: "acme",
    });
    expect(a.status).toBe("pending");
    await setConnectionStatus(pool, "default", a.id, "disconnected", "user");
    const b = await upsertConnection(pool, "default", {
      source: "github",
      externalId: "123",
      name: "acme-renamed",
      status: "active",
    });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ name: "acme-renamed", status: "active", statusReason: null });
  });

  it("scopes reads to the tenant", async () => {
    const c = await upsertConnection(pool, "other", {
      source: "vercel",
      externalId: "team_1",
      name: "t",
    });
    expect(await getConnection(pool, "default", c.id)).toBeNull();
    expect(await findConnectionByExternalId(pool, "default", "vercel", "team_1")).toBeNull();
    expect((await getConnection(pool, "other", c.id))?.name).toBe("t");
    expect(await resolveConnectionBySourceIdentity(pool, "vercel", "team_1")).toHaveLength(1);
  });

  it("filters lists and merges config", async () => {
    const c = await upsertConnection(pool, "default", {
      source: "argocd",
      externalId: "https://argo.example",
      name: "argo",
      status: "active",
      config: { insecure: false },
    });
    const updated = await updateConnectionConfig(pool, "default", c.id, { project: "p" });
    expect(updated?.config).toEqual({ insecure: false, project: "p" });
    expect((await listConnections(pool, "default", { source: "argocd" })).map((x) => x.id)).toEqual(
      [c.id],
    );
    const active = await listActiveConnections(pool);
    expect(active.every((x) => x.status === "active")).toBe(true);
    expect(active.map((x) => x.source).sort()).toEqual(["argocd", "github"]);
  });
});
