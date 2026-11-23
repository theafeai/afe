/**
 * Correlation service (AFE-20): compute-on-read with a per-tenant cache.
 *
 * For each tenant it keeps the correlation-relevant events of the retention
 * window in memory (a compact projection, `listCorrelationEvents`) and the
 * graph derived from them (`buildCorrelationGraph`: links, conflicts,
 * environment targets with placement history). Events are immutable and a
 * tenant's `seq` order is its commit order (ADR 0008), so a refresh only
 * reads events stored since the last one (`seq > throughSeq`); events that
 * fall out of the retention window are dropped. The graph is recomputed when
 * the window changed, at most every `minRecomputeMs` (responses say which
 * seq they reflect). Nothing is persisted: the derived state is rebuilt from
 * events on demand, so it can never disagree with them. Measurements and the
 * decision against a derived `event_links` table: docs/correlation.md.
 */
import type pg from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { EventAccessRule, RetentionPolicy } from "@afe/core";
import {
  buildCorrelationGraph,
  GapIndex,
  type CorrelationGraph,
  type GraphOptions,
} from "@afe/core/correlation";
import { getLatestSeq, listCorrelationEvents, type CorrelationEventRecord } from "@afe/db";
import { ACCESS_CACHE_TTL_MS, accessFingerprint } from "../auth/access-cache.ts";
import { ScopedSnapshotCache } from "./scoped-cache.ts";

export interface CorrelationServiceOptions {
  /** Clock (tests). Default: `new Date()`. */
  now?: () => Date;
  /**
   * While events keep arriving, recompute a tenant's graph at most this
   * often; in between, responses reflect the previous graph (`asOfSeq`).
   * The interval also grows to twice the last compute time. Default 2000 ms.
   * 0 recomputes whenever something changed (tests).
   */
  minRecomputeMs?: number;
  /** Events kept per tenant; beyond it the oldest are dropped (`truncated`). Default 250 000. */
  maxEvents?: number;
  /** Tenants kept in memory (least recently used evicted). Default 16. */
  maxTenants?: number;
  /** Rows per database read. Default 5000. */
  pageSize?: number;
  /** Linking options (proximity window, pairwise limit). */
  graph?: GraphOptions;
  /**
   * Access-scoped snapshots (managed users) are cached by (tenant, SHA-256 of the
   * sorted rules) for at most this long. Default and maximum: 5 minutes. 0 disables.
   */
  scopedTtlMs?: number;
  /** Scoped snapshots kept per tenant. Default 32. */
  maxScopedPerTenant?: number;
  /** Events held by one tenant's scoped snapshots. Default 250 000. */
  maxScopedEventsPerTenant?: number;
  /** Events held by all scoped snapshots of the process. Default 1 000 000. */
  maxScopedEventsTotal?: number;
}

export interface WindowInfo {
  /** Retention cutoff the window starts at (null: no retention limit). */
  from: string | null;
  to: string;
  /** Events in the window that take part in correlation. */
  events: number;
  /** The newest stored seq the graph reflects. */
  asOfSeq: number;
  /** Newer events exist that the graph does not reflect yet (recompute throttled). */
  stale: boolean;
  /** Oldest events were dropped to stay within `maxEvents`. */
  truncated: boolean;
  computedAt: string;
}

export interface Snapshot {
  graph: CorrelationGraph;
  events: Map<string, CorrelationEventRecord>;
  gaps: GapIndex;
  window: WindowInfo;
  now: Date;
}

interface TenantWindow {
  events: Map<string, CorrelationEventRecord>;
  throughSeq: number;
  cutoff: Date | null;
  truncated: boolean;
  /** Changed since the graph was computed. */
  dirty: boolean;
  snapshot?: Snapshot;
  computedAtMs: number;
  lastComputeMs: number;
  refreshing?: Promise<Snapshot>;
}

export class CorrelationService {
  readonly #tenants = new Map<string, TenantWindow>();
  readonly #now: () => Date;
  readonly #minRecomputeMs: number;
  readonly #maxEvents: number;
  readonly #maxTenants: number;
  readonly #pageSize: number;
  readonly #graphOptions: GraphOptions;
  readonly #scoped: ScopedSnapshotCache<Snapshot>;
  readonly #scopedTtlMs: number;
  readonly #scopedRefreshing = new Map<string, Promise<Snapshot>>();

