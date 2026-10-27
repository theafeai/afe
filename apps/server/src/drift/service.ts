/**
 * Drift service (AFE-26): derives findings from the correlation window
 * (AFE-20) with `detectDrift`, persists them (migration 0024) so open →
 * resolved transitions are seen once, records them as `drift.finding.*`
 * events and sends alerts through the AlertSink (AFE-13).
 *
 * Evaluation runs in the `drift.evaluate` job (every minute) and on read
 * when the correlation graph changed. It is idempotent: finding ids are
 * deterministic (tenant, type, target, opening event) and a per-tenant
 * advisory lock serialises reconciliation across processes. Docs:
 * docs/drift.md.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { AlertNotification, AlertSink } from "@afe/core";
import {
  DRIFT_FINDING_TYPES,
  detectDrift,
  driftFindingOpened,
  driftFindingResolved,
  isDriftSeverity,
  parseDriftTypeList,
  severityOf,
  type DetectedFinding,
  type DriftFindingEventData,
  type DriftSeverity,
} from "@afe/core/drift";
import {
  getConnection,
  getDriftSettings,
  insertDriftFinding,
  listAllDriftFindings,
  listDriftFindingsPending,
  listTenantsWithEvents,
  markDriftFindingNotified,
  markDriftFindingRecorded,
  purgeDriftFindingsBefore,
  recordDriftNotifyFailure,
  updateDriftFinding,
  type DriftEvidenceRecord,
  type DriftFindingRecord,
  type DriftFindingWrite,
} from "@afe/db";
import type { ServerContext } from "../context.ts";
import type { CorrelationService, Snapshot } from "../correlation/service.ts";
import { asMappable } from "../correlation/views.ts";
import { createLogAlertSink } from "../health/alert-sink.ts";
import { deterministicId, errorDetail } from "../health/sanitize.ts";
import type { PlacementView } from "../mapping/service.ts";

export const DRIFT_JOBS = { EVALUATE: "drift.evaluate" } as const;

export interface DriftServiceOptions {
  now?: () => Date;
  /** Replaces the AlertSink (default: the health module's sink, else a log sink). */
  alertSink?: AlertSink;
  /** Types that alert when a tenant has no settings (AFE_DRIFT_ALERTS). Default none. */
  defaultAlertTypes?: string[];
  /** Failed deliveries per transition before giving up. Default 5. */
  maxNotifyAttempts?: number;
  /** On read, re-evaluate at least this often even if the graph did not change. Default 60 s. */
  maxStaleMs?: number;
  /** Evidence entries kept per finding. Default 20. */
  maxEvidence?: number;
}

export interface DriftSettings {
  alertTypes: string[];
  /** Where `alertTypes` comes from. */
  alertTypesSource: "settings" | "environment";
  /** Tenant overrides only. */
  severityOverrides: Partial<Record<string, DriftSeverity>>;
  /** Effective severity per built-in type. */
  severities: Record<string, DriftSeverity>;
  updatedAt: string | null;
}

export interface EvaluationSummary {
  evaluatedAt: string;
  asOfSeq: number;
  findings: number;
  opened: number;
  resolved: number;
  updated: number;
  purged: number;
}

const MAX_STORED_EVIDENCE = 40;

