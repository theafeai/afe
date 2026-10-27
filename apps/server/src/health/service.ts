/**
 * Connection health service (AFE-13): tracks the health and last successful
 * observation of every connection, records observation gaps as events,
 * schedules probes with backoff, enqueues backfills on recovery and raises
 * alerts when a connection has been blind for too long.
 *
 * Design and rationale: docs/connection-health.md.
 */
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import {
  EventValidationError,
  connectionAlertOpened,
  connectionAlertResolved,
  observationGapClosed,
  observationGapOpened,
  type AlertNotification,
  type AlertSink,
  type CanonicalEventInputLike,
  type Connection,
  type ConnectorHealthHooks,
  type EventSink,
  type HealthFailureReason,
  type HealthReporter,
  type ObservationGapReason,
  type ObservationVia,
  type ProbeResult,
} from "@afe/core";
import {
  addHealthOutboxEntry,
  deleteHealthOutboxEntry,
  getConnection,
  getConnectionHealth,
  listAlertsPendingNotificationAcrossTenants,
  listBlindConnectionsAcrossTenants,
  listConnectionsDueForProbeAcrossTenants,
  listHealthOutbox,
  listHealthOutboxAcrossTenants,
  lockConnectionHealth,
  markAlertNotified,
  openAlert,
  recordAlertNotifyFailure,
  recordSuccessWithoutGap,
  resolveOpenAlerts,
  updateConnectionHealth,
  type AlertRecord,
  type ConnectionHealth,
  type ConnectionHealthPatch,
  type ConnectionHealthState,
  type HealthOutboxEntry,
} from "@afe/db";
import type { JobQueue } from "../jobs.ts";
import { backoffDelayMs, type HealthConfig } from "./config.ts";
import { deterministicId, errorDetail, sanitizeDetail } from "./sanitize.ts";

export const HEALTH_JOBS = {
  PROBE: "health.probe",
  BACKFILL: "health.backfill",
  ALERT_CHECK: "health.alert-check",
} as const;

export const BLIND_ALERT_KIND = "connection_blind";

/** Health state recorded for each failure reason. */
export const STATE_BY_REASON: Record<HealthFailureReason, ConnectionHealthState> = {
  unreachable: "unreachable",
  rate_limited: "rate_limited",
  unauthorized: "unauthorized",
  revoked: "revoked",
  error: "degraded",
};

/** Observation gap reason (event model) for each failure reason. */
export const GAP_REASON_BY_FAILURE: Record<HealthFailureReason, ObservationGapReason> = {
  unreachable: "connection_error",
  rate_limited: "rate_limited",
  unauthorized: "auth_failed",
  revoked: "auth_failed",
  error: "source_unavailable",
};

const AUTH_STATES: ReadonlySet<ConnectionHealthState> = new Set(["unauthorized", "revoked"]);

export interface BackfillJobData {
  tenantId: string;
  connectionId: string;
  gapId: string;
  from: string;
  to: string;
}

export interface ProbeRunSummary {
  probed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  downtimeGaps: number;
}

export interface HealthServiceOptions {
  pool: pg.Pool;
  sink: EventSink;
  jobs: JobQueue;
  log: Pick<FastifyBaseLogger, "warn" | "info" | "error" | "debug">;
  config: HealthConfig;
  /** Connector hooks by source; resolved lazily (modules register in any order). */
  hooks: () => ReadonlyMap<string, ConnectorHealthHooks>;
  alertSink: AlertSink;
  now?: () => Date;
  random?: () => number;
}

const maxDate = (a: Date | null, b: Date): Date => (a && a > b ? a : b);

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type Locked = { connection: Connection; health: ConnectionHealth };

export class HealthService implements HealthReporter {
  alertSink: AlertSink;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(private readonly o: HealthServiceOptions) {
    this.alertSink = o.alertSink;
    this.now = o.now ?? (() => new Date());
    this.random = o.random ?? Math.random;
  }

  get config(): HealthConfig {
    return this.o.config;
  }

