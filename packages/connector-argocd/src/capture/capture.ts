/**
 * Event capture for one ArgoCD connection (AFE-10): a long-running watch of
 * `/api/v1/stream/applications` (observation method `stream`) plus periodic
 * reconciliation that re-lists applications and diffs them against the stored
 * state (method `reconciliation`), so changes made while the stream was down
 * are still recorded. Both paths go through `observeApplication`, serialised
 * per application by the state store, and produce the same `sourceEventId`s,
 * so an event seen by both is stored once.
 *
 * Connection health (gaps) is not decided here: every success or failure of
 * the stream and of reconciliation is reported through `onObservation`, which
 * the server wires to AFE-13's `reportSuccess` / `reportFailure`.
 */
import {
  EventValidationError,
  type CanonicalEventInputLike,
  type EventSink,
  type ProbeResult,
} from "@afe/core";
import type { ArgoCdClient } from "../client.ts";
import { ArgoCdError } from "../errors.ts";
import type { ArgoCdApplication, ArgoCdApplicationWatchEvent, ArgoCdKubeEvent } from "../types.ts";
import {
  observeApplication,
  observeDeletion,
  type DeletionEvidence,
  type ObserveContext,
  type ObserveResult,
} from "./mapping.ts";
import type { CaptureStateStore } from "./state.ts";

export type CaptureFailureReason = Extract<ProbeResult, { ok: false }>["reason"];

/**
 * Outcome of one attempt to observe the source, for connection health.
 * `via` matches AFE-13's `ObservationVia` ("stream" for the watch, "poll" for
 * reconciliation).
 */
export type CaptureObservation =
  | { ok: true; via: "stream" | "poll"; at: Date }
  | {
      ok: false;
      via: "stream" | "poll";
      at: Date;
      reason: CaptureFailureReason;
      /** Safe to store/log: never contains tokens or response bodies. */
      detail: string;
    };

export interface CaptureLogger {
  warn(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
  debug?(obj: object, msg: string): void;
}

export interface ArgoCdCaptureOptions {
  tenantId: string;
  connectionId: string;
  /**
   * The ArgoCD API client. Optional (AFE-28): without it, the capture only
   * processes observations handed to it (`observe`, `handleWatchEvent`,
   * `reconcileFromSnapshot`), e.g. snapshots sent by the in-cluster agent;
   * `reconcile()` and `watch()` then throw.
   */
  client?: ArgoCdClient;
  /** Set to "agent" when observations arrive from the in-cluster agent (observation.detail). */
  transport?: ObserveContext["transport"];
  sink: EventSink;
  store: CaptureStateStore;
  /** Hook for connection health (AFE-13). Errors thrown by it are logged and ignored. */
  onObservation?: (o: CaptureObservation) => void | Promise<void>;
  /** Fetch Kubernetes Events for actor attribution (default true). */
  attributeWithEvents?: boolean;
  environmentOf?: ObserveContext["environmentOf"];
  log?: CaptureLogger;
  now?: () => Date;
  jobId?: string;
}

/** Per-observation overrides, for observations made elsewhere (the in-cluster agent). */
export interface ObserveOptions {
  /** When the object was observed (default: now). */
  observedAt?: Date;
  /** Kubernetes Events of the application, instead of asking the client. */
  appEvents?: () => Promise<ArgoCdKubeEvent[]>;
}

/** A complete list of the source's applications taken elsewhere (agent full snapshot). */
export interface SnapshotCompletion {
  /** uids of every application in the list. */
  uids: readonly string[];
  /** When the list was taken. Applications last seen after it are never treated as deleted. */
  listedAt: Date;
  /** Evidence text for deletions found by this snapshot. */
  evidence?: string;
}

export interface CaptureCounts {
  applications: number;
  inserted: number;
  duplicates: number;
  invalid: number;
  deletions: number;
}

export interface WatchOptions {
  signal?: AbortSignal;
  /** Stop after this long (ms) even without an abort; for job time slices. */
  durationMs?: number;
  /** Delay before reconnecting after attempt `n` (1-based). Default: 1 s doubling to 60 s. */
  backoffMs?: (attempt: number) => number;
  /** Run a catch-up reconciliation each time the stream (re)opens. Default true. */
  reconcileOnOpen?: boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface WatchSummary {
  connects: number;
  failures: number;
  events: number;
  counts: CaptureCounts;
  lastError?: string;
}

const defaultBackoff = (n: number) => Math.min(60_000, 1000 * 2 ** (n - 1));

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Maps a client error to a connection-health failure reason. */
export function captureFailureReason(err: unknown): CaptureFailureReason {
  if (!(err instanceof ArgoCdError)) return "error";
  switch (err.kind) {
    case "unauthorized":
    case "forbidden":
      return "unauthorized";
    case "rate_limited":
      return "rate_limited";
    case "unreachable":
    case "timeout":
    case "tls":
    case "unsafe_address":
    case "server_error":
      return "unreachable";
    default:
      return "error";
  }
}

const safeDetail = (err: unknown) =>
  err instanceof ArgoCdError ? err.message : "unexpected error while observing ArgoCD";

const emptyCounts = (): CaptureCounts => ({
  applications: 0,
  inserted: 0,
  duplicates: 0,
  invalid: 0,
  deletions: 0,
});

export class ArgoCdCapture {
  readonly #o: ArgoCdCaptureOptions;
  readonly #now: () => Date;
  #baseline: Date | undefined;
  #lastStreamReport = 0;
  #lastCursorSave = 0;
  #cursor: string | undefined;
  #lastEventAt: Date | undefined;

