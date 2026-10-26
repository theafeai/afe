import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/{src,test}/**/*.test.ts", "apps/*/{src,test}/**/*.test.{ts,tsx}"],
    // Database tests share one Postgres database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
