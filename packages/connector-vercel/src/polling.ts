/**
 * Polling, reconciliation and backfill of Vercel deployments (AFE-12).
 *
 * Every pass:
 * 1. backfills projects not backfilled yet (first connect, or newly selected
 *    projects), `observation.method = "backfill"`;
 * 2. lists deployments created since `cursor - overlap` and records their
 *    `created` and final-state events, `method = "reconciliation"` (polling is
 *    the safety net for webhooks: anything it finds first was missed or late);
 * 3. re-reads deployments still open from earlier passes;
 * 4. compares each project's production deployment with the last one seen,
 *    recording promotions and rollbacks (inferred ones flagged in `data`).
 *
 * Transitions younger than `settleMs` are left to the next pass so a webhook
 * on its way normally wins (first stored wins, ADR 0003).
 */
import type { EventSink } from "@afe/core";
import {
  type OpenDeployment,
  type VercelCaptureStore,
  type VercelPollState,
  isNotFound,
  observeProduction,
} from "./capture.ts";
import {
  type DeploymentInfo,
  type Provenance,
  type VercelProjectLink,
  lifecycleEvent,
  normalizeDeployment,
  terminalTime,
  terminalTransition,
} from "./mapping.ts";
import {
  type ProjectSelection,
  type ScopedVercelReader,
  NO_PROJECTS,
  ProjectNotSelectedError,
} from "./selection.ts";
import type { ObservationMethod } from "@afe/core";
import type { VercelProject } from "./types.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface VercelPollerOptions {
  reader: ScopedVercelReader;
  sink: EventSink;
  store: VercelCaptureStore;
  tenantId: string;
  connectionId: string;
  now?: () => number;
  /** Re-read this much before the cursor each pass. Default 10 minutes. */
  overlapMs?: number;
  /** Leave transitions younger than this to the next pass. Default 60 s. */
  settleMs?: number;
  /** History imported on first connect. Default 30 days. */
  backfillDays?: number;
  /** Upper bound on pages per listing (100 deployments per page). Default 200. */
  maxPages?: number;
  /** Open deployments older than this are dropped. Default 24 h. */
  openMaxAgeMs?: number;
  /** At most this many open deployments are tracked. Default 500. */
  maxOpen?: number;
  jobId?: string | null;
}

export interface PollResult {
  windows: { method: ObservationMethod; scope: string; from: number; to: number }[];
  deploymentsSeen: number;
  inserted: number;
  duplicates: number;
  productionChanges: number;
  deferred: number;
  /** A listing hit `maxPages`; older deployments of that window were not read. */
  truncated: boolean;
  droppedOpen: number;
}

function emptyResult(): PollResult {
  return {
    windows: [],
    deploymentsSeen: 0,
    inserted: 0,
    duplicates: 0,
    productionChanges: 0,
    deferred: 0,
    truncated: false,
    droppedOpen: 0,
  };
}

export class VercelPoller {
  readonly #o: Required<Omit<VercelPollerOptions, "jobId">> & { jobId: string | null };

