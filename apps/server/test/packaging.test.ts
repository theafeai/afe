import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { MIGRATIONS_DIR } from "@afe/db";
import { createAfe, loadConfig } from "../src/index.ts";
import { resolveMigrationsDir } from "../src/migrations-dir.ts";

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "afe-packaging-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("resolveMigrationsDir", () => {
  it("prefers AFE_MIGRATIONS_DIR", () => {
    expect(resolveMigrationsDir({ AFE_MIGRATIONS_DIR: "/opt/afe/migrations" })).toBe(
      "/opt/afe/migrations",
    );
  });

  it("finds migrations shipped next to the bundle (dist/migrations)", async () => {
    const dist = path.join(tmp, "dist");
    await mkdir(path.join(dist, "migrations"), { recursive: true });
    const bundleUrl = pathToFileURL(path.join(dist, "cli.js")).href;
    expect(resolveMigrationsDir({}, bundleUrl)).toBe(path.join(dist, "migrations"));
  });

  it("falls back to @afe/db's migrations when running from source", async () => {
    expect(resolveMigrationsDir({})).toBe(MIGRATIONS_DIR);
    expect((await readdir(MIGRATIONS_DIR)).some((f) => f.endsWith(".sql"))).toBe(true);
  });
});

describe("loadConfig", () => {
  it("reads DATABASE_URL_FILE and rejects setting both forms", async () => {
    const file = path.join(tmp, "database_url");
    await writeFile(file, "postgres://afe:pw@db:5432/afe\n");
    expect(loadConfig({ DATABASE_URL_FILE: file }).databaseUrl).toBe(
      "postgres://afe:pw@db:5432/afe",
    );
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", DATABASE_URL_FILE: file })).toThrow(
      /only one/,
    );
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("does not echo the file path contents on read errors", () => {
    expect(() => loadConfig({ DATABASE_URL_FILE: path.join(tmp, "missing") })).toThrow(
      /DATABASE_URL_FILE: cannot read/,
    );
  });
});

describe("web UI (AFE_WEB_DIR)", () => {
  // createAfe only needs the pool for /healthz; these tests do not call it.
  const pool = {} as pg.Pool;

  it("serves index.html at / and hashed assets with long-lived caching", async () => {
    const web = path.join(tmp, "web");
    await mkdir(path.join(web, "assets"), { recursive: true });
    await writeFile(path.join(web, "index.html"), "<!doctype html><title>Afe</title>");
    await writeFile(path.join(web, "assets", "index-abc123.js"), "console.log(1)");
    await writeFile(path.join(web, "weird:name.js"), "ignored");

    const app = await createAfe({
      pool,
      logLevel: "silent",
      config: { ...loadConfig({ DATABASE_URL: "unused" }), webDir: web },
    });
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toMatch(/^text\/html/);
    expect(root.headers["cache-control"]).toBe("no-cache");
    expect(root.body).toContain("<title>Afe</title>");

    const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");

    const head = await app.inject({ method: "HEAD", url: "/index.html" });
    expect(head.statusCode).toBe(200);

    for (const url of [
      "/assets/missing.js",
      "/../package.json",
      "/assets/%2e%2e/%2e%2e/etc/passwd",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
    await app.close();
  });

  it("serves no UI when AFE_WEB_DIR is unset", async () => {
    const app = await createAfe({ pool, logLevel: "silent" });
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    await app.close();
  });
});
