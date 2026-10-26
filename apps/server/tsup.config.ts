import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Bundle workspace packages so the image only needs third-party node_modules.
  noExternal: [/^@afe\//],
  clean: true,
  sourcemap: true,
  // Ship the SQL migrations next to the bundle; `resolveMigrationsDir` finds
  // them at dist/migrations (MIGRATIONS_DIR in @afe/db points elsewhere once bundled).
  async onSuccess() {
    await cp("../../packages/db/migrations", "dist/migrations", { recursive: true });
  },
});
