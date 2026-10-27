import { expect, it } from "vitest";
import { createTestPool } from "@afe/db/testing";
import { PgBossJobRunner } from "../src/jobs.ts";

it("bootstraps concurrent server and worker queues on a fresh database", async () => {
  const pool = await createTestPool();
  const url =
    process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/afe_test";
  const runners = [new PgBossJobRunner(url), new PgBossJobRunner(url)];
  try {
    await pool.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    const definitions = ["test.startup.one", "test.startup.two"].map((name) => ({
      name,
      handler: async () => {},
      schedule: "0 0 * * *",
    }));
    await Promise.all([
      runners[0]!.register(definitions, { work: false }),
      runners[1]!.register([...definitions].reverse(), { work: false }),
    ]);
    await Promise.all(runners.map((runner) => runner.send("test.startup.one", { ok: true })));
    const result = await pool.query(
      "SELECT name FROM pgboss.queue WHERE name LIKE 'test.startup.%' ORDER BY name",
    );
    expect(result.rows).toEqual(definitions.map(({ name }) => ({ name })));
  } finally {
    await Promise.all(runners.map((runner) => runner.stop()));
    await pool.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await pool.end();
  }
});
