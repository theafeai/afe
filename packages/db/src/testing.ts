import pg from "pg";
import { migrate } from "./migrate.ts";

/**
 * Connects to TEST_DATABASE_URL (default: local Postgres `afe_test`), resets the
 * public schema and applies all migrations. For tests only.
 */
export async function createTestPool(): Promise<pg.Pool> {
  const url =
    process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/afe_test";
  const pool = new pg.Pool({ connectionString: url });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
  return pool;
}