/** Errors that are part of reconciliation, not bugs: a finding text exceeding a column limit is cut. */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class DriftService {
  readonly #now: () => Date;
  readonly #maxNotifyAttempts: number;
  readonly #maxStaleMs: number;
  readonly #defaultAlertTypes: string[];
  readonly #fresh = new Map<
    string,
    { graph: object; settingsVersion: number; at: number; summary: EvaluationSummary }
  >();
  readonly #settingsVersion = new Map<string, number>();
  readonly #running = new Map<string, Promise<EvaluationSummary | null>>();

  constructor(
    readonly ctx: ServerContext,
    readonly correlation: () => CorrelationService,
    readonly options: DriftServiceOptions = {},
    readonly alertSink: () => AlertSink = () => createLogAlertSink(ctx.log),
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#maxNotifyAttempts = options.maxNotifyAttempts ?? 5;
    this.#maxStaleMs = options.maxStaleMs ?? 60_000;
    this.#defaultAlertTypes = options.defaultAlertTypes ?? [];
  }

  get pool(): pg.Pool {
    return this.ctx.pool;
  }

  // --- settings -------------------------------------------------------------

  async settings(tenantId: string): Promise<DriftSettings> {
    const row = await getDriftSettings(this.pool, tenantId);
    const overrides: Partial<Record<string, DriftSeverity>> = {};
    for (const [k, v] of Object.entries(row?.severities ?? {}))
      if (isDriftSeverity(v)) overrides[k] = v;
    const severities: Record<string, DriftSeverity> = {};
    for (const t of DRIFT_FINDING_TYPES) severities[t] = severityOf(t, overrides);
    return {
      alertTypes: row?.alertTypes ?? this.#defaultAlertTypes,
      alertTypesSource: row?.alertTypes ? "settings" : "environment",
      severityOverrides: overrides,
      severities,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  }

  /** Settings changed: the next read re-evaluates. */
  settingsChanged(tenantId: string): void {
    this.#settingsVersion.set(tenantId, (this.#settingsVersion.get(tenantId) ?? 0) + 1);
  }

  static parseAlertTypes(raw: string | undefined): string[] {
    return parseDriftTypeList(raw);
  }

  // --- evaluation -----------------------------------------------------------

  /**
   * Evaluates when the correlation graph or the settings changed since the
   * last evaluation in this process, or it is older than `maxStaleMs`.
   */
  async ensureFresh(tenantId: string): Promise<EvaluationSummary | null> {
    const snap = await this.correlation().snapshot(tenantId);
    const f = this.#fresh.get(tenantId);
    const version = this.#settingsVersion.get(tenantId) ?? 0;
    if (
      f &&
      f.graph === snap.graph &&
      f.settingsVersion === version &&
      Date.now() - f.at < this.#maxStaleMs
    )
      return f.summary;
    return this.evaluate(tenantId, snap);
  }

  /** Evaluates a tenant (concurrent calls in this process share one run). */
  async evaluate(tenantId: string, snapshot?: Snapshot): Promise<EvaluationSummary | null> {
    const running = this.#running.get(tenantId);
    if (running) return running;
    const run = this.#evaluate(tenantId, snapshot).finally(() => this.#running.delete(tenantId));
    this.#running.set(tenantId, run);
    return run;
  }

  async #evaluate(tenantId: string, given?: Snapshot): Promise<EvaluationSummary> {
    const version = this.#settingsVersion.get(tenantId) ?? 0;
    const snap = given ?? (await this.correlation().snapshot(tenantId));
    const settings = await this.settings(tenantId);
    const detected = detectDrift(
      {
        environments: snap.graph.environments,
        conflicts: snap.graph.conflicts,
        events: snap.graph.events,
      },
      { maxEvidence: this.options.maxEvidence ?? 20 },
    );
    const mapping = await this.#resolve(tenantId, snap, detected);
    const now = this.#now();
    const cutoff = await this.ctx.retention.cutoff(tenantId, now);
    const summary: EvaluationSummary = {
      evaluatedAt: now.toISOString(),
      asOfSeq: snap.window.asOfSeq,
      findings: detected.length,
      opened: 0,
      resolved: 0,
      updated: 0,
      purged: 0,
    };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `afe:drift:${tenantId}`,
      ]);
      const rows = await listAllDriftFindings(client, tenantId);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const detectedIds = new Set<string>();
      const continued = new Set<string>();
      // Resolve ids first (continuations are matched to rows not detected by id).
      const plan = detected.map((d) => ({ d, id: deterministicId("drift", tenantId, d.key) }));
      for (const p of plan) if (byId.has(p.id)) detectedIds.add(p.id);
      for (const p of plan) {
        if (byId.has(p.id)) continue;
        // Same episode whose opening event was purged: keep the stored finding.
        const prev = rows.find(
          (r) =>
            !detectedIds.has(r.id) &&
            !continued.has(r.id) &&
            r.status === "open" &&
            r.type === p.d.type &&
            r.targetKey === p.d.target.key &&
            r.firstSeenAt.toISOString() <= p.d.firstSeenAt &&
            r.lastSeenAt.toISOString() >= p.d.firstSeenAt,
        );
        if (prev) {
          continued.add(prev.id);
          detectedIds.add(prev.id);
          p.id = prev.id;
        }
      }

      for (const { d, id } of plan) {
        const existing = byId.get(id);
        const severity = severityOf(d.type, settings.severityOverrides);
        const write = this.#derived(
          d,
          id,
          severity,
          mapping.get(d.latestEventId) ?? null,
          existing,
          snap,
        );
        if (!existing) {
          await insertDriftFinding(client, tenantId, {
            ...write,
            detectedAt: now,
            updatedAt: now,
            openedRecordedAt: null,
            resolvedRecordedAt: null,
            // Alert on transitions seen while alerting is on for the type.
            alert: d.status === "open" && settings.alertTypes.includes(d.type),
            openedNotifiedAt: null,
            resolvedNotifiedAt: null,
          });
          if (d.status === "open") summary.opened++;
          continue;
        }
        if (existing.fingerprint === write.fingerprint) continue;
        const patch: Partial<DriftFindingWrite> = { ...write, updatedAt: now };
        if (existing.status === "open" && d.status === "resolved") summary.resolved++;
        else summary.updated++;
        await updateDriftFinding(client, tenantId, id, patch);
      }
      if (cutoff)
        summary.purged = await purgeDriftFindingsBefore(client, tenantId, cutoff, [...detectedIds]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    this.#fresh.set(tenantId, {
      graph: snap.graph,
      settingsVersion: version,
      at: Date.now(),
      summary,
    });
    // Transition events are local and cheap: record them right away.
    await this.deliver(tenantId, { alerts: false });
    return summary;
  }

  #derived(
    d: DetectedFinding,
    id: string,
    severity: DriftSeverity,
    place: PlacementView | null,
    existing: DriftFindingRecord | undefined,
    snap: Snapshot,
  ): Omit<
    DriftFindingWrite,
    | "detectedAt"
    | "updatedAt"
    | "openedRecordedAt"
    | "resolvedRecordedAt"
    | "alert"
    | "openedNotifiedAt"
    | "resolvedNotifiedAt"
  > {
    // A continued finding keeps its original opening and the evidence that was purged since.
    const continuing = existing && existing.openingEventId !== d.openingEventId;
    let evidence: DriftEvidenceRecord[] = d.evidence;
    let omitted = d.evidenceOmitted;
    if (continuing) {
      const kept = existing.evidence.filter(
        (e) => e.at < d.firstSeenAt && !d.evidence.some((x) => x.eventId === e.eventId),
      );
      evidence = [...kept, ...d.evidence];
      omitted += existing.evidenceOmitted;
    }
    if (evidence.length > MAX_STORED_EVIDENCE) {
      const head = evidence.slice(0, 10);
      const tail = evidence.slice(-(MAX_STORED_EVIDENCE - 10));
      omitted += evidence.length - head.length - tail.length;
      evidence = [...head, ...tail];
    }
    const latest = snap.events.get(d.latestEventId);
    const derived = {
      id,
      type: d.type,
      severity,
      status: d.status,
      targetKey: cut(d.target.key, 1024),
      targetSource: cut(d.target.source, 64),
      targetLabel: cut(d.target.label, 512),
      toolEnvironment: cut(d.target.toolEnvironment, 256),
      serviceId: place?.service?.id ?? null,
      serviceName: place?.service?.name ?? null,
      environmentId: place?.environment?.id ?? null,
      environmentName: place?.environment?.name ?? null,
      title: cut(d.title, 512),
      explanation: cut(d.explanation, 4096),
      openingEventId: continuing ? existing.openingEventId : d.openingEventId,
      latestEventId: d.latestEventId,
      resolvedByEventId: d.resolvedByEventId,
      firstSeenAt: continuing ? existing.firstSeenAt : new Date(d.firstSeenAt),
      lastSeenAt: new Date(d.lastSeenAt),
      resolvedAt: d.resolvedAt ? new Date(d.resolvedAt) : null,
      evidence: evidence.map((e) => ({ ...e, summary: cut(e.summary, 1000) })),
      evidenceOmitted: omitted,
      details: {
        ...d.details,
        connectionId: latest?.connectionId ?? null,
        ...(continuing ? { continuedAfterPurge: true } : {}),
      },
    };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(derived, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v)),
      )
      .digest("hex")
      .slice(0, 32);
    return { ...derived, fingerprint };
  }

  /** Service/environment of each finding, by its latest event (AFE-19 mapping). */
  async #resolve(
    tenantId: string,
    snap: Snapshot,
    detected: DetectedFinding[],
  ): Promise<Map<string, PlacementView>> {
    if (!this.ctx.mapping) return new Map();
    const ids = [...new Set(detected.map((d) => d.latestEventId))];
    const records = ids.flatMap((id) => snap.events.get(id) ?? []);
    return this.ctx.mapping.placements(tenantId, records.map(asMappable));
  }

  /** Evaluates every tenant with events, then delivers pending events and alerts. */
  async evaluateAll(): Promise<{ tenants: number; failed: number }> {
    let failed = 0;
    const tenants = await listTenantsWithEvents(this.pool);
    for (const tenantId of tenants) {
      try {
        await this.evaluate(tenantId);
      } catch (err) {
        failed++;
        this.ctx.log.warn({ tenantId, err: errorDetail(err) }, "drift: evaluation failed");
      }
    }
    await this.deliver(null, { alerts: true });
    return { tenants: tenants.length, failed };
  }

  // --- side effects ---------------------------------------------------------

  /**
   * Records pending `drift.finding.*` events and (with `alerts`) sends
   * pending notifications. Each transition is delivered once: the sink is
   * idempotent on (finding, status), and a sent notification is marked.
   */
  async deliver(tenantId: string | null, options: { alerts: boolean }): Promise<void> {
    const pending = await listDriftFindingsPending(this.pool, tenantId, this.#maxNotifyAttempts);
    for (const f of pending) {
      const data = this.#eventData(f);
      try {
        if (!f.openedRecordedAt) {
          await this.ctx.sink.ingest(f.tenantId, driftFindingOpened(data, this.#now()));
          await markDriftFindingRecorded(this.pool, f.tenantId, f.id, "opened", this.#now());
        }
        if (f.status === "resolved" && f.resolvedAt && !f.resolvedRecordedAt) {
          await this.ctx.sink.ingest(
            f.tenantId,
            driftFindingResolved({ ...data, resolvedAt: f.resolvedAt.toISOString() }, this.#now()),
          );
          await markDriftFindingRecorded(this.pool, f.tenantId, f.id, "resolved", this.#now());
        }
      } catch (err) {
        this.ctx.log.warn(
          { tenantId: f.tenantId, findingId: f.id, err: errorDetail(err) },
          "drift: recording a finding event failed; will retry",
        );
        continue;
      }
      if (!options.alerts || !f.alert || f.notifyAttempts >= this.#maxNotifyAttempts) continue;
      const steps: ("opened" | "resolved")[] = [];
      if (!f.openedNotifiedAt) steps.push("opened");
      if (f.status === "resolved" && !f.resolvedNotifiedAt) steps.push("resolved");
      for (const status of steps) {
        try {
          await this.alertSink().send(await this.#notification(f, status));
          await markDriftFindingNotified(this.pool, f.tenantId, f.id, status, this.#now());
        } catch (err) {
          const detail = errorDetail(err);
          await recordDriftNotifyFailure(this.pool, f.tenantId, f.id, detail);
          this.ctx.log.warn(
            { tenantId: f.tenantId, findingId: f.id, err: detail },
            "drift: alert notification failed; will retry",
          );
          break;
        }
      }
    }
  }

  #eventData(f: DriftFindingRecord): DriftFindingEventData {
    return {
      id: f.id,
      type: f.type,
      severity: f.severity as DriftSeverity,
      title: f.title,
      explanation: f.explanation,
      targetKey: f.targetKey,
      targetLabel: f.targetLabel,
      targetSource: f.targetSource,
      toolEnvironment: f.toolEnvironment,
      service: f.serviceId,
      environment: f.environmentId,
      firstSeenAt: f.firstSeenAt.toISOString(),
      resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
      openingEventId: f.openingEventId,
      resolvedByEventId: f.resolvedByEventId,
      evidenceEventIds: f.evidence.map((e) => e.eventId),
    };
  }

  async #notification(
    f: DriftFindingRecord,
    status: "opened" | "resolved",
  ): Promise<AlertNotification> {
    const connectionId = typeof f.details.connectionId === "string" ? f.details.connectionId : "";
    const connection = connectionId
      ? await getConnection(this.pool, f.tenantId, connectionId).catch(() => null)
      : null;
    const base = this.ctx.config.publicUrl ?? "";
    const where = [f.serviceName, f.environmentName].filter(Boolean).join(" / ");
    return {
      status,
      alertId: f.id,
      tenantId: f.tenantId,
      kind: `drift_${f.type}`,
      connectionId,
      connectionName: connection?.name ?? "",
      source: f.targetSource,
      message: cut(
        `[${f.severity}] ${status === "opened" ? "" : "resolved: "}${f.title}${where ? ` (${where})` : ""}: ${f.explanation}`,
        2000,
      ),
      openedAt: f.firstSeenAt.toISOString(),
      resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
      gapId: null,
      blindSince: null,
      drift: {
        findingId: f.id,
        type: f.type,
        severity: f.severity,
        title: f.title,
        targetKey: f.targetKey,
        targetLabel: f.targetLabel,
        service: f.serviceName,
        environment: f.environmentName,
        url: `${base}/drift/${f.id}`,
        evidenceEventIds: f.evidence.map((e) => e.eventId),
      },
    };
  }
}
