import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool } from "@afe/db/testing";
import { EnvKeyProvider } from "@afe/core/security";
import {
  buildAfe,
  createEventsApiModule,
  InlineJobQueue,
  loadConfig,
  type AfeApp,
} from "../src/index.ts";
import { createTerraformModule } from "../src/connectors/terraform.ts";
import { createHealthModule } from "../src/health/module.ts";

let pool: pg.Pool;
let afe: AfeApp;
beforeAll(async () => {
  pool = await createTestPool();
  afe = await buildAfe({
    pool,
    keys: new EnvKeyProvider({ keys: { default: randomBytes(32) } }),
    jobs: new InlineJobQueue(),
    config: loadConfig({ DATABASE_URL: "unused" }),
    logLevel: "silent",
    authProvider: {
      authenticate: () => ({
        id: "admin-1",
        name: "Administrator",
        roles: ["admin"],
        tenantId: "default",
        kind: "session",
      }),
    },
    connectors: [createTerraformModule(), createHealthModule(), createEventsApiModule()],
  });
});
afterAll(async () => {
  await afe.app.close();
  await pool.end();
});

it("serves created, lost and deleted lifecycle events with separate actor identities", async () => {
  const response = await afe.app.inject({
    method: "POST",
    url: "/api/connections/terraform",
    payload: { workspace: "lifecycle" },
  });
  expect(response.statusCode).toBe(201);
  const { connection, secret } = response.json();
  await afe.context.health!.reportFailure("default", connection.id, "unreachable");
  await afe.context.health!.reportFailure("default", connection.id, "unreachable");
  const remove = () =>
    afe.app.inject({ method: "DELETE", url: `/api/connections/terraform/${connection.id}` });
  expect((await remove()).statusCode).toBe(200);
  expect((await remove()).statusCode).toBe(200);
  const list = await afe.app.inject({ url: "/api/events?source=afe" });
  expect(list.statusCode).toBe(200);
  const events = list.json().items.map((item: { event: { action: string } }) => item.event);
  for (const action of ["connection.created", "connection.lost", "connection.deleted"]) {
    expect(events.filter((event: { action: string }) => event.action === action)).toHaveLength(1);
  }
  expect(
    events.find((event: { action: string }) => event.action === "connection.created"),
  ).toMatchObject({
    actor: { id: "admin-1", name: "Administrator", type: "user" },
    data: { actorOrigin: "afe" },
  });
  expect(
    events.find((event: { action: string }) => event.action === "connection.lost"),
  ).toMatchObject({ actor: { type: "system" } });
  expect(list.body).not.toContain(secret);
  const filtered = await afe.app.inject({ url: "/api/events?source=afe&actor=admin-1" });
  expect(filtered.json().items).toHaveLength(2);
});
