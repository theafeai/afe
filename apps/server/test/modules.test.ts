import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, InlineJobQueue, type ConnectorModule } from "../src/index.ts";

describe("connector modules", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("registers routes and jobs, and exposes the raw body for signatures", async () => {
    const handled: object[] = [];
    const jobs = new InlineJobQueue();
    const mod: ConnectorModule = {
      source: "test",
      routes(app, ctx) {
        app.post("/webhooks/test", async (req) => {
          await ctx.jobs.send("test.webhook", { raw: req.rawBody?.toString("utf8") });
          return { ok: true };
        });
      },
      jobs: () => [{ name: "test.webhook", handler: async (d) => void handled.push(d) }],
    };
    const { app, jobDefinitions } = await buildAfe({
      pool,
      logLevel: "silent",
      jobs,
      connectors: [mod],
    });
    jobs.register(jobDefinitions);

    const body = '{"b": 1,  "a": 2}';
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/test",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await jobs.drain();
    expect(handled).toEqual([{ raw: body }]);
    await app.close();
  });

  it("rejects malformed JSON with 400", async () => {
    const { app } = await buildAfe({ pool, logLevel: "silent" });
    app.post("/x", async () => ({}));
    const res = await app.inject({
      method: "POST",
      url: "/x",
      headers: { "content-type": "application/json" },
      payload: "{nope",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
