import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestPool } from "@afe/db/testing";
import { createAfe } from "../src/index.ts";

describe("server logging", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("redacts auth headers, signatures and token fields", async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = await createAfe({ pool, logLevel: "info", logStream });
    app.get("/probe", async (req) => {
      req.log.info({ req: { headers: req.headers } }, "headers");
      req.log.info({ connection: { token: "tok-SECRET", url: "https://x" } }, "connection");
      req.log.info({ token: "tok-SECRET-2" }, "top-level");
      return { ok: true };
    });
    await app.inject({
      method: "GET",
      url: "/probe",
      headers: {
        authorization: "Bearer bearer-SECRET",
        cookie: "session=cookie-SECRET",
        "x-hub-signature-256": "sha256=sig-SECRET",
        "x-vercel-signature": "vsig-SECRET",
      },
    });
    await app.close();
    const output = lines.join("");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("https://x");
    expect(output).not.toMatch(/SECRET/);
  });
});
