/**
 * Drift findings and settings (AFE-26, migration 0024). Every function is
 * tenant-scoped (rules R5). The server's drift service derives findings from
 * the correlation window and reconciles them here; see docs/drift.md.
 */
import type { JsonObject } from "@afe/core";
import type { Queryable } from "./event-store.ts";

export interface DriftEvidenceRecord {
  eventId: string;
  role: string;
  at: string;
  summary: string;
}

export interface DriftFindingRecord {
  tenantId: string;
  id: string;
  type: string;
  severity: string;
  status: "open" | "resolved";
  targetKey: string;
  targetSource: string;
  targetLabel: string;
  toolEnvironment: string;
  serviceId: string | null;
  serviceName: string | null;
  environmentId: string | null;
  environmentName: string | null;
  title: string;
  explanation: string;
  openingEventId: string;
  latestEventId: string;
  resolvedByEventId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  evidence: DriftEvidenceRecord[];
  evidenceOmitted: number;
  details: JsonObject;
  fingerprint: string;
  detectedAt: Date;
  updatedAt: Date;
  openedRecordedAt: Date | null;
  resolvedRecordedAt: Date | null;
  alert: boolean;
  openedNotifiedAt: Date | null;
  resolvedNotifiedAt: Date | null;
  notifyAttempts: number;
  lastNotifyError: string | null;
}

/** Fields written on insert/update (everything derived, plus side-effect state). */
export type DriftFindingWrite = Omit<
  DriftFindingRecord,
  "tenantId" | "notifyAttempts" | "lastNotifyError"
>;

const COLUMNS: [keyof DriftFindingWrite, string][] = [
  ["id", "id"],
  ["type", "type"],
  ["severity", "severity"],
  ["status", "status"],
  ["targetKey", "target_key"],
  ["targetSource", "target_source"],
  ["targetLabel", "target_label"],
  ["toolEnvironment", "tool_environment"],
  ["serviceId", "service_id"],
  ["serviceName", "service_name"],
  ["environmentId", "environment_id"],
  ["environmentName", "environment_name"],
  ["title", "title"],
  ["explanation", "explanation"],
  ["openingEventId", "opening_event_id"],
  ["latestEventId", "latest_event_id"],
  ["resolvedByEventId", "resolved_by_event_id"],
  ["firstSeenAt", "first_seen_at"],
  ["lastSeenAt", "last_seen_at"],
  ["resolvedAt", "resolved_at"],
  ["evidence", "evidence"],
  ["evidenceOmitted", "evidence_omitted"],
  ["details", "details"],
  ["fingerprint", "fingerprint"],
  ["detectedAt", "detected_at"],
  ["updatedAt", "updated_at"],
  ["openedRecordedAt", "opened_recorded_at"],
  ["resolvedRecordedAt", "resolved_recorded_at"],
  ["alert", "alert"],
  ["openedNotifiedAt", "opened_notified_at"],
  ["resolvedNotifiedAt", "resolved_notified_at"],
];

const JSON_FIELDS = new Set<keyof DriftFindingWrite>(["evidence", "details"]);

type Row = Record<string, unknown>;

function fromRow(r: Row): DriftFindingRecord {
  const out: Record<string, unknown> = {
    tenantId: r.tenant_id,
    notifyAttempts: Number(r.notify_attempts ?? 0),
    lastNotifyError: r.last_notify_error ?? null,
  };
  for (const [k, c] of COLUMNS) out[k] = r[c] ?? null;
  out.evidenceOmitted = Number(r.evidence_omitted ?? 0);
  out.alert = Boolean(r.alert);
  return out as unknown as DriftFindingRecord;
}

