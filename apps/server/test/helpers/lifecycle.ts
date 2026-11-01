import { expect } from "vitest";
import type pg from "pg";

export async function expectLifecycle(
  pool: pg.Pool,
  id: string,
  action: string,
  owner?: string,
  actor = "test-admin",
) {
  const { rows } = await pool.query(
    "SELECT actor, data FROM events WHERE tenant_id = 'default' AND connection_id = $1 AND action = $2",
    [id, action],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].actor).toMatchObject({ type: "user", id: actor });
  expect(rows[0].data.actorOrigin).toBe("afe");
  if (owner) expect(rows[0].data.credentialOwner.login).toBe(owner);
  else expect(rows[0].data.credentialOwner).toBeUndefined();
}
