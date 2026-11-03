import pg from "pg";
import type { ToolPolicy } from "@afe/core";
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

/** Seed pre-AFE-84 rows to verify fail-closed upgrades. Never used by production. */
export async function seedLegacyToolPolicy(
  pool: pg.Pool,
  tenantId: string,
  userId: string,
  tool: string,
  policy: ToolPolicy,
) {
  await pool.query(
    `INSERT INTO user_tool_permissions (tenant_id,user_id,tool,mode,custom_grants,denied_grants)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,user_id,tool)
     DO UPDATE SET mode=EXCLUDED.mode, custom_grants=EXCLUDED.custom_grants,
       denied_grants=EXCLUDED.denied_grants`,
    [
      tenantId,
      userId,
      tool,
      policy.mode,
      JSON.stringify(policy.custom),
      JSON.stringify(policy.denied ?? []),
    ],
  );
}