  constructor(options: VercelPollerOptions) {
    this.#o = {
      now: Date.now,
      overlapMs: 10 * MINUTE,
      settleMs: MINUTE,
      backfillDays: 30,
      maxPages: 200,
      openMaxAgeMs: DAY,
      maxOpen: 500,
      ...options,
      jobId: options.jobId ?? null,
    };
  }

  /** One scheduled pass. State is saved only if the whole pass succeeds. */
  async poll(): Promise<PollResult> {
    const o = this.#o;
    const now = o.now();
    const state: VercelPollState = (await o.store.loadPollState()) ?? {
      cursor: null,
      openDeployments: [],
      backfilled: NO_PROJECTS,
    };
    const selection = o.reader.projectSelection;
    const result = emptyResult();
    const pass = new Pass(this.#o, now, result, state.openDeployments);
    const links = await this.#projectLinks();

    // 1. Backfill what has not been backfilled.
    const { scopes: backfillScopes, backfilled } = backfillPlan(selection, state.backfilled);
    for (const scope of backfillScopes) {
      await pass.window(scope, now - o.backfillDays * DAY, now, "backfill", links.map);
    }
    // 2. Regular window for everything else.
    if (state.cursor !== null) {
      for (const scope of scopesOf(selection)) {
        if (backfillScopes.includes(scope)) continue;
        await pass.window(scope, state.cursor - o.overlapMs, now, "reconciliation", links.map);
      }
    }
    // 3. Open deployments outside the window.
    await pass.recheckOpen(links.map);
    // 4. Production deployments.
    await pass.production(links.projects);

    await o.store.savePollState(
      {
        cursor: selection.mode === "none" && state.cursor === null ? null : now - o.settleMs,
        openDeployments: pass.openList(),
        backfilled,
      },
      now,
    );
    return result;
  }

  /**
   * Re-observes `[from, to]` after an observation gap (AFE-13 `backfill`
   * hook): deployments created in the range, open deployments and current
   * production. Events found are `reconciliation`. The poll cursor is not moved.
   */
  async reconcile(from: Date, to: Date): Promise<PollResult> {
    const o = this.#o;
    const now = o.now();
    const state = await o.store.loadPollState();
    const result = emptyResult();
    const pass = new Pass(this.#o, now, result, state?.openDeployments ?? []);
    const links = await this.#projectLinks();
    const until = Math.min(to.getTime(), now);
    for (const scope of scopesOf(o.reader.projectSelection)) {
      await pass.window(scope, from.getTime() - o.overlapMs, until, "reconciliation", links.map);
    }
    await pass.recheckOpen(links.map);
    await pass.production(links.projects);
    if (state) await o.store.savePollState({ ...state, openDeployments: pass.openList() }, now);
    return result;
  }

  async #projectLinks(): Promise<{
    projects: VercelProject[];
    map: Map<string, VercelProjectLink | null>;
  }> {
    const projects = await this.#o.reader.listSelectedProjects();
    return { projects, map: new Map(projects.map((p) => [p.id, p.link ?? null])) };
  }
}

/** `null` = the whole team (selection "all"); otherwise one request per selected project. */
function scopesOf(selection: ProjectSelection): (string | null)[] {
  if (selection.mode === "all") return [null];
  if (selection.mode === "selected") return [...selection.projectIds];
  return [];
}

export function backfillPlan(
  selection: ProjectSelection,
  done: ProjectSelection,
): { scopes: (string | null)[]; backfilled: ProjectSelection } {
  if (selection.mode === "none") return { scopes: [], backfilled: done };
  if (selection.mode === "all") {
    return done.mode === "all"
      ? { scopes: [], backfilled: done }
      : { scopes: [null], backfilled: { mode: "all" } };
  }
  if (done.mode === "all") return { scopes: [], backfilled: done };
  const doneIds = done.mode === "selected" ? done.projectIds : [];
  const missing = selection.projectIds.filter((id) => !doneIds.includes(id));
  return {
    scopes: missing,
    backfilled:
      missing.length === 0
        ? done
        : { mode: "selected", projectIds: [...new Set([...doneIds, ...missing])] },
  };
}

class Pass {
  readonly #seen = new Set<string>();
  readonly #open = new Map<string, OpenDeployment>();

  constructor(
    private readonly o: PollerConfig,
    private readonly now: number,
    private readonly result: PollResult,
    open: OpenDeployment[],
  ) {
    for (const d of open) this.#open.set(d.id, d);
  }

