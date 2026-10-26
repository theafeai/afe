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
});