  // -------------------------------------------------------------------------
  // HealthReporter (used by connectors and by the probe job)
  // -------------------------------------------------------------------------

  async reportSuccess(
    tenantId: string,
    connectionId: string,
    at: Date = this.now(),
    options: { via?: ObservationVia } = {},
  ): Promise<void> {
    const via = options.via ?? "poll";
    // A webhook or stream proves the source can reach Afe, but not that Afe
    // can call the source's API, so it does not move the probe schedule.
    const pushed = via === "webhook" || via === "stream";
    const nextAttemptAt = pushed ? null : new Date(at.getTime() + this.o.config.probeIntervalMs);

    // Common case (no gap open): a single statement, no lock held.
    if (await recordSuccessWithoutGap(this.o.pool, tenantId, connectionId, at, nextAttemptAt)) {
      return;
    }

    let resolved: AlertRecord[] = [];
    let connection: Connection | null = null;
    await this.withLock(tenantId, connectionId, async (client, { connection: c, health: h }) => {
      connection = c;
      const base: ConnectionHealthPatch = {
        lastSuccessAt: maxDate(h.lastSuccessAt, at),
        lastAttemptAt: maxDate(h.lastAttemptAt, at),
      };
      if (!h.openGapId || !h.openGapStartedAt) {
        // Gap closed concurrently: same as the fast path.
        await updateConnectionHealth(client, tenantId, connectionId, {
          ...base,
          state: "healthy",
          consecutiveFailures: 0,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
        });
        return;
      }
      if (pushed && AUTH_STATES.has(h.state)) {
        // Webhooks still arrive but Afe's credentials are revoked: polling and
        // backfill cannot work, so the gap stays open until a probe/poll succeeds.
        await updateConnectionHealth(client, tenantId, connectionId, base);
        return;
      }
      if (h.lastFailureAt && at <= h.lastFailureAt) {
        // Older than the latest failure (out-of-order report): not a recovery.
        await updateConnectionHealth(client, tenantId, connectionId, base);
        return;
      }

      const gapId = h.openGapId;
      const startedAt = h.openGapStartedAt;
      const endedAt = at < startedAt ? startedAt : at;
      const detail = sanitizeDetail(
        `recovered after ${h.consecutiveFailures} failed attempt(s)` +
          (h.lastError ? `; last error: ${h.lastError}` : ""),
      );
      await this.outboxEvent(
        client,
        tenantId,
        connectionId,
        observationGapClosed({
          gapId,
          connectionId,
          source: c.source,
          connectionName: c.name,
          startedAt,
          endedAt,
          reason: (h.openGapReason ?? "unknown") as ObservationGapReason,
          ...(detail ? { detail } : {}),
          observedAt: this.now(),
        }),
      );
      const job: BackfillJobData = {
        tenantId,
        connectionId,
        gapId,
        from: startedAt.toISOString(),
        to: endedAt.toISOString(),
      };
      await this.outboxJob(client, tenantId, connectionId, HEALTH_JOBS.BACKFILL, job, gapId);

      resolved = await resolveOpenAlerts(client, tenantId, connectionId, at);
      for (const alert of resolved) {
        const n = this.notification(alert, c, "resolved");
        await this.outboxEvent(
          client,
          tenantId,
          connectionId,
          connectionAlertResolved({ ...n, resolvedAt: n.resolvedAt! }, this.now()),
        );
      }

      await updateConnectionHealth(client, tenantId, connectionId, {
        ...base,
        state: "healthy",
        consecutiveFailures: 0,
        nextAttemptAt: nextAttemptAt ?? new Date(at.getTime() + this.o.config.probeIntervalMs),
        openGapId: null,
        openGapStartedAt: null,
        openGapReason: null,
        alertedAt: null,
        lastBackfillGapId: gapId,
        lastBackfillStatus: "pending",
        lastBackfillAt: null,
        lastBackfillError: null,
      });
      this.o.log.info(
        { tenantId, connectionId, source: c.source, gapId },
        "connection recovered; observation gap closed",
      );
    });
    if (connection && resolved.length > 0) await this.deliverNotifications(resolved);
  }