  constructor(options: ArgoCdCaptureOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }

  async #baselineAt(): Promise<Date> {
    if (!this.#baseline) {
      const s = await this.#o.store.initConnectionState(this.#now());
      this.#baseline = new Date(s.baselineAt);
    }
    return this.#baseline;
  }

  async #report(o: CaptureObservation): Promise<void> {
    try {
      await this.#o.onObservation?.(o);
    } catch {
      this.#o.log?.warn(
        { source: "argocd", connectionId: this.#o.connectionId },
        "argocd capture: observation hook failed",
      );
    }
  }

  async #ingest(events: CanonicalEventInputLike[], counts: CaptureCounts): Promise<void> {
    for (const e of events) {
      try {
        const r = await this.#o.sink.ingest(this.#o.tenantId, e);
        if (r.inserted) counts.inserted++;
        else counts.duplicates++;
      } catch (err) {
        if (!(err instanceof EventValidationError)) throw err;
        // A mapping bug: log without payload, do not retry (ingestion contract rule 5).
        counts.invalid++;
        this.#o.log?.warn(
          {
            source: "argocd",
            connectionId: this.#o.connectionId,
            action: e.action,
            sourceEventId: e.sourceEventId,
            issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5),
          },
          "argocd capture: event failed validation",
        );
      }
    }
  }

  #client(): ArgoCdClient {
    if (!this.#o.client) throw new Error("this ArgoCD capture has no API client");
    return this.#o.client;
  }

  async #context(
    method: ObserveContext["method"],
    app: ArgoCdApplication | undefined,
    watchType?: string,
    opts: ObserveOptions = {},
  ): Promise<ObserveContext> {
    const { client } = this.#o;
    const name = app?.metadata?.name;
    const appNamespace = app?.metadata?.namespace;
    return {
      connectionId: this.#o.connectionId,
      method,
      observedAt: opts.observedAt ?? this.#now(),
      baselineAt: await this.#baselineAt(),
      ...(watchType ? { watchType } : {}),
      ...(this.#o.jobId ? { jobId: this.#o.jobId } : {}),
      ...(this.#o.transport ? { transport: this.#o.transport } : {}),
      ...(this.#o.environmentOf ? { environmentOf: this.#o.environmentOf } : {}),
      ...(opts.appEvents
        ? { appEvents: opts.appEvents }
        : this.#o.attributeWithEvents !== false && name && client
          ? {
              appEvents: async () =>
                (
                  await client.listApplicationEvents(name, {
                    ...(appNamespace ? { appNamespace } : {}),
                  })
                ).items ?? [],
            }
          : {}),
    };
  }

  /** Observes one application object (from the stream or a list). */
  async observe(
    app: ArgoCdApplication,
    method: ObserveContext["method"],
    counts: CaptureCounts = emptyCounts(),
    watchType?: string,
    opts: ObserveOptions = {},
  ): Promise<CaptureCounts> {
    const uid = app.metadata?.uid;
    if (!uid) return counts;
    const ctx = await this.#context(method, app, watchType, opts);
    await this.#o.store.withApp(uid, async (prev) => {
      const r: ObserveResult = await observeApplication(prev, app, ctx);
      await this.#ingest(r.events, counts);
      return { next: r.next, result: undefined, persist: r.significant };
    });
    counts.applications++;
    return counts;
  }

  async #observeDeletion(
    uid: string,
    method: ObserveContext["method"],
    ev: DeletionEvidence,
    counts: CaptureCounts,
    watchType?: string,
    opts: ObserveOptions = {},
  ): Promise<void> {
    const ctx = await this.#context(method, undefined, watchType, opts);
    await this.#o.store.withApp(uid, async (prev) => {
      const r = observeDeletion(prev, ctx, ev);
      const before = counts.inserted;
      await this.#ingest(r.events, counts);
      if (counts.inserted > before) counts.deletions++;
      return { next: r.next, result: undefined, persist: true };
    });
  }

  /** Persists the stream resume point (throttled to every 5 s unless `force`). */
  async #saveCursor(force: boolean): Promise<void> {
    const now = this.#now().getTime();
    if (!this.#lastEventAt || (!force && now - this.#lastCursorSave < 5_000)) return;
    this.#lastCursorSave = now;
    await this.#o.store.updateConnectionState({
      ...(this.#cursor ? { resourceVersion: this.#cursor } : {}),
      lastStreamEventAt: this.#lastEventAt.toISOString(),
    });
  }

  /** Handles one watch stream event. */
  async handleWatchEvent(
    evt: ArgoCdApplicationWatchEvent,
    counts: CaptureCounts = emptyCounts(),
    opts: ObserveOptions = {},
  ): Promise<CaptureCounts> {
    const app = evt.application;
    const uid = app?.metadata?.uid;
    if (!uid) return counts;
    if (evt.type === "DELETED") {
      await this.#observeDeletion(
        uid,
        "stream",
        { app, evidence: "watch DELETED event", confidence: "certain" },
        counts,
        "DELETED",
        opts,
      );
    } else if (evt.type === "ADDED" || evt.type === "MODIFIED") {
      await this.observe(app, "stream", counts, evt.type, opts);
    } else {
      return counts;
    }
    const now = this.#now();
    if (app.metadata?.resourceVersion) this.#cursor = app.metadata.resourceVersion;
    this.#lastEventAt = now;
    await this.#saveCursor(false);
    if (now.getTime() - this.#lastStreamReport > 60_000) {
      this.#lastStreamReport = now.getTime();
      await this.#report({ ok: true, via: "stream", at: now });
    }
    return counts;
  }

  /**
   * Re-lists every application and records whatever the stream missed:
   * operations, history entries, spec and status changes, and deletions
   * (an application that is gone from the list and whose GET answers 404/403,
   * or that was replaced by a new object with the same name).
   */
  async reconcile(): Promise<CaptureCounts> {
    const counts = emptyCounts();
    const { store } = this.#o;
    try {
      const client = this.#client();
      await this.#baselineAt();
      const list = await client.listApplications();
      const items = list.items ?? [];
      const seen = new Set<string>();
      for (const app of items) {
        const uid = app.metadata?.uid;
        if (!uid) continue;
        seen.add(uid);
        await this.observe(app, "reconciliation", counts);
      }
      for (const s of await store.listLiveApps()) {
        if (seen.has(s.uid)) continue;
        const ev = await this.#confirmAbsent(s.name, s.appNamespace, s.uid);
        if (ev) await this.#observeDeletion(s.uid, "reconciliation", ev, counts);
      }
      const at = this.#now();
      await store.updateConnectionState({ lastReconciledAt: at.toISOString() });
      await this.#report({ ok: true, via: "poll", at });
      return counts;
    } catch (err) {
      await this.#report({
        ok: false,
        via: "poll",
        at: this.#now(),
        reason: captureFailureReason(err),
        detail: safeDetail(err),
      });
      throw err;
    }
  }

  /**
   * Completes a reconciliation from a full list taken elsewhere (AFE-28: the
   * in-cluster agent's full snapshot, whose items were already passed to
   * `observe(app, "reconciliation")`): every live application that is not in
   * the list and was last seen before the list was taken is recorded as
   * deleted. A Kubernetes list is authoritative for the namespaces it covers,
   * so the deletion is `certain`. Does not report to `onObservation`; the
   * caller decides connection health.
   */
  async reconcileFromSnapshot(snapshot: SnapshotCompletion): Promise<CaptureCounts> {
    const counts = emptyCounts();
    const { store } = this.#o;
    await this.#baselineAt();
    const listed = new Set(snapshot.uids);
    const listedAt = snapshot.listedAt.getTime();
    for (const s of await store.listLiveApps()) {
      if (listed.has(s.uid)) continue;
      const seen = Math.max(Date.parse(s.lastSeenAt) || 0, Date.parse(s.firstSeenAt) || 0);
      if (seen >= listedAt) continue; // appeared after the list was taken
      await this.#observeDeletion(
        s.uid,
        "reconciliation",
        {
          evidence: snapshot.evidence ?? "absent from a complete list of applications",
          confidence: "certain",
        },
        counts,
        undefined,
        { observedAt: snapshot.listedAt },
      );
    }
    await store.updateConnectionState({ lastReconciledAt: snapshot.listedAt.toISOString() });
    return counts;
  }

  async #confirmAbsent(
    name: string,
    appNamespace: string | undefined,
    uid: string,
  ): Promise<DeletionEvidence | undefined> {
    try {
      const app = await this.#client().getApplication(name, {
        ...(appNamespace ? { appNamespace } : {}),
      });
      if (app.metadata?.uid && app.metadata.uid !== uid) {
        return {
          evidence:
            "absent from list; an application with the same name has a different uid (recreated)",
          confidence: "certain",
        };
      }
      return undefined; // still there (list raced with a change)
    } catch (err) {
      if (err instanceof ArgoCdError && err.kind === "not_found") {
        return { evidence: "absent from list; GET returned 404", confidence: "certain" };
      }
      if (err instanceof ArgoCdError && err.kind === "forbidden") {
        // ArgoCD answers 403 for applications that do not exist (no enumeration).
        return {
          evidence: "absent from list; GET returned 403 (ArgoCD's answer for missing applications)",
          confidence: "high",
        };
      }
      return undefined; // cannot tell now; try again next pass
    }
  }

  /**
   * Watches the application stream until `signal` aborts or `durationMs`
   * elapses, reconnecting with backoff and resuming from the last
   * resourceVersion. Each (re)connect starts a catch-up reconciliation, because
   * ArgoCD does not replay changes made while a watch was down.
   */
  async watch(options: WatchOptions = {}): Promise<WatchSummary> {
    const sleep = options.sleep ?? abortableSleep;
    const backoff = options.backoffMs ?? defaultBackoff;
    const controller = new AbortController();
    const stop = () => controller.abort();
    options.signal?.addEventListener("abort", stop, { once: true });
    const timer = options.durationMs ? setTimeout(stop, options.durationMs) : undefined;
    const summary: WatchSummary = { connects: 0, failures: 0, events: 0, counts: emptyCounts() };
    let attempt = 0;
    const pending: Promise<unknown>[] = [];
    try {
      await this.#baselineAt();
      while (!controller.signal.aborted) {
        const state = await this.#o.store.getConnectionState();
        try {
          const stream = this.#client().watchApplications({
            signal: controller.signal,
            ...(state?.resourceVersion ? { resourceVersion: state.resourceVersion } : {}),
            onOpen: () => {
              summary.connects++;
              attempt = 0;
              void this.#report({ ok: true, via: "stream", at: this.#now() });
              this.#lastStreamReport = this.#now().getTime();
              if (options.reconcileOnOpen !== false) {
                pending.push(
                  this.reconcile().then(
                    (c) => addCounts(summary.counts, c),
                    () => undefined, // reported by reconcile()
                  ),
                );
              }
            },
          });
          for await (const evt of stream) {
            summary.events++;
            await this.handleWatchEvent(evt, summary.counts);
          }
          if (controller.signal.aborted) break;
          // The server closed the stream; reconnect (and catch up) right away.
          throw new ArgoCdError("unreachable", "watch stream closed by the server");
        } catch (err) {
          if (controller.signal.aborted) break;
          if (err instanceof ArgoCdError && err.kind === "aborted") break;
          if (!(err instanceof ArgoCdError)) {
            // Not a transport problem (e.g. database down): surface it to the job.
            summary.failures++;
            summary.lastError = "unexpected error";
            throw err;
          }
          summary.failures++;
          summary.lastError = safeDetail(err);
          attempt++;
          await this.#report({
            ok: false,
            via: "stream",
            at: this.#now(),
            reason: captureFailureReason(err),
            detail: safeDetail(err),
          });
          this.#o.log?.warn(
            {
              source: "argocd",
              connectionId: this.#o.connectionId,
              kind: err instanceof ArgoCdError ? err.kind : "error",
              attempt,
            },
            "argocd watch disconnected; reconnecting",
          );
          await sleep(backoff(attempt), controller.signal);
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      await Promise.all(pending);
      await this.#saveCursor(true).catch(() => undefined);
    }
    return summary;
  }
}

function addCounts(into: CaptureCounts, c: CaptureCounts): void {
  into.applications += c.applications;
  into.inserted += c.inserted;
  into.duplicates += c.duplicates;
  into.invalid += c.invalid;
  into.deletions += c.deletions;
}
