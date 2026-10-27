/**
 * The in-cluster agent (AFE-28): lists and watches ArgoCD Applications with
 * a read-only ServiceAccount and sends them, unmapped, to Afe.
 *
 * Three loops run concurrently:
 * - capture: full snapshot (paginated list of every watched namespace, then
 *   a `snapshot_end` with all uids), then a watch per namespace from the
 *   list's resourceVersion. On 410 Gone, on a resync request from Afe, and
 *   after dropped data it lists again (the informer "relist").
 * - sender: takes items from the bounded buffer in batches, signs and POSTs
 *   them, retrying the same batch (same batchId and sequence) until Afe
 *   accepts it; honours 429/Retry-After (Afe's backpressure). A batch Afe
 *   rejects as invalid is dropped and counted.
 * - heartbeat: every N seconds (Afe chooses N), reports counters; the
 *   response may ask for a full snapshot.
 *
 * The agent keeps no state across restarts: a new process gets a new runId
 * and starts with a full snapshot, from which Afe reconciles.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_PATHS,
  AGENT_PROTOCOL_VERSION,
  type AgentHeartbeat,
  type AgentSnapshotEnd,
  type AgentSnapshotItem,
  type AgentWatchItem,
} from "@afe/connector-argocd/agent-protocol";
import type { ArgoCdApplication, ArgoCdKubeEvent } from "@afe/connector-argocd";
import type { AfeClient } from "./afe-client.ts";
import { BoundedBuffer, type BufferedItem } from "./buffer.ts";
import { HttpError } from "./http.ts";
import { KubeError, type KubeClient, type WatchFrame } from "./kube.ts";
import { sanitizeApplication, sanitizeEvents } from "./sanitize.ts";
import { AGENT_VERSION } from "./version.ts";

export interface Logger {
  debug(msg: string, fields?: object): void;
  info(msg: string, fields?: object): void;
  warn(msg: string, fields?: object): void;
  error(msg: string, fields?: object): void;
}

export interface AgentOptions {
  agentId: string;
  kube: KubeClient;
  afe: AfeClient;
  log: Logger;
  /** null = all namespaces. */
  namespaces: string[] | null;
  attributeWithEvents?: boolean;
  bufferMaxItems?: number;
  bufferMaxBytes?: number;
  batchMaxItems?: number;
  batchMaxBytes?: number;
  listPageSize?: number;
  watchTimeoutSeconds?: number;
  /** Initial heartbeat interval until Afe sets one (default 30 s). */
  heartbeatIntervalMs?: number;
  /** Delay after the n-th consecutive failure (default 1 s doubling to 60 s). */
  backoffMs?: (attempt: number) => number;
  now?: () => Date;
  runId?: string;
}

export interface AgentStats {
  runId: string;
  buffered: number;
  inFlight: number;
  droppedTotal: number;
  batchesAccepted: number;
  lastSequenceAccepted: number;
  snapshots: number;
  watchEvents: number;
  watching: boolean;
  lastWatchEventAt?: string;
  lastSnapshotAt?: string;
  lastAfeContactAt?: string;
  heartbeatsOk: number;
  heartbeatsFailed: number;
}

/** A recent operation, deletion or refresh: worth fetching Events for attribution. */
const ATTRIBUTION_RECENT_MS = 15 * 60_000;

const defaultBackoff = (n: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, n - 1));

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Fields whose change may need actor attribution (operation, spec, deletion, refresh). */
function attributionDigest(app: ArgoCdApplication): string {
  return JSON.stringify([
    app.metadata?.generation,
    app.metadata?.deletionTimestamp,
    app.metadata?.annotations?.["argocd.argoproj.io/refresh"],
    !!app.operation,
    app.status?.operationState?.startedAt,
    app.status?.operationState?.phase,
    app.status?.history?.length,
  ]);
}

export class ArgoCdAgent {
  readonly runId: string;
  readonly buffer: BoundedBuffer;
  readonly #o: AgentOptions;
  readonly #now: () => Date;
  readonly #backoff: (n: number) => number;
  #sequence = 0;
  #inflight: { batchId: string; sequence: number; items: BufferedItem[] } | null = null;
  #resync = true;
  #resyncReason = "start";
  #watchAbort: AbortController | null = null;
  #heartbeatMs: number;
  #attribution: boolean;
  #digests = new Map<string, string>();
  #kubernetesVersion: string | undefined;
  readonly stats: AgentStats;