  async reportFailure(
    tenantId: string,
    connectionId: string,
    reason: HealthFailureReason,
    detail?: string,
    retryAfter?: Date,
    at: Date = this.now(),
  ): Promise<void> {
    if (!(reason in STATE_BY_REASON)) throw new Error(`unknown failure reason ${String(reason)}`);
    const safeDetail = sanitizeDetail(detail);
    await this.withLock(tenantId, connectionId, async (client, { connection: c, health: h }) => {
      if (!h.openGapId && h.lastSuccessAt && at <= h.lastSuccessAt) {
        // A failure older than a known success (out-of-order report): keep the
        // error for diagnosis but do not open a gap.
        await updateConnectionHealth(client, tenantId, connectionId, {
          lastFailureAt: maxDate(h.lastFailureAt, at),
          lastErrorReason: reason,
          lastError: safeDetail,
        });
        return;
      }
      const failures = h.consecutiveFailures + 1;
      const patch: ConnectionHealthPatch = {
        state: STATE_BY_REASON[reason],
        lastAttemptAt: maxDate(h.lastAttemptAt, at),
        lastFailureAt: maxDate(h.lastFailureAt, at),
        lastErrorReason: reason,
        lastError: safeDetail,
        consecutiveFailures: failures,
        nextAttemptAt: this.nextAttemptAfterFailure(reason, failures, at, retryAfter),
      };
      if (!h.openGapId) {
        // The gap starts at the last successful observation, not at this
        // failure: anything that happened in between may not have been seen.
        let startedAt = h.lastSuccessAt ?? c.createdAt;
        if (startedAt > at) startedAt = at;
        const gapId = deterministicId("gap", tenantId, connectionId, startedAt.toISOString());
        const gapReason = GAP_REASON_BY_FAILURE[reason];
        await this.outboxEvent(
          client,
          tenantId,
          connectionId,
          observationGapOpened({
            gapId,
            connectionId,
            source: c.source,
            connectionName: c.name,
            startedAt,
            reason: gapReason,
            ...(safeDetail ? { detail: safeDetail } : {}),
            observedAt: this.now(),
          }),
        );
        patch.openGapId = gapId;
        patch.openGapStartedAt = startedAt;
        patch.openGapReason = gapReason;
        this.o.log.warn(
          { tenantId, connectionId, source: c.source, gapId, reason },
          "connection observation failed; observation gap opened",
        );
      }
      await updateConnectionHealth(client, tenantId, connectionId, patch);
    });
  }

  async canAttempt(tenantId: string, connectionId: string, at: Date = this.now()) {
    const row = await getConnectionHealth(this.o.pool, tenantId, connectionId);
    const h = row?.health;
    if (!h || !h.openGapId || !h.nextAttemptAt) return true;
    return h.nextAttemptAt <= at;
  }

