#!/usr/bin/env node
import { createPool, migrate, reencryptAllTenants } from "@afe/db";
import { EnvKeyProvider } from "@afe/core/security";
import { buildAfe } from "./app.ts";
import { defaultModules } from "./connectors/index.ts";
import { PgBossJobRunner } from "./jobs.ts";
import { loadConfig } from "./config.ts";
import { resolveMigrationsDir } from "./migrations-dir.ts";

const USAGE = "usage: afe <all|server|worker|migrate|reencrypt-credentials>";

async function main(argv: string[]): Promise<void> {
  const role = argv[0] ?? "all";
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const migrationsDir = resolveMigrationsDir();

  if (role === "migrate") {
    const applied = await migrate(pool, migrationsDir);
    console.warn(`applied ${applied.length} migration(s)`);
    await pool.end();
    return;
  }
  if (role === "reencrypt-credentials") {
    // Key rotation, see docs/security/key-management.md.
    const keys = EnvKeyProvider.fromEnv();
    await migrate(pool, migrationsDir);
    const counts = await reencryptAllTenants(pool, keys, keys.activeKeyId());
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.warn(`re-encrypted ${total} credential(s) under key ${keys.activeKeyId()}`);
    await pool.end();
    return;
  }
  if (!["all", "server", "worker"].includes(role)) throw new Error(USAGE);

  await migrate(pool, migrationsDir);
  const jobs = new PgBossJobRunner(config.databaseUrl);
  const { app, jobDefinitions } = await buildAfe({
    pool,
    logLevel: config.logLevel,
    config,
    keys: EnvKeyProvider.fromEnv(),
    jobs,
    connectors: defaultModules,
  });
  // Every role creates queues and schedules; only workers consume them.
  await jobs.register(jobDefinitions, { work: role === "all" || role === "worker" });
  if (role === "all" || role === "server") {
    await app.listen({ host: config.host, port: config.port });
  } else {
    await app.ready();
  }

  const shutdown = async () => {
    await app.close();
    await jobs.stop();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