  #provenance(method: ObservationMethod): Provenance {
    return {
      method,
      observedAt: new Date(this.now),
      connectionId: this.o.connectionId,
      jobId: this.o.jobId,
      detail: method === "reconciliation" ? "found by Vercel deployments poll" : null,
    };
  }

  async window(
    scope: string | null,
    since: number,
    until: number,
    method: ObservationMethod,
    links: Map<string, VercelProjectLink | null>,
  ): Promise<void> {
    this.result.windows.push({ method, scope: scope ?? "*", from: since, to: until });
    let cursor: number | undefined = until;
    for (let page = 0; ; page++) {
      if (page >= this.o.maxPages) {
        this.result.truncated = true;
        return;
      }
      let res;
      try {
        res = await this.o.reader.listDeploymentsPage(scope, { since, until: cursor });
      } catch (err) {
        if (err instanceof ProjectNotSelectedError) return;
        throw err;
      }
      for (const item of res.deployments) {
        const info = normalizeDeployment(item, links.get(item.projectId ?? scope ?? "") ?? null);
        if (!info.projectId && scope) info.projectId = scope;
        await this.deployment(info, item, method);
      }
      if (res.next === null) return;
      cursor = res.next;
    }
  }

  /** Records the transitions of one deployment that are old enough. */
  async deployment(d: DeploymentInfo, raw: unknown, method: ObservationMethod): Promise<void> {
    if (!d.id || this.#seen.has(d.id)) return;
    this.#seen.add(d.id);
    this.result.deploymentsSeen++;
    const settledBefore = this.now - this.o.settleMs;
    const provenance = this.#provenance(method);
    let deferred = false;

    if (d.createdAt !== null && d.createdAt > settledBefore) {
      deferred = true;
    } else {
      await this.#ingest(lifecycleEvent(d, { transition: "created", provenance, raw }));
    }
    const terminal = terminalTransition(d.state);
    if (terminal && !deferred) {
      const t = terminalTime(d) ?? d.createdAt;
      if (t !== null && t > settledBefore) {
        deferred = true;
      } else {
        await this.#ingest(lifecycleEvent(d, { transition: terminal, provenance, raw }));
      }
    }
    if ((!terminal || deferred) && d.projectId && d.createdAt !== null) {
      this.#open.set(d.id, { id: d.id, projectId: d.projectId, createdAt: d.createdAt });
    } else {
      this.#open.delete(d.id);
    }
    if (deferred) this.result.deferred++;
  }

  async recheckOpen(links: Map<string, VercelProjectLink | null>): Promise<void> {
    for (const entry of [...this.#open.values()]) {
      if (this.#seen.has(entry.id)) continue;
      if (entry.createdAt < this.now - this.o.openMaxAgeMs) {
        this.#open.delete(entry.id);
        this.result.droppedOpen++;
        continue;
      }
      try {
        const d = await this.o.reader.getDeployment(entry.id, entry.projectId);
        await this.deployment(
          normalizeDeployment(d, links.get(entry.projectId) ?? null),
          d,
          "reconciliation",
        );
      } catch (err) {
        if (err instanceof ProjectNotSelectedError || isNotFound(err)) {
          this.#open.delete(entry.id);
          continue;
        }
        throw err;
      }
    }
  }

  async production(projects: VercelProject[]): Promise<void> {
    for (const listed of projects) {
      let project = listed;
      if (listed.targets === undefined) {
        try {
          project = await this.o.reader.getProject(listed.id);
        } catch (err) {
          if (err instanceof ProjectNotSelectedError || isNotFound(err)) continue;
          throw err;
        }
      }
      const live = project.targets?.production;
      if (!live?.id) continue;
      const current = normalizeDeployment(
        { ...live, projectId: project.id, name: live.name ?? project.name },
        project.link ?? null,
      );
      const result = await observeProduction({
        store: this.o.store,
        sink: this.o.sink,
        tenantId: this.o.tenantId,
        projectId: project.id,
        current,
        aliasRequest: project.lastAliasRequest ?? null,
        provenance: this.#provenance("reconciliation"),
        raw: {
          project: { id: project.id, lastAliasRequest: project.lastAliasRequest ?? null },
          production: live,
        },
        // Read the full deployment only when production changed: classification
        // needs its times and target, and the event carries its commit (AFE-15).
        enrich: async (raw) => {
          try {
            const full = await this.o.reader.getDeployment(live.id, project.id);
            return {
              current: normalizeDeployment(full, project.link ?? null),
              raw: { ...(raw as object), deployment: full },
            };
          } catch (err) {
            if (err instanceof ProjectNotSelectedError || isNotFound(err)) return null;
            throw err;
          }
        },
      });
      if (result) {
        this.result.productionChanges++;
        this.#count(result.inserted);
      }
    }
  }

  async #ingest(event: Parameters<EventSink["ingest"]>[1]): Promise<void> {
    const r = await this.o.sink.ingest(this.o.tenantId, event);
    this.#count(r.inserted);
  }

  #count(inserted: boolean) {
    if (inserted) this.result.inserted++;
    else this.result.duplicates++;
  }

  openList(): OpenDeployment[] {
    return [...this.#open.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, this.o.maxOpen);
  }
}

type PollerConfig = Required<Omit<VercelPollerOptions, "jobId">> & { jobId: string | null };
