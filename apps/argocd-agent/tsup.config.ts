import { defineConfig } from "tsup";

// The agent image ships one self-contained file: every dependency (only
// workspace packages and Node built-ins) is bundled, so the runtime image
// needs no node_modules.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  clean: true,
  sourcemap: true,
});
