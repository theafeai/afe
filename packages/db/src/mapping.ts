/**
 * Environment and service mapping configuration (AFE-19, migration 0019).
 * Every function is tenant-scoped. Changes go through `changeMapping`, which
 * serialises a tenant's changes, bumps its revision and writes the audit
 * event to the outbox in the same transaction.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CanonicalEventInputLike, JsonObject } from "@afe/core";
import {
  DEFAULT_ENVIRONMENTS,
  type Environment,
  type EnvironmentKind,
  type MappingConfig,
  type MappingRule,
  type RuleKind,
  type Service,
} from "@afe/core/mapping";

type Db = pg.Pool | pg.PoolClient;

export interface StoredMappingConfig extends MappingConfig {
  /** 0 until the tenant's first change. */
  revision: number;
  /** False while the tenant uses the built-in default environments. */
  customised: boolean;
  builtinOverrides: Record<string, boolean>;
}

/** A unique id is already taken (service/environment id). */
export class MappingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingConflictError";
  }
}

interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
}
interface EnvironmentRow {
  id: string;
  name: string;
  kind: EnvironmentKind;
  sort_order: number;
}
interface RuleRow {
  id: string;
  kind: RuleKind;
  field: string;
  match_type: MappingRule["match"];
  pattern: string;
  case_sensitive: boolean;
  priority: number;
  service_id: string | null;
  environment_id: string | null;
  enabled: boolean;
  note: string | null;
}

const toService = (r: ServiceRow): Service => ({
  id: r.id,
  name: r.name,
  description: r.description,
});
const toEnvironment = (r: EnvironmentRow): Environment => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  order: r.sort_order,
});
const toRule = (r: RuleRow): MappingRule => ({
  id: r.id,
  kind: r.kind,
  field: r.field as MappingRule["field"],
  match: r.match_type,
  pattern: r.pattern,
  caseSensitive: r.case_sensitive,
  priority: r.priority,
  targetId: (r.kind === "service" ? r.service_id : r.environment_id)!,
  enabled: r.enabled,
  note: r.note,
});

const RULE_COLUMNS =
  "id, kind, field, match_type, pattern, case_sensitive, priority, service_id, environment_id, enabled, note";

export async function getMappingRevision(db: Db, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ revision: string }>(
    "SELECT revision FROM mapping_settings WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0] ? Number(rows[0].revision) : 0;
}

export async function getMappingConfig(db: Db, tenantId: string): Promise<StoredMappingConfig> {
  const settings = await db.query<{ revision: string }>(
    "SELECT revision FROM mapping_settings WHERE tenant_id = $1",
    [tenantId],
  );
  const customised = settings.rows.length > 0;
  const [services, environments, rules, overrides] = await Promise.all([
    db.query<ServiceRow>(
      "SELECT id, name, description FROM mapping_services WHERE tenant_id = $1 ORDER BY name, id",
      [tenantId],
    ),
    customised
      ? db.query<EnvironmentRow>(
          `SELECT id, name, kind, sort_order FROM mapping_environments
            WHERE tenant_id = $1 ORDER BY sort_order, name, id`,
          [tenantId],
        )
      : null,
    db.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM mapping_rules WHERE tenant_id = $1
        ORDER BY kind, priority, id`,
      [tenantId],
    ),
    db.query<{ rule_id: string; enabled: boolean }>(
      "SELECT rule_id, enabled FROM mapping_builtin_rule_overrides WHERE tenant_id = $1",
      [tenantId],
    ),
  ]);
  return {
    revision: customised ? Number(settings.rows[0]!.revision) : 0,
    customised,
    services: services.rows.map(toService),
    environments: environments
      ? environments.rows.map(toEnvironment)
      : DEFAULT_ENVIRONMENTS.map((e) => ({ ...e })),
    rules: rules.rows.map(toRule),
    builtinOverrides: Object.fromEntries(overrides.rows.map((r) => [r.rule_id, r.enabled])),
  };
}

export interface MappingChange<T> {
  result: T;
  /** The audit event (source afe), built with the new revision. */
  event: CanonicalEventInputLike;
}

export interface MappingChangeResult<T> {
  result: T;
  revision: number;
  /** Outbox entry holding the audit event; delete it once ingested. */
  outboxId: string;
  event: CanonicalEventInputLike;
}

/**
 * Applies one mapping change atomically. `apply` receives the transaction
 * client and the revision the change will have; it returns the result and the
 * audit event. Throwing rolls everything back. The first change of a tenant
 * copies the built-in default environments into its table first.
 */
export async function changeMapping<T>(
  pool: pg.Pool,
  tenantId: string,
  apply: (tx: pg.PoolClient, revision: number) => Promise<MappingChange<T>>,
): Promise<MappingChangeResult<T>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query(
      `INSERT INTO mapping_settings (tenant_id) VALUES ($1)
         ON CONFLICT (tenant_id) DO NOTHING RETURNING tenant_id`,
      [tenantId],
    );
    if (created.rows.length > 0) {
      for (const e of DEFAULT_ENVIRONMENTS) {
        await client.query(
          `INSERT INTO mapping_environments (tenant_id, id, name, kind, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, e.id, e.name, e.kind, e.order],
        );
      }
    }
    const { rows } = await client.query<{ revision: string }>(
      "SELECT revision FROM mapping_settings WHERE tenant_id = $1 FOR UPDATE",
      [tenantId],
    );
    const revision = Number(rows[0]!.revision) + 1;
    const change = await apply(client, revision);
    await client.query(
      "UPDATE mapping_settings SET revision = $2, updated_at = now() WHERE tenant_id = $1",
      [tenantId, revision],
    );
    const outboxId = randomUUID();
    await client.query(
      `INSERT INTO mapping_audit_outbox (tenant_id, id, revision, event) VALUES ($1, $2, $3, $4)`,
      [tenantId, outboxId, revision, JSON.stringify(change.event)],
    );
    await client.query("COMMIT");
    return { result: change.result, revision, outboxId, event: change.event };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function conflictOnUnique(err: unknown, message: string): never {
  if ((err as { code?: string }).code === "23505") throw new MappingConflictError(message);
  throw err;
}