  constructor(
    readonly pool: pg.Pool,
    readonly retention: RetentionPolicy,
    readonly log: FastifyBaseLogger,
    options: CorrelationServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#minRecomputeMs = options.minRecomputeMs ?? 2000;
    this.#maxEvents = options.maxEvents ?? 250_000;
    this.#maxTenants = options.maxTenants ?? 16;
    this.#pageSize = options.pageSize ?? 5000;
    this.#graphOptions = options.graph ?? {};
    this.#scopedTtlMs = Math.max(
      0,
      Math.min(options.scopedTtlMs ?? ACCESS_CACHE_TTL_MS, ACCESS_CACHE_TTL_MS),
    );
    this.#scoped = new ScopedSnapshotCache<Snapshot>({
      ttlMs: this.#scopedTtlMs,
      maxEntriesPerTenant: options.maxScopedPerTenant ?? 32,
      maxEventsPerTenant: options.maxScopedEventsPerTenant ?? 250_000,
      maxEventsTotal: options.maxScopedEventsTotal ?? 1_000_000,
    });
  }

  /** Drops one access-scoped snapshot (a user's access changed locally). */
  forgetScoped(tenantId: string, fingerprint: string): void {
    this.#scoped.delete(tenantId, fingerprint);
  }

  now(): Date {
    return this.#now();
  }

  /** Drops a tenant's cached window (e.g. tests, or after bulk changes). */
  invalidate(tenantId?: string): void {
    if (tenantId) this.#tenants.delete(tenantId);
    else this.#tenants.clear();
    this.#scoped.clear(tenantId);
  }

  /** The tenant's current snapshot (refreshing the window first). */
  async snapshot(tenantId: string, access?: readonly EventAccessRule[]): Promise<Snapshot> {
    if (access !== undefined) return this.#scopedSnapshot(tenantId, access);
    let w = this.#tenants.get(tenantId);
    if (w) {
      // LRU: most recently used last.
      this.#tenants.delete(tenantId);
      this.#tenants.set(tenantId, w);
    } else {
      w = {
        events: new Map(),
        throughSeq: 0,
        cutoff: null,
        truncated: false,
        dirty: true,
        computedAtMs: 0,
        lastComputeMs: 0,
      };
      this.#tenants.set(tenantId, w);
      while (this.#tenants.size > this.#maxTenants) {
        this.#tenants.delete(this.#tenants.keys().next().value!);
      }
    }
    if (w.refreshing) return w.refreshing;
    const run = this.#refresh(tenantId, w).finally(() => {
      w.refreshing = undefined;
    });
    w.refreshing = run;
    return run;
  }

  /**
   * User views never reuse tenant graphs: filter before linking and deriving any
   * counts. The result is shared only by requests with exactly the same rules in
   * the same tenant, and only while no newer event exists (or, while events keep
   * arriving, for at most `minRecomputeMs`, flagged `stale`).
   */
  async #scopedSnapshot(tenantId: string, access: readonly EventAccessRule[]): Promise<Snapshot> {
    const now = this.#now(),
      cutoff = await this.retention.cutoff(tenantId, now);
    const latest = await getLatestSeq(this.pool, tenantId);
    if (this.#scopedTtlMs === 0 || !access.length)
      return this.#buildScoped(tenantId, access, now, cutoff, latest);
    const fingerprint = accessFingerprint(access);
    const cached = this.#scoped.get(tenantId, fingerprint);
    const cutoffIso = cutoff?.toISOString() ?? null;
    // The retention cutoff moves with the clock; the entry stays valid while no
    // event it holds has fallen out of the window.
    if (
      cached &&
      (cutoffIso === null || !cached.cutoff || cached.cutoff <= cutoffIso) &&
      (cutoffIso === null || cached.oldest === null || cached.oldest >= cutoffIso)
    ) {
      const fresh = cached.latestSeq === latest;
      if (fresh || Date.now() - cached.computedAt < this.#minRecomputeMs) {
        const s = cached.value;
        return {
          ...s,
          now,
          gaps: new GapIndex(s.graph.gaps, now.toISOString()),
          window: { ...s.window, to: now.toISOString(), stale: !fresh },
        };
      }
    }
    const key = JSON.stringify([tenantId, fingerprint, latest]);
    const running = this.#scopedRefreshing.get(key);
    if (running) return running;
    const run = this.#buildScoped(tenantId, access, now, cutoff, latest)
      .then((snapshot) => {
        this.#scoped.set(tenantId, fingerprint, {
          value: snapshot,
          events: snapshot.events.size,
          latestSeq: latest,
          cutoff: cutoffIso,
          oldest: [...snapshot.events.values()].reduce<string | null>(
            (min, e) => (min === null || e.occurredAt < min ? e.occurredAt : min),
            null,
          ),
          computedAt: Date.now(),
        });
        return snapshot;
      })
      .finally(() => this.#scopedRefreshing.delete(key));
    this.#scopedRefreshing.set(key, run);
    return run;
  }

  async #buildScoped(
    tenantId: string,
    access: readonly EventAccessRule[],
    now: Date,
    cutoff: Date | null,
    latest: number,
  ): Promise<Snapshot> {
    let after = 0;
    const records: CorrelationEventRecord[] = [];
    let truncated = false;
    if (access.length)
      for (;;) {
        const page = await listCorrelationEvents(this.pool, tenantId, {
          afterSeq: after,
          throughSeq: latest,
          occurredFrom: cutoff,
          limit: this.#pageSize,
          access,
        });
        records.push(...page);
        if (records.length > this.#maxEvents) {
          records.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
          records.length = this.#maxEvents;
          truncated = true;
        }
        if (page.length < this.#pageSize) break;
        after = page.at(-1)!.seq;
      }
    const visible = truncated
      ? records.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, this.#maxEvents)
      : records;
    const graph = buildCorrelationGraph(visible, this.#graphOptions);
    return {
      graph,
      events: new Map(visible.map((e) => [e.id, e])),
      gaps: new GapIndex(graph.gaps, now.toISOString()),
      now,
      window: {
        from: cutoff?.toISOString() ?? null,
        to: now.toISOString(),
        events: visible.length,
        asOfSeq: visible.reduce((n, e) => Math.max(n, e.seq), 0),
        stale: false,
        truncated,
        computedAt: now.toISOString(),
      },
    };
  }

  async #refresh(tenantId: string, w: TenantWindow): Promise<Snapshot> {
    const now = this.#now();
    const cutoff = await this.retention.cutoff(tenantId, now);
    const latest = await getLatestSeq(this.pool, tenantId);
    if (latest > w.throughSeq) {
      let after = w.throughSeq;
      for (;;) {
        const page = await listCorrelationEvents(this.pool, tenantId, {
          afterSeq: after,
          throughSeq: latest,
          occurredFrom: cutoff,
          limit: this.#pageSize,
        });
        for (const e of page) w.events.set(e.id, e);
        if (page.length > 0) w.dirty = true;
        if (page.length < this.#pageSize) break;
        after = page.at(-1)!.seq;
      }
      w.throughSeq = latest;
    }
    if (cutoff && (!w.cutoff || cutoff > w.cutoff)) {
      const iso = cutoff.toISOString();
      for (const [id, e] of w.events) {
        if (e.occurredAt < iso) {
          w.events.delete(id);
          w.dirty = true;
        }
      }
    }
    w.cutoff = cutoff;
    if (w.events.size > this.#maxEvents) {
      const keep = [...w.events.values()]
        .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
        .slice(0, this.#maxEvents);
      w.events = new Map(keep.map((e) => [e.id, e]));
      w.truncated = true;
      w.dirty = true;
      this.log.warn(
        { tenantId, maxEvents: this.#maxEvents },
        "correlation: window truncated to the newest events",
      );
    }

    // Adaptive throttle: at most every max(minRecomputeMs, 2 × last compute
    // time), so a busy tenant spends at most about a third of a core on it.
    const elapsed = Date.now() - w.computedAtMs;
    const interval =
      this.#minRecomputeMs === 0 ? 0 : Math.max(this.#minRecomputeMs, 2 * w.lastComputeMs);
    if (!w.snapshot || (w.dirty && elapsed >= interval)) {
      const started = Date.now();
      const events = [...w.events.values()];
      const graph = buildCorrelationGraph(events, this.#graphOptions);
      w.dirty = false;
      w.computedAtMs = Date.now();
      const ms = w.computedAtMs - started;
      w.lastComputeMs = ms;
      if (ms > 1000) {
        this.log.info({ tenantId, events: events.length, ms }, "correlation: graph recomputed");
      }
      w.snapshot = {
        graph,
        events: new Map(w.events),
        gaps: new GapIndex(graph.gaps, now.toISOString()),
        now,
        window: {
          from: cutoff ? cutoff.toISOString() : null,
          to: now.toISOString(),
          events: events.length,
          asOfSeq: w.throughSeq,
          stale: false,
          truncated: w.truncated,
          computedAt: new Date(w.computedAtMs).toISOString(),
        },
      };
      return w.snapshot;
    }
    // Reuse the graph; gaps that are still open extend to "now".
    const s = w.snapshot;
    return {
      ...s,
      now,
      gaps: new GapIndex(s.graph.gaps, now.toISOString()),
      window: { ...s.window, to: now.toISOString(), stale: w.dirty },
    };
  }
}