function param(k: keyof DriftFindingWrite, v: unknown): unknown {
  if (JSON_FIELDS.has(k)) return JSON.stringify(v);
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

/** All findings of a tenant (reconciliation reads them under the tenant lock). */
export async function listAllDriftFindings(
  db: Queryable,
  tenantId: string,
): Promise<DriftFindingRecord[]> {
  const { rows } = await db.query<Row>(
    "SELECT * FROM drift_findings WHERE tenant_id = $1 ORDER BY first_seen_at, id",
    [tenantId],
  );
  return rows.map(fromRow);
}

export async function insertDriftFinding(
  db: Queryable,
  tenantId: string,
  f: DriftFindingWrite,
): Promise<void> {
  const params: unknown[] = [tenantId];
  const cols = ["tenant_id"];
  for (const [k, c] of COLUMNS) {
    cols.push(c);
    params.push(param(k, f[k]));
  }
  await db.query(
    `INSERT INTO drift_findings (${cols.join(", ")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    params,
  );
}

export async function updateDriftFinding(
  db: Queryable,
  tenantId: string,
  id: string,
  patch: Partial<DriftFindingWrite>,
): Promise<void> {
  const params: unknown[] = [tenantId, id];
  const sets: string[] = [];
  for (const [k, c] of COLUMNS) {
    if (k === "id" || !(k in patch)) continue;
    params.push(param(k, patch[k]));
    sets.push(`${c} = $${params.length}`);
  }
  if (sets.length === 0) return;
  await db.query(
    `UPDATE drift_findings SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`,
    params,
  );
}

/**
 * Deletes findings that ended (resolved_at) or were last seen before the
 * cutoff, except `keepIds` (still detected in the current window).
 */
export async function purgeDriftFindingsBefore(
  db: Queryable,
  tenantId: string,
  cutoff: Date,
  keepIds: string[] = [],
): Promise<number> {
  const res = await db.query(
    `DELETE FROM drift_findings
      WHERE tenant_id = $1
        AND COALESCE(resolved_at, last_seen_at) < $2
        AND NOT (id = ANY($3::uuid[]))`,
    [tenantId, cutoff.toISOString(), keepIds],
  );
  return res.rowCount ?? 0;
}

export async function getDriftFinding(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<DriftFindingRecord | null> {
  const { rows } = await db.query<Row>(
    "SELECT * FROM drift_findings WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export interface ListDriftFindingsOptions {
  status?: "open" | "resolved";
  types?: string[];
  severities?: string[];
  /** Service id; null = unmapped. */
  service?: string | null;
  /** Environment id; null = unmapped. */
  environment?: string | null;
  targetKey?: string;
  /** Keyset cursor (newest last_seen_at first). */
  before?: { lastSeenAt: string; id: string };
  limit?: number;
}

function filters(tenantId: string, o: ListDriftFindingsOptions) {
  const params: unknown[] = [tenantId];
  const where = ["tenant_id = $1"];
  const add = (sql: (p: string) => string, v: unknown) => {
    params.push(v);
    where.push(sql(`$${params.length}`));
  };
  if (o.status) add((p) => `status = ${p}`, o.status);
  if (o.types?.length) add((p) => `type = ANY(${p}::text[])`, o.types);
  if (o.severities?.length) add((p) => `severity = ANY(${p}::text[])`, o.severities);
  if (o.service !== undefined) {
    if (o.service === null) where.push("service_id IS NULL");
    else add((p) => `service_id = ${p}`, o.service);
  }
  if (o.environment !== undefined) {
    if (o.environment === null) where.push("environment_id IS NULL");
    else add((p) => `environment_id = ${p}`, o.environment);
  }
  if (o.targetKey) add((p) => `target_key = ${p}`, o.targetKey);
  return { params, where };
}

/** One page of findings, most recently seen first. */
export async function listDriftFindings(
  db: Queryable,
  tenantId: string,
  o: ListDriftFindingsOptions = {},
): Promise<DriftFindingRecord[]> {
  const { params, where } = filters(tenantId, o);
  if (o.before) {
    params.push(o.before.lastSeenAt, o.before.id);
    where.push(
      `(last_seen_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  params.push(Math.min(Math.max(Math.trunc(o.limit ?? 50), 1), 500));
  const { rows } = await db.query<Row>(
    `SELECT * FROM drift_findings WHERE ${where.join(" AND ")}
      ORDER BY last_seen_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(fromRow);
}

export interface DriftCountRow {
  status: string;
  type: string;
  severity: string;
  serviceId: string | null;
  environmentId: string | null;
  targetKey: string;
  count: number;
}

/** Counts grouped by status, type, severity, service, environment and target (same filters). */
export async function countDriftFindings(
  db: Queryable,
  tenantId: string,
  o: Omit<ListDriftFindingsOptions, "before" | "limit"> = {},
): Promise<DriftCountRow[]> {
  const { params, where } = filters(tenantId, o);
  const { rows } = await db.query<Row>(
    `SELECT status, type, severity, service_id, environment_id, target_key, count(*)::int AS n
       FROM drift_findings WHERE ${where.join(" AND ")}
      GROUP BY status, type, severity, service_id, environment_id, target_key`,
    params,
  );
  return rows.map((r) => ({
    status: String(r.status),
    type: String(r.type),
    severity: String(r.severity),
    serviceId: (r.service_id as string | null) ?? null,
    environmentId: (r.environment_id as string | null) ?? null,
    targetKey: String(r.target_key),
    count: Number(r.n),
  }));
}

/**
 * Findings with an undelivered side effect: a transition event not yet
 * recorded, or (alerting on) a notification not yet sent and fewer than
 * `maxAttempts` failed attempts. Across tenants when `tenantId` is null.
 */
export async function listDriftFindingsPending(
  db: Queryable,
  tenantId: string | null,
  maxAttempts: number,
  limit = 500,
): Promise<DriftFindingRecord[]> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM drift_findings
      WHERE ($1::text IS NULL OR tenant_id = $1)
        AND (opened_recorded_at IS NULL
             OR (status = 'resolved' AND resolved_recorded_at IS NULL)
             OR (alert AND notify_attempts < $2
                 AND (opened_notified_at IS NULL
                      OR (status = 'resolved' AND resolved_notified_at IS NULL))))
      ORDER BY detected_at, id
      LIMIT $3`,
    [tenantId, maxAttempts, limit],
  );
  return rows.map(fromRow);
}

export async function markDriftFindingRecorded(
  db: Queryable,
  tenantId: string,
  id: string,
  status: "opened" | "resolved",
  at: Date,
): Promise<void> {
  const col = status === "opened" ? "opened_recorded_at" : "resolved_recorded_at";
  await db.query(`UPDATE drift_findings SET ${col} = $3 WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    id,
    at.toISOString(),
  ]);
}

export async function markDriftFindingNotified(
  db: Queryable,
  tenantId: string,
  id: string,
  status: "opened" | "resolved",
  at: Date,
): Promise<void> {
  const col = status === "opened" ? "opened_notified_at" : "resolved_notified_at";
  await db.query(
    `UPDATE drift_findings SET ${col} = $3, notify_attempts = 0, last_notify_error = NULL
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, at.toISOString()],
  );
}

export async function recordDriftNotifyFailure(
  db: Queryable,
  tenantId: string,
  id: string,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE drift_findings SET notify_attempts = notify_attempts + 1, last_notify_error = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, error.slice(0, 1024)],
  );
}

