/**
 * Inferred setup and admin overrides (ADR 0019; migration 0042).
 * Every function is tenant-scoped.
 *
 * The two stores have separate writers, enforced by the database: a
 * statement on `inferred_setup` fails unless its transaction declared the
 * `inference` writer, and one on `setup_overrides` unless it declared the
 * `admin` writer. `replaceInferredSetup` (the inference job's only write) can
 * therefore never change an override, and admin writes never change what
 * Afe inferred.
 */
import type pg from "pg";
import { principalIdentity } from "@afe/core";
import type {
  InferredFact,
  InferredFactRecord,
  OverrideField,
  SetupActor,
  SetupOverrideRecord,
  SetupSubject,
} from "@afe/core/setup";

type Db = pg.Pool | pg.PoolClient;

/** Declares the writer for the current transaction (`SET LOCAL`). */
async function declareWriter(tx: pg.PoolClient, writer: "inference" | "admin"): Promise<void> {
  await tx.query("SELECT set_config('afe.setup_writer', $1, true)", [writer]);
}

interface InferredRow {
  subject: SetupSubject;
  field: InferredFact["field"];
  value: unknown;
  confidence: InferredFact["confidence"];
  reason: string;
  evidence: InferredFact["evidence"];
  first_inferred_at: Date;
  computed_at: Date;
}

export async function listInferredSetup(db: Db, tenantId: string): Promise<InferredFactRecord[]> {
  const { rows } = await db.query<InferredRow>(
    `SELECT subject, field, value, confidence, reason, evidence, first_inferred_at, computed_at
       FROM inferred_setup WHERE tenant_id = $1 ORDER BY subject, field`,
    [tenantId],
  );
  return rows.map(
    (r) =>
      ({
        subject: r.subject,
        field: r.field,
        value: r.value,
        confidence: r.confidence,
        reason: r.reason,
        evidence: r.evidence,
        firstInferredAt: r.first_inferred_at.toISOString(),
        computedAt: r.computed_at.toISOString(),
      }) as InferredFactRecord,
  );
}

/**
 * A version of the tenant's setup stores for caches: it changes with every
 * inference run and every override write (including author removal).
 */
export async function getSetupVersion(db: Db, tenantId: string): Promise<string> {
  const { rows } = await db.query<{ inferred: string | null; overrides: string | null }>(
    `SELECT
       (SELECT max(computed_at)::text || ':' || count(*)::text
          FROM inferred_setup WHERE tenant_id = $1) AS inferred,
       (SELECT md5(string_agg(subject || '/' || field || '/' || set_by || '/' || set_at::text,
                              ',' ORDER BY subject, field))
          FROM setup_overrides WHERE tenant_id = $1) AS overrides`,
    [tenantId],
  );
  return `${rows[0]?.inferred ?? "-"}|${rows[0]?.overrides ?? "-"}`;
}

/**
 * Replaces the tenant's inferred facts with one run's result, atomically:
 * facts are upserted (`first_inferred_at`, the first run that produced a fact,
 * is kept), facts the run no longer
 * produced are deleted. Concurrent runs for one tenant are serialised. This
 * is the inference job's only write, and it cannot touch `setup_overrides`.
 */
