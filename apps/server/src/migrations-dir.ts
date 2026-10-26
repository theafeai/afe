import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS_DIR } from "@afe/db";

/**
 * Where the SQL migrations live at runtime.
 *
 * 1. `AFE_MIGRATIONS_DIR`, if set (operator override).
 * 2. `migrations/` next to this module: the tsup bundle (`dist/cli.js`) ships a
 *    copy at `dist/migrations`, because `MIGRATIONS_DIR` in `@afe/db` is resolved
 *    from `import.meta.url`, which points at the bundle after bundling.
 * 3. `MIGRATIONS_DIR` from `@afe/db` (running from source).
 */
export function resolveMigrationsDir(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string {
  if (env.AFE_MIGRATIONS_DIR) return path.resolve(env.AFE_MIGRATIONS_DIR);
  const bundled = fileURLToPath(new URL("./migrations", moduleUrl));
  if (existsSync(bundled)) return bundled;
  return MIGRATIONS_DIR;
}