/** Ids of the given events that are still stored (evidence availability after purges). */
export async function existingEventIds(
  db: Queryable,
  tenantId: string,
  ids: string[],
): Promise<Set<string>> {
  const uuids = ids.filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );
  if (uuids.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM events WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenantId, uuids],
  );
  return new Set(rows.map((r) => r.id));
}

export interface DriftSettingsRecord {
  alertTypes: string[] | null;
  severities: Record<string, string>;
  updatedAt: Date;
}

export async function getDriftSettings(
  db: Queryable,
  tenantId: string,
): Promise<DriftSettingsRecord | null> {
  const { rows } = await db.query<{
    alert_types: string[] | null;
    severities: Record<string, string>;
    updated_at: Date;
  }>("SELECT alert_types, severities, updated_at FROM drift_settings WHERE tenant_id = $1", [
    tenantId,
  ]);
  const r = rows[0];
  return r
    ? { alertTypes: r.alert_types, severities: r.severities, updatedAt: r.updated_at }
    : null;
}

export async function putDriftSettings(
  db: Queryable,
  tenantId: string,
  s: { alertTypes: string[] | null; severities: Record<string, string> },
): Promise<DriftSettingsRecord> {
  const { rows } = await db.query<{ updated_at: Date }>(
    `INSERT INTO drift_settings (tenant_id, alert_types, severities, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET alert_types = EXCLUDED.alert_types, severities = EXCLUDED.severities, updated_at = now()
     RETURNING updated_at`,
    [tenantId, s.alertTypes, JSON.stringify(s.severities)],
  );
  return { ...s, updatedAt: rows[0]!.updated_at };
}