  /** When to try again after the `failures`-th consecutive failure. */
  nextAttemptAfterFailure(
    reason: HealthFailureReason,
    failures: number,
    at: Date,
    retryAfter?: Date,
  ): Date {
    const c = this.o.config;
    const delay =
      reason === "unauthorized" || reason === "revoked"
        ? c.authRetryIntervalMs
        : backoffDelayMs(failures, c, this.random());
    let next = at.getTime() + delay;
    if (retryAfter && Number.isFinite(retryAfter.getTime())) {
      next = Math.max(next, Math.min(retryAfter.getTime(), at.getTime() + c.maxRetryAfterMs));
    }
    return new Date(next);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /** health.probe: probes every active connection that is due. */
  async probeDue(): Promise<ProbeRunSummary> {
    await this.flushAllOutbox();
    const summary: ProbeRunSummary = {
      probed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      downtimeGaps: 0,
    };
    const hooks = this.o.hooks();
    const due = await listConnectionsDueForProbeAcrossTenants(this.o.pool, this.now());
    const queue = [...due];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const { connection, health } = item;
        const hook = hooks.get(connection.source);
        if (!hook) {
          summary.skipped += 1;
          continue;
        }
        try {
          if (await this.recordAfeDowntimeIfAny(connection, health)) summary.downtimeGaps += 1;
          const result = await timeout(hook.probe(connection), this.o.config.probeTimeoutMs).catch(
            (err: unknown): ProbeResult => ({
              ok: false,
              reason: /timed out/.test(String(err)) ? "unreachable" : "error",
              detail: `probe failed: ${errorDetail(err)}`,
            }),
          );
          summary.probed += 1;
          const at = this.now();
          if (result.ok) {
            summary.succeeded += 1;
            await this.reportSuccess(connection.tenantId, connection.id, at, { via: "probe" });
          } else {
            summary.failed += 1;
            await this.reportFailure(
              connection.tenantId,
              connection.id,
              result.reason,
              result.detail,
              result.retryAfter,
              at,
            );
          }
        } catch (err) {
          this.o.log.error(
            { tenantId: connection.tenantId, connectionId: connection.id, err: errorDetail(err) },
            "health probe bookkeeping failed",
          );
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return summary;
  }

  /**
   * If a healthy connection has not been attempted for longer than the
   * downtime threshold, Afe itself was not observing it (Afe down, workers
   * stopped). Records that window as an `afe_unavailable` gap (opened and
   * closed at once) and enqueues a backfill for it.
   */
  async recordAfeDowntimeIfAny(
    connection: Connection,
    health: ConnectionHealth | null,
  ): Promise<boolean> {
    const now = this.now();
    const threshold = now.getTime() - this.o.config.downtimeThresholdMs;
    const quiet = (h: ConnectionHealth | null) =>
      !!h && !h.openGapId && !!h.lastAttemptAt && h.lastAttemptAt.getTime() < threshold;
    if (!quiet(health)) return false;
    const { tenantId, id: connectionId } = connection;
    let recorded = false;
    await this.withLock(tenantId, connectionId, async (client, { connection: c, health: h }) => {
      if (!quiet(h)) return;
      const startedAt = h.lastSuccessAt ?? h.lastAttemptAt!;
      const gapId = deterministicId(
        "gap",
        "afe_unavailable",
        tenantId,
        connectionId,
        startedAt.toISOString(),
      );
      const params = {
        gapId,
        connectionId,
        source: c.source,
        connectionName: c.name,
        startedAt,
        reason: "afe_unavailable" as const,
        detail: "Afe was not observing this connection (Afe or its workers were not running)",
        observedAt: now,
      };
      await this.outboxEvent(client, tenantId, connectionId, observationGapOpened(params));
      await this.outboxEvent(
        client,
        tenantId,
        connectionId,
        observationGapClosed({ ...params, endedAt: now }),
      );
      const job: BackfillJobData = {
        tenantId,
        connectionId,
        gapId,
        from: startedAt.toISOString(),
        to: now.toISOString(),
      };
      await this.outboxJob(client, tenantId, connectionId, HEALTH_JOBS.BACKFILL, job, gapId);
      await updateConnectionHealth(client, tenantId, connectionId, {
        lastAttemptAt: now,
        lastBackfillGapId: gapId,
        lastBackfillStatus: "pending",
        lastBackfillAt: null,
        lastBackfillError: null,
      });
      recorded = true;
      this.o.log.warn(
        { tenantId, connectionId, source: c.source, gapId },
        "Afe was not observing this connection; recorded an afe_unavailable gap",
      );
    });
    return recorded;
  }

  /** health.backfill: re-observes the source for a closed gap's window. */
  async runBackfill(data: BackfillJobData): Promise<void> {
    const from = new Date(data.from);
    const to = new Date(data.to);
    if (!data.tenantId || !data.connectionId || !data.gapId || isNaN(+from) || isNaN(+to)) {
      this.o.log.error({ job: HEALTH_JOBS.BACKFILL }, "invalid backfill job payload; dropped");
      return;
    }
    const connection = await getConnection(this.o.pool, data.tenantId, data.connectionId);
    if (!connection) return;
    const hook = this.o.hooks().get(connection.source);
    if (!hook?.backfill) {
      await this.setBackfillStatus(data, { lastBackfillStatus: "unsupported" });
      return;
    }
    try {
      await hook.backfill(connection, from, to);
    } catch (err) {
      await this.setBackfillStatus(data, {
        lastBackfillStatus: "failed",
        lastBackfillAt: this.now(),
        lastBackfillError: errorDetail(err),
      });
      throw err; // let the queue retry with backoff
    }
    await this.setBackfillStatus(data, {
      lastBackfillStatus: "succeeded",
      lastBackfillAt: this.now(),
      lastBackfillError: null,
    });
  }

  /**
   * health.alert-check: raises a `connection_blind` alert for every connection
   * whose open gap is older than the threshold, then (re)delivers pending
   * alert notifications.
   */
  async checkAlerts(): Promise<{ opened: number }> {
    const now = this.now();
    const before = new Date(now.getTime() - this.o.config.alertAfterMs);
    const blind = await listBlindConnectionsAcrossTenants(this.o.pool, before);
    let opened = 0;
    for (const { connection } of blind) {
      const { tenantId, id: connectionId } = connection;
      await this.withLock(tenantId, connectionId, async (client, { connection: c, health: h }) => {
        if (!h.openGapId || !h.openGapStartedAt || h.alertedAt || h.openGapStartedAt > before) {
          return;
        }
        const minutes = Math.round((now.getTime() - h.openGapStartedAt.getTime()) / 60_000);
        const message =
          `${c.name} (${c.source}) has not been observed for ${minutes} min, since ` +
          `${h.openGapStartedAt.toISOString()} (${h.openGapReason ?? "unknown"}, state ${h.state}); ` +
          "events from this period may be missing until it recovers.";
        const alert = await openAlert(client, tenantId, {
          id: deterministicId("alert", BLIND_ALERT_KIND, tenantId, connectionId, h.openGapId),
          connectionId,
          kind: BLIND_ALERT_KIND,
          gapId: h.openGapId,
          blindSince: h.openGapStartedAt,
          message,
          openedAt: now,
        });
        if (alert) {
          await this.outboxEvent(
            client,
            tenantId,
            connectionId,
            connectionAlertOpened(this.notification(alert, c, "opened"), now),
          );
          opened += 1;
        }
        await updateConnectionHealth(client, tenantId, connectionId, { alertedAt: now });
      });
    }
    await this.deliverNotifications();
    return { opened };
  }

  /**
   * Delivers alert notifications through the AlertSink: the given alerts, or
   * every pending one. Failures are recorded and retried by the next
   * alert-check run, up to `maxNotifyAttempts`.
   */
  async deliverNotifications(only?: AlertRecord[]): Promise<void> {
    const pending =
      only ??
      (await listAlertsPendingNotificationAcrossTenants(
        this.o.pool,
        this.o.config.maxNotifyAttempts,
      ));
    for (const alert of pending) {
      const connection = await getConnection(this.o.pool, alert.tenantId, alert.connectionId);
      if (!connection) continue;
      const steps: ("opened" | "resolved")[] = [];
      if (!alert.openedNotifiedAt) steps.push("opened");
      if (alert.resolvedAt && !alert.resolvedNotifiedAt) steps.push("resolved");
      for (const status of steps) {
        try {
          await this.alertSink.send(this.notification(alert, connection, status));
          await markAlertNotified(this.o.pool, alert.tenantId, alert.id, status, this.now());
        } catch (err) {
          const detail = errorDetail(err);
          await recordAlertNotifyFailure(this.o.pool, alert.tenantId, alert.id, detail);
          this.o.log.warn(
            { tenantId: alert.tenantId, alertId: alert.id, err: detail },
            "alert notification failed; will retry",
          );
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------------

  /** Delivers outbox entries (one connection's, or all) after commit. */
  async flushOutbox(tenantId: string, connectionId: string): Promise<void> {
    await this.deliverOutbox(await listHealthOutbox(this.o.pool, tenantId, connectionId));
  }

  async flushAllOutbox(): Promise<void> {
    await this.deliverOutbox(await listHealthOutboxAcrossTenants(this.o.pool));
  }

  private async deliverOutbox(entries: HealthOutboxEntry[]): Promise<void> {
    const blocked = new Set<string>();
    for (const e of entries) {
      const key = `${e.tenantId}/${e.connectionId}`;
      if (blocked.has(key)) continue; // keep per-connection order
      try {
        if (e.kind === "event") {
          await this.o.sink.ingest(e.tenantId, e.payload.input as CanonicalEventInputLike);
        } else {
          const { name, data, singletonKey } = e.payload as {
            name: string;
            data: object;
            singletonKey?: string;
          };
          await this.o.jobs.send(name, data, singletonKey ? { singletonKey } : {});
        }
      } catch (err) {
        if (err instanceof EventValidationError) {
          // A bug, not a transient failure: do not block the outbox forever.
          this.o.log.error(
            { tenantId: e.tenantId, connectionId: e.connectionId, err: err.message },
            "health event rejected by validation; dropped",
          );
        } else {
          blocked.add(key);
          this.o.log.warn(
            { tenantId: e.tenantId, connectionId: e.connectionId, err: errorDetail(err) },
            "health outbox delivery failed; will retry",
          );
          continue;
        }
      }
      await deleteHealthOutboxEntry(this.o.pool, e.tenantId, e.id);
    }
  }

  private outboxEvent(
    client: pg.PoolClient,
    tenantId: string,
    connectionId: string,
    input: CanonicalEventInputLike,
  ) {
    return addHealthOutboxEntry(client, tenantId, connectionId, "event", { input });
  }

  private outboxJob(
    client: pg.PoolClient,
    tenantId: string,
    connectionId: string,
    name: string,
    data: object,
    key: string,
  ) {
    return addHealthOutboxEntry(client, tenantId, connectionId, "job", {
      name,
      data,
      singletonKey: `${name}:${key}`,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Runs `fn` in a transaction holding the connection's health row lock, then
   * delivers the outbox entries it wrote. The lock holder never needs a second
   * pool connection, so concurrent reports cannot exhaust the pool.
   */
  private async withLock(
    tenantId: string,
    connectionId: string,
    fn: (client: pg.PoolClient, locked: Locked) => Promise<void>,
  ): Promise<void> {
    const client = await this.o.pool.connect();
    let found = false;
    try {
      await client.query("BEGIN");
      const locked = await lockConnectionHealth(client, tenantId, connectionId);
      if (locked) {
        found = true;
        await fn(client, locked);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (!found) {
      this.o.log.warn({ tenantId, connectionId }, "health report for unknown connection ignored");
      return;
    }
    await this.flushOutbox(tenantId, connectionId);
  }

  private async setBackfillStatus(data: BackfillJobData, patch: ConnectionHealthPatch) {
    await this.withLock(data.tenantId, data.connectionId, async (client, { health }) => {
      if (health.lastBackfillGapId !== data.gapId) return; // superseded by a newer gap
      await updateConnectionHealth(client, data.tenantId, data.connectionId, patch);
    });
  }

  notification(
    alert: AlertRecord,
    connection: Connection,
    status: "opened" | "resolved",
  ): AlertNotification {
    return {
      status,
      alertId: alert.id,
      tenantId: alert.tenantId,
      kind: alert.kind,
      connectionId: alert.connectionId,
      connectionName: connection.name,
      source: connection.source,
      message: alert.message,
      openedAt: alert.openedAt.toISOString(),
      resolvedAt: alert.resolvedAt ? alert.resolvedAt.toISOString() : null,
      gapId: alert.gapId,
      blindSince: alert.blindSince ? alert.blindSince.toISOString() : null,
    };
  }
}