// --- Services -----------------------------------------------------------------

export async function getMappingService(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Service | null> {
  const { rows } = await db.query<ServiceRow>(
    "SELECT id, name, description FROM mapping_services WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return rows[0] ? toService(rows[0]) : null;
}

export async function insertMappingService(db: Db, tenantId: string, s: Service): Promise<Service> {
  try {
    const { rows } = await db.query<ServiceRow>(
      `INSERT INTO mapping_services (tenant_id, id, name, description) VALUES ($1, $2, $3, $4)
       RETURNING id, name, description`,
      [tenantId, s.id, s.name, s.description ?? null],
    );
    return toService(rows[0]!);
  } catch (err) {
    return conflictOnUnique(err, `service ${s.id} already exists`);
  }
}

export async function updateMappingService(
  db: Db,
  tenantId: string,
  s: Service,
): Promise<Service | null> {
  const { rows } = await db.query<ServiceRow>(
    `UPDATE mapping_services SET name = $3, description = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING id, name, description`,
    [tenantId, s.id, s.name, s.description ?? null],
  );
  return rows[0] ? toService(rows[0]) : null;
}

export async function deleteMappingService(db: Db, tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "DELETE FROM mapping_services WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

export async function countMappingServices(db: Db, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM mapping_services WHERE tenant_id = $1",
    [tenantId],
  );
  return Number(rows[0]!.n);
}

// --- Environments -------------------------------------------------------------

export async function getMappingEnvironment(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Environment | null> {
  const { rows } = await db.query<EnvironmentRow>(
    `SELECT id, name, kind, sort_order FROM mapping_environments WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] ? toEnvironment(rows[0]) : null;
}

export async function listMappingEnvironments(db: Db, tenantId: string): Promise<Environment[]> {
  const { rows } = await db.query<EnvironmentRow>(
    `SELECT id, name, kind, sort_order FROM mapping_environments WHERE tenant_id = $1
      ORDER BY sort_order, name, id`,
    [tenantId],
  );
  return rows.map(toEnvironment);
}

export async function insertMappingEnvironment(
  db: Db,
  tenantId: string,
  e: Environment,
): Promise<Environment> {
  try {
    const { rows } = await db.query<EnvironmentRow>(
      `INSERT INTO mapping_environments (tenant_id, id, name, kind, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, kind, sort_order`,
      [tenantId, e.id, e.name, e.kind, e.order],
    );
    return toEnvironment(rows[0]!);
  } catch (err) {
    return conflictOnUnique(err, `environment ${e.id} already exists`);
  }
}

export async function updateMappingEnvironment(
  db: Db,
  tenantId: string,
  e: Environment,
): Promise<Environment | null> {
  const { rows } = await db.query<EnvironmentRow>(
    `UPDATE mapping_environments SET name = $3, kind = $4, sort_order = $5, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING id, name, kind, sort_order`,
    [tenantId, e.id, e.name, e.kind, e.order],
  );
  return rows[0] ? toEnvironment(rows[0]) : null;
}

export async function deleteMappingEnvironment(
  db: Db,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "DELETE FROM mapping_environments WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

// --- Rules --------------------------------------------------------------------

export async function getMappingRule(
  db: Db,
  tenantId: string,
  id: string,
): Promise<MappingRule | null> {
  const { rows } = await db.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM mapping_rules WHERE tenant_id = $1 AND id::text = $2`,
    [tenantId, id],
  );
  return rows[0] ? toRule(rows[0]) : null;
}

export async function listMappingRules(
  db: Db,
  tenantId: string,
  kind?: RuleKind,
): Promise<MappingRule[]> {
  const { rows } = await db.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM mapping_rules WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2)
      ORDER BY kind, priority, id`,
    [tenantId, kind ?? null],
  );
  return rows.map(toRule);
}

/** Ids of rules that assign the given service or environment. */
export async function mappingRulesReferencing(
  db: Db,
  tenantId: string,
  kind: RuleKind,
  targetId: string,
): Promise<string[]> {
  const column = kind === "service" ? "service_id" : "environment_id";
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM mapping_rules WHERE tenant_id = $1 AND ${column} = $2 ORDER BY priority, id`,
    [tenantId, targetId],
  );
  return rows.map((r) => r.id);
}

/** Highest priority among the tenant's rules of a kind (0 when none). */
export async function maxMappingRulePriority(
  db: Db,
  tenantId: string,
  kind: RuleKind,
): Promise<number> {
  const { rows } = await db.query<{ max: number | null }>(
    "SELECT max(priority) AS max FROM mapping_rules WHERE tenant_id = $1 AND kind = $2",
    [tenantId, kind],
  );
  return rows[0]?.max ?? 0;
}

function ruleParams(tenantId: string, r: MappingRule): unknown[] {
  return [
    tenantId,
    r.id,
    r.kind,
    r.field,
    r.match,
    r.pattern,
    r.caseSensitive,
    r.priority,
    r.kind === "service" ? r.targetId : null,
    r.kind === "environment" ? r.targetId : null,
    r.enabled,
    r.note ?? null,
  ];
}

export async function insertMappingRule(
  db: Db,
  tenantId: string,
  rule: MappingRule,
): Promise<MappingRule> {
  const { rows } = await db.query<RuleRow>(
    `INSERT INTO mapping_rules (tenant_id, id, kind, field, match_type, pattern, case_sensitive,
       priority, service_id, environment_id, enabled, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${RULE_COLUMNS}`,
    ruleParams(tenantId, rule),
  );
  return toRule(rows[0]!);
}

export async function updateMappingRule(
  db: Db,
  tenantId: string,
  rule: MappingRule,
): Promise<MappingRule | null> {
  const { rows } = await db.query<RuleRow>(
    `UPDATE mapping_rules SET kind = $3, field = $4, match_type = $5, pattern = $6,
       case_sensitive = $7, priority = $8, service_id = $9, environment_id = $10, enabled = $11,
       note = $12, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING ${RULE_COLUMNS}`,
    ruleParams(tenantId, rule),
  );
  return rows[0] ? toRule(rows[0]) : null;
}

export async function deleteMappingRule(db: Db, tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "DELETE FROM mapping_rules WHERE tenant_id = $1 AND id::text = $2",
    [tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

/** Sets priorities 10, 20, 30... in the given order. */
export async function setMappingRuleOrder(db: Db, tenantId: string, ids: string[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await db.query(
      "UPDATE mapping_rules SET priority = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2",
      [tenantId, id, (i + 1) * 10],
    );
  }
}

export async function setBuiltinRuleOverride(
  db: Db,
  tenantId: string,
  ruleId: string,
  enabled: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO mapping_builtin_rule_overrides (tenant_id, rule_id, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, rule_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [tenantId, ruleId, enabled],
  );
}

// --- Audit outbox -------------------------------------------------------------

export interface MappingAuditOutboxEntry {
  tenantId: string;
  id: string;
  revision: number;
  event: JsonObject;
  attempts: number;
}

/** Pending audit events of every tenant, oldest first (for the outbox job). */
export async function listMappingAuditOutboxAcrossTenants(
  db: Db,
  limit = 100,
): Promise<MappingAuditOutboxEntry[]> {
  const { rows } = await db.query<{
    tenant_id: string;
    id: string;
    revision: string;
    event: JsonObject;
    attempts: number;
  }>(
    `SELECT tenant_id, id, revision, event, attempts FROM mapping_audit_outbox
      ORDER BY created_at, revision LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    id: r.id,
    revision: Number(r.revision),
    event: r.event,
    attempts: r.attempts,
  }));
}

export async function deleteMappingAuditOutboxEntry(
  db: Db,
  tenantId: string,
  id: string,
): Promise<void> {
  await db.query("DELETE FROM mapping_audit_outbox WHERE tenant_id = $1 AND id = $2", [
    tenantId,
    id,
  ]);
}

export async function recordMappingAuditOutboxFailure(
  db: Db,
  tenantId: string,
  id: string,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE mapping_audit_outbox SET attempts = attempts + 1, last_error = left($3, 1024)
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error],
  );
}