  constructor(options: AgentOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#backoff = options.backoffMs ?? defaultBackoff;
    this.#heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
    this.#attribution = options.attributeWithEvents !== false;
    this.runId = options.runId ?? randomUUID();
    this.buffer = new BoundedBuffer(
      {
        maxItems: options.bufferMaxItems ?? 10_000,
        maxBytes: options.bufferMaxBytes ?? 64 * 1024 * 1024,
      },
      (n) => {
        this.#o.log.warn("buffer full: dropped the oldest observations", {
          dropped: n,
          droppedTotal: this.buffer.dropped,
        });
        this.requestResync("observations were dropped");
      },
    );
    this.stats = {
      runId: this.runId,
      buffered: 0,
      inFlight: 0,
      droppedTotal: 0,
      batchesAccepted: 0,
      lastSequenceAccepted: 0,
      snapshots: 0,
      watchEvents: 0,
      watching: false,
      heartbeatsOk: 0,
      heartbeatsFailed: 0,
    };
  }

  #lastWarn = new Map<string, number>();
  /** Logs a repeating warning at most once a minute. */
  #warnThrottled(msg: string, fields: object): void {
    const now = this.#now().getTime();
    if (now - (this.#lastWarn.get(msg) ?? 0) < 60_000) return;
    this.#lastWarn.set(msg, now);
    this.#o.log.warn(msg, fields);
  }

  /** Current counters (for /metrics and heartbeats). */
  snapshotStats(): AgentStats {
    return {
      ...this.stats,
      buffered: this.buffer.size,
      inFlight: this.#inflight?.items.length ?? 0,
      droppedTotal: this.buffer.dropped,
    };
  }

  /** Lists everything again (after drops, on Afe's request, or on start). */
  requestResync(reason: string): void {
    if (!this.#resync) this.#o.log.info("full snapshot requested", { reason });
    this.#resync = true;
    this.#resyncReason = reason;
    this.#watchAbort?.abort();
  }

  /** Runs until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    try {
      this.#kubernetesVersion = await this.#o.kube.version();
    } catch {
      // optional
    }
    await Promise.all([
      this.#captureLoop(signal),
      this.#senderLoop(signal),
      this.#heartbeatLoop(signal),
    ]);
  }

  #scopes(): (string | null)[] {
    return this.#o.namespaces ?? [null];
  }

  // ---- capture ---------------------------------------------------------------

  async #waitForRoom(signal: AbortSignal): Promise<void> {
    const { maxItems, maxBytes } = this.buffer.limits;
    while (
      !signal.aborted &&
      (this.buffer.size > maxItems / 2 || this.buffer.bytes > maxBytes / 2)
    ) {
      await sleep(100, signal);
    }
  }

  async #eventsFor(app: ArgoCdApplication): Promise<ArgoCdKubeEvent[] | undefined> {
    const ns = app.metadata?.namespace;
    const uid = app.metadata?.uid;
    if (!this.#attribution || !ns || !uid) return undefined;
    try {
      return sanitizeEvents(await this.#o.kube.listApplicationEvents(ns, uid));
    } catch (e) {
      if (e instanceof KubeError && (e.status === 403 || e.status === 401)) {
        this.#attribution = false;
        this.#o.log.warn(
          "cannot read Events (RBAC); continuing without actor attribution from Kubernetes Events",
          { status: e.status },
        );
      }
      return undefined;
    }
  }

  #recent(app: ArgoCdApplication): boolean {
    const started = Date.parse(app.status?.operationState?.startedAt ?? "");
    return (
      !!app.metadata?.deletionTimestamp ||
      !!app.metadata?.annotations?.["argocd.argoproj.io/refresh"] ||
      (Number.isFinite(started) && this.#now().getTime() - started < ATTRIBUTION_RECENT_MS)
    );
  }

  async #snapshot(signal: AbortSignal): Promise<Map<string | null, string>> {
    const snapshotId = randomUUID();
    const listedAt = this.#now().toISOString();
    const droppedTotalAtStart = this.buffer.dropped;
    const uids: string[] = [];
    const rvs = new Map<string | null, string>();
    this.#o.log.info("full snapshot started", { snapshotId, reason: this.#resyncReason });
    for (const scope of this.#scopes()) {
      let cont: string | undefined;
      let rv = "";
      do {
        const page = await this.#o.kube.listApplications(scope, {
          limit: this.#o.listPageSize ?? 250,
          ...(cont ? { continue: cont } : {}),
        });
        rv = page.resourceVersion;
        cont = page.continue;
        for (const raw of page.items) {
          if (signal.aborted) return rvs;
          const uid = raw.metadata?.uid;
          if (!uid) continue;
          await this.#waitForRoom(signal);
          const app = sanitizeApplication(raw);
          const events = this.#recent(app) ? await this.#eventsFor(app) : undefined;
          this.#digests.set(uid, attributionDigest(app));
          const item: AgentSnapshotItem = {
            kind: "snapshot",
            snapshotId,
            observedAt: this.#now().toISOString(),
            application: app,
            ...(events ? { events } : {}),
          };
          this.buffer.push(item);
          uids.push(uid);
        }
      } while (cont && !signal.aborted);
      rvs.set(scope, rv);
    }
    const end: AgentSnapshotEnd = {
      kind: "snapshot_end",
      snapshotId,
      listedAt,
      droppedTotalAtStart,
      uids,
    };
    this.buffer.push(end);
    for (const uid of [...this.#digests.keys()]) if (!uids.includes(uid)) this.#digests.delete(uid);
    this.stats.snapshots++;
    this.stats.lastSnapshotAt = this.#now().toISOString();
    this.#o.log.info("full snapshot queued", { snapshotId, applications: uids.length });
    return rvs;
  }

  async #onWatchFrame(frame: WatchFrame): Promise<void> {
    const raw = frame.object;
    const uid = raw.metadata?.uid;
    if (!uid || frame.type === "BOOKMARK") return;
    const app = sanitizeApplication(raw);
    const digest = attributionDigest(app);
    const changed = this.#digests.get(uid) !== digest;
    if (frame.type === "DELETED") this.#digests.delete(uid);
    else this.#digests.set(uid, digest);
    const events = changed || frame.type === "DELETED" ? await this.#eventsFor(app) : undefined;
    const item: AgentWatchItem = {
      kind: "watch",
      type: frame.type,
      observedAt: this.#now().toISOString(),
      application: app,
      ...(events ? { events } : {}),
    };
    this.buffer.push(item);
    this.stats.watchEvents++;
    this.stats.lastWatchEventAt = item.observedAt;
  }

  async #watchScope(
    scope: string | null,
    rvs: Map<string | null, string>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const stream = this.#o.kube.watchApplications(scope, rvs.get(scope) ?? "", {
        signal,
        timeoutSeconds: this.#o.watchTimeoutSeconds ?? 300,
      });
      for await (const frame of stream) {
        const rv = frame.object.metadata?.resourceVersion;
        if (rv) rvs.set(scope, rv);
        await this.#onWatchFrame(frame);
      }
      // The server ended the watch (timeoutSeconds): resume from the last resourceVersion.
    }
  }

  async #captureLoop(signal: AbortSignal): Promise<void> {
    let rvs: Map<string | null, string> | null = null;
    let attempt = 0;
    while (!signal.aborted) {
      const watchAbort = new AbortController();
      const stop = () => watchAbort.abort();
      signal.addEventListener("abort", stop, { once: true });
      this.#watchAbort = watchAbort;
      try {
        if (this.#resync || !rvs) {
          await this.#waitForRoom(signal);
          this.#resync = false;
          rvs = await this.#snapshot(signal);
        }
        if (this.#resync) continue; // dropped while listing: list again
        this.stats.watching = true;
        const current = rvs;
        await Promise.all(
          this.#scopes().map((s) =>
            this.#watchScope(s, current, watchAbort.signal).catch((e) => {
              watchAbort.abort();
              throw e;
            }),
          ),
        );
        attempt = 0;
      } catch (e) {
        if (signal.aborted) break;
        if (this.#resync && watchAbort.signal.aborted) continue; // resync requested
        if (e instanceof KubeError && e.status === 410) {
          this.#o.log.info("resourceVersion expired; listing again");
          rvs = null;
          continue;
        }
        attempt++;
        this.#o.log.warn("kubernetes API error; retrying", {
          error: e instanceof Error ? e.message : "error",
          attempt,
        });
        await sleep(this.#backoff(attempt), signal);
      } finally {
        this.stats.watching = false;
        signal.removeEventListener("abort", stop);
        this.#watchAbort = null;
      }
    }
  }

  // ---- sending -----------------------------------------------------------------

  #envelope() {
    return {
      protocol: AGENT_PROTOCOL_VERSION,
      agentId: this.#o.agentId,
      runId: this.runId,
      sentAt: this.#now().toISOString(),
      agentVersion: AGENT_VERSION,
      mode: "kubernetes" as const,
      droppedTotal: this.buffer.dropped,
    };
  }

  #batchBody(b: { batchId: string; sequence: number; items: BufferedItem[] }): string {
    const head = JSON.stringify({ ...this.#envelope(), batchId: b.batchId, sequence: b.sequence });
    return `${head.slice(0, -1)},"items":[${b.items.map((i) => i.json).join(",")}]}`;
  }

  async #senderLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      if (!this.#inflight) {
        const items = this.buffer.take(
          this.#o.batchMaxItems ?? 200,
          this.#o.batchMaxBytes ?? 2 * 1024 * 1024,
        );
        if (!items.length) {
          await this.buffer.waitForItems(1000, signal);
          continue;
        }
        this.#inflight = { batchId: randomUUID(), sequence: ++this.#sequence, items };
      }
      const batch = this.#inflight;
      let wait = 0;
      try {
        const res = await this.#o.afe.post(AGENT_PATHS.batches, this.#batchBody(batch));
        if (res.status === 200 || res.status === 202) {
          this.#inflight = null;
          this.stats.batchesAccepted++;
          this.stats.lastSequenceAccepted = batch.sequence;
          this.stats.lastAfeContactAt = this.#now().toISOString();
          attempt = 0;
          continue;
        }
        if (res.status === 401) {
          attempt++;
          this.#o.log.error("Afe rejected the agent's credentials or clock", {
            error: res.body?.error,
            serverTime: res.body?.serverTime,
          });
          wait = Math.max(this.#backoff(attempt), 10_000);
        } else if (res.status === 429 || res.status === 408 || res.status >= 500) {
          attempt++;
          wait = res.retryAfterMs ?? this.#backoff(attempt);
        } else {
          // Afe will never accept this batch (invalid, too large): drop it and say so.
          this.#o.log.error("Afe rejected a batch; its observations are dropped", {
            status: res.status,
            error: res.body?.error,
            message: res.body?.message,
            items: batch.items.length,
          });
          this.#inflight = null;
          this.buffer.countDropped(batch.items.length);
          continue;
        }
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        attempt++;
        wait = this.#backoff(attempt);
        this.#warnThrottled("cannot reach Afe; buffering", { error: e.message, attempt });
      }
      await sleep(wait, signal);
    }
  }

  #heartbeatBody(): string {
    const hb: AgentHeartbeat = {
      ...this.#envelope(),
      heartbeatId: randomUUID(),
      lastSequence: this.stats.lastSequenceAccepted,
      buffered: this.buffer.size + (this.#inflight?.items.length ?? 0),
      watching: this.stats.watching,
      ...(this.stats.lastWatchEventAt ? { lastWatchEventAt: this.stats.lastWatchEventAt } : {}),
      ...(this.stats.lastSnapshotAt ? { lastSnapshotAt: this.stats.lastSnapshotAt } : {}),
      ...(this.#kubernetesVersion ? { kubernetesVersion: this.#kubernetesVersion } : {}),
      ...(this.#o.namespaces ? { namespaces: this.#o.namespaces } : {}),
    };
    return JSON.stringify(hb);
  }

  /** Sends one heartbeat now. Returns false if it failed. */
  async heartbeat(): Promise<boolean> {
    try {
      const res = await this.#o.afe.post(AGENT_PATHS.heartbeat, this.#heartbeatBody());
      if (res.status !== 200) {
        this.stats.heartbeatsFailed++;
        this.#o.log.warn("heartbeat rejected", {
          status: res.status,
          error: res.body?.error,
          serverTime: res.body?.serverTime,
        });
        return false;
      }
      this.stats.heartbeatsOk++;
      this.stats.lastAfeContactAt = this.#now().toISOString();
      const interval = Number(res.body?.heartbeatIntervalSeconds);
      if (Number.isFinite(interval) && interval >= 5 && interval <= 300)
        this.#heartbeatMs = interval * 1000;
      if (res.body?.resync === true) this.requestResync("requested by Afe");
      return true;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      this.stats.heartbeatsFailed++;
      this.#warnThrottled("heartbeat failed: cannot reach Afe", { error: e.message });
      return false;
    }
  }

  async #heartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.heartbeat();
      await sleep(this.#heartbeatMs, signal);
    }
  }
}
