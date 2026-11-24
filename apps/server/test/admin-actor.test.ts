/**
 * AFE-120: Afe's own events must not record the static administrator by its
 * token fingerprint (a hash of the token alone, which lets a reader test
 * guessed tokens offline). They record the stable identity "Administrator",
 * and events recorded before the fix are shown the same way at read time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { tokenFingerprint } from "@afe/core";
import { ingestEvent } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, defaultModules, InlineJobQueue, loadConfig, type AfeApp } from "../src/index.ts";

// Test-only values; never real credentials.
const ADMIN = "a".repeat(40);
const VIEWER = "v".repeat(40);
const adminFingerprint = tokenFingerprint(ADMIN);
const viewerFingerprint = tokenFingerprint(VIEWER);

describe("static administrator actor (AFE-120)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  const jobs = new InlineJobQueue();
  const call = (method: string, url: string, token: string, body?: unknown) =>
    afe.app.inject({
      method: method as "GET",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    pool = await createTestPool();
    afe = await buildAfe({
      pool,
      jobs,
      config: loadConfig({
        DATABASE_URL: "unused",
        AFE_ADMIN_TOKEN: ADMIN,
        AFE_VIEWER_TOKEN: VIEWER,
      }),
      logLevel: "silent",
      connectors: defaultModules,
    });
    jobs.register(afe.jobDefinitions);
  });
  afterAll(async () => {
    await afe.app.close();
    await pool.end();
  });

  it("records new admin changes as Administrator, never the token fingerprint", async () => {
    const created = await call("POST", "/api/mapping/environments", ADMIN, { name: "Production" });
    expect(created.statusCode, created.body).toBe(201);
    const setup = await call("PATCH", "/api/setup", ADMIN, {
      changes: [{ environment: "production", field: "productionLike", value: true }],
    });
    expect(setup.statusCode, setup.body).toBe(200);
    await jobs.drain();

    const stored = await pool.query<{ actor: Record<string, unknown> }>(
      "SELECT actor FROM events WHERE tenant_id='default' AND source='afe'",
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.actor).toMatchObject({ id: "static:admin", name: "Administrator" });
      expect(JSON.stringify(row.actor)).not.toContain(adminFingerprint);
    }
    const overrides = await pool.query(
      "SELECT set_by, set_by_name FROM setup_overrides WHERE tenant_id='default'",
    );
    expect(overrides.rows).toEqual([{ set_by: "static:admin", set_by_name: "Administrator" }]);

    const list = await call("GET", "/api/events?source=afe", VIEWER);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(adminFingerprint);
    expect(list.json().items[0].event.actor).toMatchObject({
      id: "static:admin",
      name: "Administrator",
    });
  });

  it("shows events recorded before the fix as Administrator without changing them", async () => {
    const at = new Date();
    const legacy = async (id: string, actorId: string, source = "afe") => {
      const result = await ingestEvent(pool, "default", {
        source,
        sourceEventId: id,
        action: "config.mapping.changed",
        actor: { type: "token", id: actorId },
        target: { type: "other", id: "mapping", name: "Environment and service mapping" },
        trigger: { type: "manual" },
        outcome: "succeeded",
        occurredAt: at,
        observedAt: at,
        observation: { method: "internal" },
      });
      expect(result.status).toBe("inserted");
      return result.event!.id;
    };
    const admin = await legacy("legacy-admin", `admin-token:${adminFingerprint}`);
    const viewer = await legacy("legacy-viewer", `viewer-token:${viewerFingerprint}`);
    // Another tool's actor is shown exactly as that tool reported it.
    const foreign = await legacy("legacy-foreign", `admin-token:${adminFingerprint}`, "github");

    const detail = await call("GET", `/api/events/${admin}`, VIEWER);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(adminFingerprint);
    expect(detail.json().event.actor).toMatchObject({
      type: "token",
      id: "static:admin",
      name: "Administrator",
    });
    const viewerDetail = (await call("GET", `/api/events/${viewer}`, VIEWER)).json();
    expect(viewerDetail.event.actor).toMatchObject({
      id: "static:viewer",
      name: "Viewer",
    });
    const foreignDetail = (await call("GET", `/api/events/${foreign}`, VIEWER)).json();
    expect(foreignDetail.event.actor.id).toBe(`admin-token:${adminFingerprint}`);

    // Display mapping only: the immutable row keeps what was recorded.
    const raw = await pool.query("SELECT actor FROM events WHERE id=$1", [admin]);
    expect(raw.rows[0].actor.id).toBe(`admin-token:${adminFingerprint}`);
  });
});