export async function replaceInferredSetup(
  pool: pg.Pool,
  tenantId: string,
  facts: readonly InferredFact[],
  computedAt: Date = new Date(),
): Promise<{ written: number; removed: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await declareWriter(client, "inference");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('afe.inferred_setup:' || $1))", [
      tenantId,
    ]);
    const rows = facts.map((f) => ({
      subject: f.subject,
      field: f.field,
      value: f.value,
      confidence: f.confidence,
      reason: f.reason.slice(0, 512),
      evidence: f.evidence,
    }));
    let written = 0;
    if (rows.length > 0) {
      const res = await client.query(
        `INSERT INTO inferred_setup
           (tenant_id, subject, field, value, confidence, reason, evidence, first_inferred_at,
            computed_at)
         SELECT $1, x.subject, x.field, x.value, x.confidence, x.reason, x.evidence, $3, $3
           FROM jsonb_to_recordset($2::jsonb)
             AS x(subject text, field text, value jsonb, confidence text, reason text, evidence jsonb)
         ON CONFLICT (tenant_id, subject, field) DO UPDATE SET
           value = EXCLUDED.value, confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
           evidence = EXCLUDED.evidence, computed_at = EXCLUDED.computed_at`,
        [tenantId, JSON.stringify(rows), computedAt],
      );
      written = res.rowCount ?? 0;
    }
    const removed = await client.query(
      "DELETE FROM inferred_setup WHERE tenant_id = $1 AND computed_at <> $2",
      [tenantId, computedAt],
    );
    await client.query("COMMIT");
    return { written, removed: removed.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface OverrideRow {
  subject: SetupSubject;
  field: OverrideField;
  value: unknown;
  set_by: string;
  set_by_name: string | null;
  set_at: Date;
  kept_inferred: unknown;
}

const toOverride = (r: OverrideRow): SetupOverrideRecord => ({
  subject: r.subject,
  field: r.field,
  value: r.value,
  // Rows set before AFE-120 name the administrator by token fingerprint.
  setBy: { name: null, ...principalIdentity(r.set_by, r.set_by_name) },
  setAt: r.set_at.toISOString(),
  keptInferred: r.kept_inferred ?? null,
});

const OVERRIDE_COLUMNS = "subject, field, value, set_by, set_by_name, set_at, kept_inferred";

export async function listSetupOverrides(db: Db, tenantId: string): Promise<SetupOverrideRecord[]> {
  const { rows } = await db.query<OverrideRow>(
    `SELECT ${OVERRIDE_COLUMNS} FROM setup_overrides WHERE tenant_id = $1 ORDER BY subject, field`,
    [tenantId],
  );
  return rows.map(toOverride);
}

export interface SetupOverrideWrite {
  subject: SetupSubject;
  field: OverrideField;
  value: unknown;
  /** The inferred value the admin keeps theirs against (or null). */
  keptInferred?: unknown;
}

/**
 * Sets an admin override. Admin API only; call inside a transaction (the
 * mapping change transaction), which this declares as the admin writer.
 */
export async function setSetupOverride(
  tx: pg.PoolClient,
  tenantId: string,
  write: SetupOverrideWrite,
  actor: SetupActor,
): Promise<SetupOverrideRecord> {
  await declareWriter(tx, "admin");
  const { rows } = await tx.query<OverrideRow>(
    `INSERT INTO setup_overrides
       (tenant_id, subject, field, value, set_by, set_by_name, set_at, kept_inferred)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
     ON CONFLICT (tenant_id, subject, field) DO UPDATE SET
       value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_by_name = EXCLUDED.set_by_name,
       set_at = now(), kept_inferred = EXCLUDED.kept_inferred
     RETURNING ${OVERRIDE_COLUMNS}`,
    [
      tenantId,
      write.subject,
      write.field,
      JSON.stringify(write.value),
      actor.id.slice(0, 256),
      actor.name?.slice(0, 256) ?? null,
      write.keptInferred === undefined || write.keptInferred === null
        ? null
        : JSON.stringify(write.keptInferred),
    ],
  );
  return toOverride(rows[0]!);
}

/**
 * Removes admin overrides of a subject ("Use Afe's guess"), all fields or
 * the given ones. Admin API only; call inside a transaction.
 */
export async function clearSetupOverrides(
  tx: pg.PoolClient,
  tenantId: string,
  subject: SetupSubject,
  fields?: readonly OverrideField[],
): Promise<SetupOverrideRecord[]> {
  await declareWriter(tx, "admin");
  const { rows } = await tx.query<OverrideRow>(
    `DELETE FROM setup_overrides
      WHERE tenant_id = $1 AND subject = $2 AND ($3::text[] IS NULL OR field = ANY($3))
      RETURNING ${OVERRIDE_COLUMNS}`,
    [tenantId, subject, fields ? [...fields] : null],
  );
  return rows.map(toOverride);
}

/**
 * On user deletion: overrides the user set stay (they are the org's
 * setup) but no longer name the user. Call inside the deletion transaction.
 */
export async function forgetSetupOverrideAuthor(
  tx: pg.PoolClient,
  tenantId: string,
  principalIds: readonly string[],
): Promise<number> {
  await declareWriter(tx, "admin");
  const { rowCount } = await tx.query(
    `UPDATE setup_overrides SET set_by = 'deleted-user', set_by_name = NULL
      WHERE tenant_id = $1 AND set_by = ANY($2::text[])`,
    [tenantId, [...principalIds]],
  );
  return rowCount ?? 0;
}
