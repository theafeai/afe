import { createPool, migrate } from "@afe/db";
import { createAfe } from "./app.ts";
import { loadConfig } from "./config.ts";

const USAGE = "usage: afe <all|server|worker|migrate>";

async function main(argv: string[]): Promise<void> {
  const role = argv[0] ?? "all";
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  if (role === "migrate") {
    const applied = await migrate(pool);
    console.warn(`applied ${applied.length} migration(s)`);
    await pool.end();
    return;
  }
  if (!["all", "server", "worker"].includes(role)) throw new Error(USAGE);

  await migrate(pool);
  if (role === "all" || role === "server") {
    const app = await createAfe({ pool, logLevel: config.logLevel });
    await app.listen({ host: config.host, port: config.port });
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
