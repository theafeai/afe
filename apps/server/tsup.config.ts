import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

// Third-party packages stay external: they are installed in the image's
// node_modules. Every third-party dependency of a bundled workspace package
// must therefore also be listed in this package's dependencies (some, like
// undici, break when bundled into ESM).
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@afe/"));

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Bundle workspace packages so the image only needs third-party node_modules.
  noExternal: [/^@afe\//],
  external,
  clean: true,
  sourcemap: true,
  // Ship the SQL migrations next to the bundle; `resolveMigrationsDir` finds
  // them at dist/migrations (MIGRATIONS_DIR in @afe/db points elsewhere once bundled).
  async onSuccess() {
    await cp("../../packages/db/migrations", "dist/migrations", { recursive: true });
  },
});
