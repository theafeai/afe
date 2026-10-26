/**
 * Reconciliation polling and backfill for GitHub (AFE-8).
 *
 * Webhooks can be missed (delivery failures, Afe downtime, an App with
 * webhooks switched off), so every selected repository is also re-read
 * through the REST API and compared with what the audit log already holds.
 * Anything missing is ingested with `observation.method = "reconciliation"`
 * (routine passes and gap backfills) or `"backfill"` (history imported when
 * an installation is connected), so the gap stays visible in the audit trail.
 *
 * Every object is mapped with the AFE-7 builders (`workflowRunEvent`,
 * `deploymentEvent`, ...), which derive `sourceEventId` from the object
 * exactly as the webhook path does, so a run seen by webhook and by polling is
 * stored once (first stored wins, docs/event-model.md).
 *
 * Pure logic: the REST client, event sink, poll-state store and "already
 * recorded?" lookup are injected. The server wiring (jobs, schedules, health)
 * is in apps/server/src/connectors/github.ts. Design and limits:
 * docs/connectors/github.md "Reconciliation".
 */
import {
  EventValidationError,
  type CanonicalEventInputLike,
  type EventSink,
  type JsonObject,
  type JsonValue,
} from "@afe/core";
import type { ConditionalPage } from "./client.ts";
import {
  deploymentEventId,
  deploymentStatusEventId,
  workflowRunEventId,
  workflowRunTransition,
  type WorkflowRunTransition,
} from "./event-ids.ts";
import { GitHubApiError, GitHubRateLimitError } from "./http.ts";
import {
  deploymentEvent,
  deploymentReviewApprovalEvent,
  deploymentStatusEvent,
  GitHubPayloadError,
  needDeployment,
  needWorkflowRun,
  pullRequestEvent,
  pushEvent,
  workflowRunEvent,
  type ObservationContext,
} from "./mapping.ts";
import { githubRawPayload } from "./raw-payload.ts";
import type {
  GitHubDeployment,
  GitHubDeploymentStatus,
  GitHubRepoEvent,
  GitHubRunApproval,
  GitHubWebhookRepository,
  GitHubWorkflowRun,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** `"reconciliation"`: routine passes and gap backfills; `"backfill"`: install history. */
export type ReconcileMode = "reconciliation" | "backfill";

/** Poll state is kept per (connection, repository, endpoint). */
export interface PollKey {
  tenantId: string;
  connectionId: string;
  /** Repository id; 0 for installation-level endpoints. */
  repositoryId: number;
  /** Endpoint and page, e.g. `runs?created>=2026-10-25#1`, or `repo` for the repository's state. */
  endpoint: string;
}

export interface PollState {
  /** ETag of the last response that was fully processed. */
  etag: string | null;
  /** Endpoint-specific bookkeeping (next page URL, ids on the page, open runs...). */
  data: JsonObject;
  polledAt: Date | null;
}

/** Storage of poll cursors and ETags (migration 0013 in the server). */
export interface PollStateStore {
  get(key: PollKey): Promise<PollState | null>;
  put(key: PollKey, state: PollState): Promise<void>;
}

type Query = Record<string, string | number | boolean | undefined>;

/** The part of `InstallationClient` reconciliation needs. */
export interface ReconcileClient {
  getPage<T>(
    path: string,
    query?: Query,
    options?: { etag?: string | null },
  ): Promise<ConditionalPage<T>>;
}

/** Which of these GitHub `sourceEventId`s are already in the tenant's log. */
export type RecordedLookup = (tenantId: string, sourceEventIds: string[]) => Promise<Set<string>>;

export interface ReconcileDeps {
  client: ReconcileClient;
  sink: EventSink;
  state: PollStateStore;
  /**
   * Optional: lets a pass skip objects that are already recorded and decide
   * when extra reads (earlier run attempts, approvals) are needed. Without
   * it every candidate is ingested (idempotent) and extra reads are made for
   * every re-run.
   */
  recorded?: RecordedLookup;
}

export interface ReconcileLimits {
  /** Pages of workflow runs per window (GitHub returns at most 1000 runs per filtered query). Default 10. */
  runPages: number;
  /** Pages of deployments. Default 10. */
  deploymentPages: number;
  /** Pages of the repository events API (it holds at most 300 events). Default 3. */
  eventPages: number;
  /** Open runs / deployments outside the window re-checked per pass. Default 100. */
  openItems: number;
  /** Deployments whose statuses are read per pass. Default 200. */
  statusChecks: number;
  /** Earlier attempts read for one re-run. Default 10. */
  attempts: number;
  /** Runs GitHub returns for one `created`-filtered query (documented: 1000). */
  runResultCap: number;
}

export const DEFAULT_RECONCILE_LIMITS: ReconcileLimits = {
  runPages: 10,
  deploymentPages: 10,
  eventPages: 3,
  openItems: 100,
  statusChecks: 200,
  attempts: 10,
  runResultCap: 1000,
};

export interface ReconcileRepoOptions {
  tenantId: string;
  connectionId: string;
  repository: { id: number; fullName: string };
  mode: ReconcileMode;
  /** Runs and deployments created in [from, to] are re-read. */
  from: Date;
  to: Date;
  /**
   * Routine passes: use stored ETags (a 304 costs no rate limit) and track
   * runs/deployments that are still open. Backfills read unconditionally and
   * leave the stored state alone.
   */
  conditional: boolean;
  /** Recover pushes from the repository events API (needs `contents` granted). */
  pushes?: boolean;
  /** Recover pull request events from the repository events API (needs `pull_requests`). */
  pullRequests?: boolean;
  /** Read environment approvals of newly found runs. Default true. */
  approvals?: boolean;
  /** Time of the pass (`observedAt` of every event). */
  now: Date;
  jobId?: string;
  /** Appended to every event's `observation.detail`, e.g. "after observation gap <id>". */
  reason?: string;
  limits?: Partial<ReconcileLimits>;
}

export interface ReconcileResult {
  /** API requests made (including conditional ones answered 304). */
  requests: number;
  /** Conditional requests answered 304 (free). */
  notModified: number;
  /** Events that were missing and have been added. */
  inserted: number;
  /** Candidate events that were already recorded (by webhook or an earlier pass). */
  alreadyRecorded: number;
  /** Objects that could not be mapped (missing fields, invalid event); skipped. */
  rejected: number;
  /** Inserted events per canonical action. */
  insertedByAction: Record<string, number>;
  /** Run ids / deployment ids seen in this pass. */
  runs: number;
  deployments: number;
  /** Human-readable notes on what was skipped (no payload content). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

/** Workflow runs can wait for approval for up to 30 days; Actions caps a run at 35 days. */
export const MAX_OPEN_AGE_MS = 35 * 24 * 3600_000;
/** GitHub returns at most 1000 workflow runs for a query filtered by `created`. */
export const RUN_QUERY_RESULT_CAP = 1000;
const TERMINAL_DEPLOYMENT_STATES = new Set(["success", "failure", "error", "inactive"]);
const ZERO_SHA = /^0{40}$|^0{64}$/;
const EVENTS_UNAVAILABLE_RETRY_MS = 24 * 3600_000;
/** Pages of statuses read per deployment (100 each). */
const STATUS_PAGES = 5;

const seg = (s: string | number) => encodeURIComponent(String(s));

/** GitHub search-style timestamp (no milliseconds). */
function ghTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ghDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function ms(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Run id referenced by a deployment status (`log_url`/`target_url` of an Actions job). */
export function runIdFromStatuses(statuses: GitHubDeploymentStatus[]): number | null {
  for (const s of statuses) {
    for (const url of [s.log_url, s.target_url]) {
      const m = typeof url === "string" ? /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url) : null;
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/**
 * Transitions that can honestly be reconstructed from a run's REST state:
 * `requested` (dated by `created_at`) always; `in_progress` only while the
 * run is in progress (for a finished run, Afe cannot tell when, or whether,
 * it started: `run_started_at` is also set for runs that never left the
 * queue); `completed` (dated by `updated_at`) once completed.
 */
export function reconstructableTransitions(
  status: string | null | undefined,
): WorkflowRunTransition[] {
  const t = workflowRunTransition(status);
  if (t === "completed") return ["requested", "completed"];
  if (t === "in_progress") return ["requested", "in_progress"];
  return ["requested"];
}

// ---------------------------------------------------------------------------
// Pass over one repository
// ---------------------------------------------------------------------------

type Got<T> = { page: ConditionalPage<T>; stored: PollState | null; key: PollKey | null };

interface OpenEntry {
  createdAt: string;
}

interface RepoState {
  openRuns: Record<string, OpenEntry>;
  openDeployments: Record<string, OpenEntry>;
  eventsNotBefore: string | null;
  eventsUnavailableUntil: string | null;
}

function readRepoState(s: PollState | null): RepoState {
  const d = (s?.data ?? {}) as Record<string, unknown>;
  const map = (v: unknown): Record<string, OpenEntry> => {
    const out: Record<string, OpenEntry> = {};
    if (isObject(v)) {
      for (const [k, e] of Object.entries(v)) {
        if (/^\d+$/.test(k) && isObject(e) && typeof e.createdAt === "string") {
          out[k] = { createdAt: e.createdAt };
        }
      }
    }
    return out;
  };
  return {
    openRuns: map(d.openRuns),
    openDeployments: map(d.openDeployments),
    eventsNotBefore: typeof d.eventsNotBefore === "string" ? d.eventsNotBefore : null,
    eventsUnavailableUntil:
      typeof d.eventsUnavailableUntil === "string" ? d.eventsUnavailableUntil : null,
  };
}

/** Re-reads one repository for [from, to] and ingests every missing event. */
export async function reconcileRepository(
  deps: ReconcileDeps,
  options: ReconcileRepoOptions,
): Promise<ReconcileResult> {
  const pass = new RepoPass(deps, options);
  await pass.run();
  return pass.result;
}

class RepoPass {
  readonly result: ReconcileResult = {
    requests: 0,
    notModified: 0,
    inserted: 0,
    alreadyRecorded: 0,
    rejected: 0,
    insertedByAction: {},
    runs: 0,
    deployments: 0,
    notes: [],
  };
  readonly limits: ReconcileLimits;
  readonly base: string;
  readonly repoKey: Omit<PollKey, "endpoint">;
  readonly seenRuns = new Map<number, GitHubWorkflowRun>();
  readonly seenDeployments = new Set<number>();
  repo: GitHubWebhookRepository;
  state!: RepoState;
  /** Runs created at or after this time were listed in this pass. */
  listedFrom: number;

  constructor(
    readonly deps: ReconcileDeps,
    readonly o: ReconcileRepoOptions,
  ) {
    this.limits = { ...DEFAULT_RECONCILE_LIMITS, ...o.limits };
    const [owner, name] = o.repository.fullName.split("/");
    if (!owner || !name) throw new Error("repository fullName must be owner/name");
    this.base = `/repos/${seg(owner)}/${seg(name)}`;
    this.repo = { id: o.repository.id, full_name: o.repository.fullName };
    this.listedFrom = o.from.getTime();
    this.repoKey = {
      tenantId: o.tenantId,
      connectionId: o.connectionId,
      repositoryId: o.repository.id,
    };
  }

  get routine(): boolean {
    return this.o.conditional;
  }

  async run(): Promise<void> {
    const stateKey = { ...this.repoKey, endpoint: "repo" };
    this.state = readRepoState(this.routine ? await this.deps.state.get(stateKey) : null);
    await this.runs();
    if (this.routine) await this.openRuns();
    await this.deploymentsPass();
    if (this.o.pushes || this.o.pullRequests) await this.repoEvents();
    if (this.routine) {
      const data: JsonObject = {
        openRuns: this.state.openRuns as unknown as JsonObject,
        openDeployments: this.state.openDeployments as unknown as JsonObject,
        eventsNotBefore: this.state.eventsNotBefore,
        eventsUnavailableUntil: this.state.eventsUnavailableUntil,
        lastPassAt: this.o.now.toISOString(),
      };
      await this.deps.state.put(stateKey, { etag: null, data, polledAt: this.o.now });
    }
  }

  // --- requests ------------------------------------------------------------

  async get<T>(
    path: string,
    query?: Query,
    endpoint?: string,
  ): Promise<{ page: ConditionalPage<T>; stored: PollState | null; key: PollKey | null }> {
    const key = this.routine && endpoint ? { ...this.repoKey, endpoint } : null;
    const stored = key ? await this.deps.state.get(key) : null;
    this.result.requests += 1;
    const page = await this.deps.client.getPage<T>(path, query, { etag: stored?.etag ?? null });
    if (page.status === 304) this.result.notModified += 1;
    return { page, stored, key };
  }

  async save(key: PollKey | null, page: ConditionalPage<unknown>, data: JsonObject = {}) {
    if (!key) return;
    await this.deps.state.put(key, { etag: page.etag, data, polledAt: this.o.now });
  }

  // --- events --------------------------------------------------------------

  ctx(detail: string, raw: unknown, extraStripped: string[] = []): ObservationContext {
    const sanitised = githubRawPayload(JSON.stringify(raw), raw);
    const stripped = [...extraStripped, ...sanitised.stripped];
    const how =
      this.o.mode === "backfill"
        ? "history imported by backfill"
        : "discovered by reconciliation (not recorded from a webhook)";
    const parts = [
      `${how}: ${detail}`,
      ...(this.o.reason ? [this.o.reason] : []),
      ...(stripped.length > 0 ? [`raw payload redacted (R8): ${stripped.join(", ")}`] : []),
    ];
    return {
      connectionId: this.o.connectionId,
      observedAt: this.o.now,
      method: this.o.mode,
      ...(this.o.jobId ? { jobId: this.o.jobId } : {}),
      detail: parts.join("; "),
      rawPayload: sanitised.rawPayload,
    };
  }

  async recorded(ids: string[]): Promise<Set<string>> {
    if (!this.deps.recorded || ids.length === 0) return new Set();
    return this.deps.recorded(this.o.tenantId, [...new Set(ids)]);
  }

  /** Builds and ingests one event; mapping problems skip the object, they do not fail the pass. */
  async ingest(what: string, build: () => CanonicalEventInputLike | null): Promise<void> {
    let input: CanonicalEventInputLike | null;
    try {
      input = build();
      if (!input) return;
      const r = await this.deps.sink.ingest(this.o.tenantId, input);
      if (r.inserted) {
        this.result.inserted += 1;
        this.result.insertedByAction[input.action] =
          (this.result.insertedByAction[input.action] ?? 0) + 1;
      } else {
        this.result.alreadyRecorded += 1;
      }
    } catch (err) {
      if (err instanceof GitHubPayloadError) {
        this.reject(`${what}: missing or invalid ${err.path}`);
        return;
      }
      if (err instanceof EventValidationError) {
        this.reject(`${what}: mapped event failed validation`);
        return;
      }
      throw err;
    }
  }

  reject(note: string) {
    this.result.rejected += 1;
    if (this.result.notes.length < 50) this.result.notes.push(note);
  }

  note(note: string) {
    if (this.result.notes.length < 50) this.result.notes.push(note);
  }

  repoFor(run: GitHubWorkflowRun): GitHubWebhookRepository {
    const name = run.repository?.full_name;
    return typeof name === "string" && /^[^/\s]+\/[^/\s]+$/.test(name)
      ? { id: this.repo.id, full_name: name }
      : this.repo;
  }

  // --- workflow runs -------------------------------------------------------

  async runs(): Promise<void> {
    if (this.routine) {
      // A stable URL for the day (so ETags can match), overlapping the window.
      const day = ghDay(this.o.from);
      const endpoint = `runs?created>=${day}`;
      const overCap = await this.pagedRuns({ created: `>=${day}` }, endpoint);
      if (!overCap) {
        this.listedFrom = Date.parse(`${day}T00:00:00Z`);
        return;
      }
      this.note(
        `more than ${this.limits.runResultCap} runs in the window; split into smaller windows`,
      );
    }
    await this.windowRuns(this.o.from, this.o.to);
  }

  /**
   * Pages of `GET /actions/runs` for a query. Returns true (and processes
   * nothing) when the query matches more runs than GitHub returns.
   */
  async pagedRuns(query: Query, endpoint: string | null): Promise<boolean> {
    let url: string | null = `${this.base}/actions/runs`;
    let q: Query | undefined = { ...query, per_page: 100 };
    for (let n = 1; url && n <= this.limits.runPages; n++) {
      const got: Got<{ total_count?: number; workflow_runs?: GitHubWorkflowRun[] }> =
        await this.get(url, q, endpoint ? `${endpoint}#${n}` : undefined);
      const { page, stored, key } = got;
      q = undefined;
      if (page.status === 304) {
        url = typeof stored?.data.next === "string" ? stored.data.next : null;
        continue;
      }
      const data = page.data ?? {};
      if (n === 1 && (data.total_count ?? 0) > this.limits.runResultCap) return true;
      await this.processRuns(data.workflow_runs ?? []);
      await this.save(key, page, { next: page.next });
      url = page.next;
    }
    if (url) this.note(`workflow runs: stopped after ${this.limits.runPages} pages`);
    return false;
  }

  /** Runs created in [from, to], halving the window while GitHub's result cap is exceeded. */
  async windowRuns(from: Date, to: Date): Promise<void> {
    const overCap = await this.pagedRuns({ created: `${ghTime(from)}..${ghTime(to)}` }, null);
    if (!overCap) return;
    if (to.getTime() - from.getTime() <= 60_000) {
      this.note(`more than ${this.limits.runResultCap} runs within one minute; some may be missed`);
      await this.pagedRunsIgnoringCap({ created: `${ghTime(from)}..${ghTime(to)}` });
      return;
    }
    const mid = new Date(Math.floor((from.getTime() + to.getTime()) / 2000) * 1000);
    await this.windowRuns(from, mid);
    await this.windowRuns(mid, to);
  }

  async pagedRunsIgnoringCap(query: Query): Promise<void> {
    let url: string | null = `${this.base}/actions/runs`;
    let q: Query | undefined = { ...query, per_page: 100 };
    for (let n = 1; url && n <= this.limits.runPages; n++) {
      const got: Got<{ workflow_runs?: GitHubWorkflowRun[] }> = await this.get(url, q);
      const { page } = got;
      q = undefined;
      await this.processRuns(page.data?.workflow_runs ?? []);
      url = page.next;
    }
  }

  async processRuns(raw: unknown[]): Promise<void> {
    const runs: GitHubWorkflowRun[] = [];
    for (const r of raw) {
      try {
        const run = needWorkflowRun(r, "run");
        if (this.seenRuns.has(run.id)) continue;
        runs.push(run);
      } catch (err) {
        if (!(err instanceof GitHubPayloadError)) throw err;
        this.reject(`workflow run: missing or invalid ${err.path}`);
      }
    }
    if (runs.length === 0) return;
    const ids: string[] = [];
    for (const run of runs) {
      for (const t of reconstructableTransitions(run.status)) ids.push(workflowRunEventId(run, t));
      for (
        let n = Math.max(1, (run.run_attempt ?? 1) - this.limits.attempts);
        n < (run.run_attempt ?? 1);
        n++
      ) {
        ids.push(workflowRunEventId({ id: run.id, run_attempt: n }, "completed"));
      }
    }
    const known = await this.recorded(ids);

    for (const run of runs) {
      this.seenRuns.set(run.id, run);
      this.result.runs += 1;
      const isNew = await this.ingestRun(run, known);
      const attempt = run.run_attempt ?? 1;
      for (let n = Math.max(1, attempt - this.limits.attempts); n < attempt; n++) {
        if (known.has(workflowRunEventId({ id: run.id, run_attempt: n }, "completed"))) continue;
        await this.earlierAttempt(run, n, known);
      }
      if (isNew && (this.o.approvals ?? true)) await this.approvals(run);
      if (this.routine) {
        if (workflowRunTransition(run.status) === "completed") delete this.state.openRuns[run.id];
        else this.state.openRuns[run.id] = { createdAt: run.created_at };
      }
    }
  }

  /** Ingests the reconstructable transitions of one run attempt; true if any was missing. */
  async ingestRun(run: GitHubWorkflowRun, known: Set<string>, endpoint?: string): Promise<boolean> {
    const repo = this.repoFor(run);
    const current = workflowRunTransition(run.status);
    let missing = false;
    for (const t of reconstructableTransitions(run.status)) {
      if (known.has(workflowRunEventId(run, t))) continue;
      missing = true;
      const source = endpoint ?? `GET ${repo.full_name} actions/runs`;
      const detail =
        t === current
          ? `${source} (status ${run.status ?? "unknown"})`
          : `${source}; ${t} reconstructed from the run's later state (status ${run.status ?? "unknown"})`;
      await this.ingest(`workflow run ${run.id}`, () =>
        workflowRunEvent(run, repo, t, this.ctx(detail, run)),
      );
    }
    return missing;
  }

  async earlierAttempt(run: GitHubWorkflowRun, n: number, known: Set<string>): Promise<void> {
    try {
      const { page } = await this.get<GitHubWorkflowRun>(
        `${this.base}/actions/runs/${seg(run.id)}/attempts/${seg(n)}`,
      );
      const attempt = needWorkflowRun(page.data, "attempt");
      if ((attempt.run_attempt ?? 1) !== n) return;
      await this.ingestRun(
        attempt,
        known,
        `GET ${this.repo.full_name} actions/runs/${run.id}/attempts/${n}`,
      );
    } catch (err) {
      if (err instanceof GitHubPayloadError) return this.reject(`run attempt: invalid ${err.path}`);
      if (
        err instanceof GitHubApiError &&
        !(err instanceof GitHubRateLimitError) &&
        err.status === 404
      ) {
        return this.note(`run ${run.id} attempt ${n} not found`);
      }
      throw err;
    }
  }

  /**
   * Environment approvals of a newly found run. Only for first attempts: the
   * approvals API does not say which attempt an approval belongs to, and the
   * event key includes it.
   */
  async approvals(run: GitHubWorkflowRun): Promise<void> {
    if ((run.run_attempt ?? 1) !== 1) return;
    let list: GitHubRunApproval[];
    try {
      const { page } = await this.get<GitHubRunApproval[]>(
        `${this.base}/actions/runs/${seg(run.id)}/approvals`,
      );
      list = Array.isArray(page.data) ? page.data : [];
    } catch (err) {
      if (
        err instanceof GitHubApiError &&
        !(err instanceof GitHubRateLimitError) &&
        err.status === 404
      ) {
        return this.note(`approvals of run ${run.id} not available`);
      }
      throw err;
    }
    const repo = this.repoFor(run);
    for (const a of list) {
      if (!isObject(a)) continue;
      const envs = (Array.isArray(a.environments) ? a.environments : [])
        .map((e) => (isObject(e) && typeof e.name === "string" ? e.name : ""))
        .filter((e) => e.length > 0);
      await this.ingest(`approval of run ${run.id}`, () =>
        deploymentReviewApprovalEvent(
          a,
          envs,
          run,
          repo,
          run.updated_at,
          this.ctx(
            `GET ${repo.full_name} actions/runs/${run.id}/approvals; the API has no review time, occurredAt is the run's updated_at`,
            a,
          ),
        ),
      );
    }
  }

  /** Runs seen open in an earlier pass and created before the window: re-read one by one. */
  async openRuns(): Promise<void> {
    const cutoff = this.o.now.getTime() - MAX_OPEN_AGE_MS;
    let checked = 0;
    for (const [id, entry] of Object.entries(this.state.openRuns)) {
      const runId = Number(id);
      if (this.seenRuns.has(runId)) continue;
      const created = ms(entry.createdAt);
      if (created === null || created < cutoff) {
        delete this.state.openRuns[id];
        continue;
      }
      if (created >= this.listedFrom) continue; // listed (possibly on an unchanged page)
      if (checked++ >= this.limits.openItems) break;
      try {
        const { page, key } = await this.get<GitHubWorkflowRun>(
          `${this.base}/actions/runs/${seg(runId)}`,
          undefined,
          `runs/${runId}`,
        );
        if (page.status === 304) continue;
        await this.processRuns([page.data]);
        await this.save(key, page);
      } catch (err) {
        if (
          err instanceof GitHubApiError &&
          !(err instanceof GitHubRateLimitError) &&
          err.status === 404
        ) {
          delete this.state.openRuns[id];
          continue;
        }
        throw err;
      }
    }
  }

  // --- deployments ---------------------------------------------------------

  async deploymentsPass(): Promise<void> {
    const from = this.o.from.getTime();
    const candidates = new Map<number, GitHubDeployment | null>();
    let url: string | null = `${this.base}/deployments`;
    let q: Query | undefined = { per_page: 100 };
    let n = 1;
    for (; url && n <= this.limits.deploymentPages; n++) {
      const got: Got<GitHubDeployment[]> = await this.get(url, q, `deployments#${n}`);
      const { page, stored, key } = got;
      q = undefined;
      let entries: { id: number; createdAt: string; object: GitHubDeployment | null }[];
      let next: string | null;
      if (page.status === 304) {
        const ids: unknown[] = Array.isArray(stored?.data.ids) ? stored!.data.ids : [];
        entries = ids.filter(isObject).map((e) => ({
          id: Number(e.id),
          createdAt: String(e.createdAt),
          object: null,
        }));
        next = typeof stored?.data.next === "string" ? stored.data.next : null;
      } else {
        entries = [];
        for (const d of Array.isArray(page.data) ? page.data : []) {
          try {
            const dep = needDeployment(d, "deployment");
            entries.push({ id: dep.id, createdAt: dep.created_at, object: dep });
          } catch (err) {
            if (!(err instanceof GitHubPayloadError)) throw err;
            this.reject(`deployment: missing or invalid ${err.path}`);
          }
        }
        next = page.next;
        await this.save(key, page, {
          next,
          ids: entries.map((e) => ({ id: e.id, createdAt: e.createdAt })),
        });
      }
      let older = false;
      for (const e of entries) {
        const created = ms(e.createdAt);
        if (created !== null && created < from) {
          older = true;
          continue;
        }
        if (created !== null && created > this.o.to.getTime() && !this.routine) continue;
        candidates.set(e.id, e.object);
      }
      url = older ? null : next;
    }
    if (url) this.note(`deployments: stopped after ${this.limits.deploymentPages} pages`);
    if (this.routine) {
      const cutoff = this.o.now.getTime() - MAX_OPEN_AGE_MS;
      let open = 0;
      for (const [id, entry] of Object.entries(this.state.openDeployments)) {
        const created = ms(entry.createdAt);
        if (created === null || created < cutoff) {
          delete this.state.openDeployments[id];
          continue;
        }
        if (!candidates.has(Number(id)) && open++ < this.limits.openItems) {
          candidates.set(Number(id), null);
        }
      }
    }
    let checked = 0;
    for (const [id, object] of candidates) {
      if (checked++ >= this.limits.statusChecks) {
        this.note(
          `deployments: statuses of ${candidates.size - this.limits.statusChecks} deployments left for the next pass`,
        );
        break;
      }
      await this.deployment(id, object);
    }
  }

  async deployment(id: number, object: GitHubDeployment | null): Promise<void> {
    let page: ConditionalPage<GitHubDeploymentStatus[]>;
    let key: PollKey | null;
    try {
      ({ page, key } = await this.get<GitHubDeploymentStatus[]>(
        `${this.base}/deployments/${seg(id)}/statuses`,
        { per_page: 100 },
        `deployments/${id}/statuses`,
      ));
    } catch (err) {
      if (
        err instanceof GitHubApiError &&
        !(err instanceof GitHubRateLimitError) &&
        err.status === 404
      ) {
        delete this.state.openDeployments[id];
        return;
      }
      throw err;
    }
    // Statuses are immutable and listed newest first, so an unchanged first
    // page means nothing was added since the deployment was fully processed.
    if (page.status === 304) return;
    const raw: unknown[] = Array.isArray(page.data) ? [...page.data] : [];
    let next = page.next;
    for (let n = 2; next && n <= STATUS_PAGES; n++) {
      const more: Got<GitHubDeploymentStatus[]> = await this.get(next);
      raw.push(...(Array.isArray(more.page.data) ? more.page.data : []));
      next = more.page.next;
    }
    if (next) this.note(`deployment ${id}: more than ${STATUS_PAGES} pages of statuses`);
    const statuses: GitHubDeploymentStatus[] = [];
    for (const s of raw) {
      if (isObject(s) && typeof s.id === "number" && typeof s.state === "string") {
        statuses.push(s as unknown as GitHubDeploymentStatus);
      } else {
        this.reject(`deployment ${id} status: missing id or state`);
      }
    }
    this.seenDeployments.add(id);
    this.result.deployments += 1;
    const ids = [deploymentEventId({ id }), ...statuses.map((s) => deploymentStatusEventId(s))];
    const known = await this.recorded(ids);
    const missing = ids.filter((i) => !known.has(i));
    if (missing.length > 0) {
      let found = object;
      if (!found) {
        const res = await this.get<GitHubDeployment>(`${this.base}/deployments/${seg(id)}`);
        try {
          found = needDeployment(res.page.data, "deployment");
        } catch (err) {
          if (!(err instanceof GitHubPayloadError)) throw err;
          return this.reject(`deployment ${id}: missing or invalid ${err.path}`);
        }
      }
      const deployment = found;
      const { run, note } = await this.linkedRun(deployment, statuses);
      const linked = note ? `; ${note}` : "";
      if (!known.has(deploymentEventId(deployment))) {
        await this.ingest(`deployment ${id}`, () =>
          deploymentEvent(
            deployment,
            this.repo,
            run,
            this.ctx(`GET ${this.repo.full_name} deployments${linked}`, deployment),
          ),
        );
      }
      // Oldest first, so the log reads in source order where possible.
      const ordered = [...statuses].sort(
        (a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0),
      );
      for (const s of ordered) {
        if (known.has(deploymentStatusEventId(s))) continue;
        await this.ingest(`deployment ${id} status ${s.id}`, () =>
          deploymentStatusEvent(
            s,
            deployment,
            this.repo,
            run,
            this.ctx(`GET ${this.repo.full_name} deployments/${id}/statuses${linked}`, {
              deployment_status: s,
              deployment,
            }),
          ),
        );
      }
    }
    if (this.routine) {
      const latest = [...statuses].sort(
        (a, b) => (ms(b.created_at) ?? 0) - (ms(a.created_at) ?? 0),
      )[0];
      const createdAt = object?.created_at ?? this.state.openDeployments[id]?.createdAt;
      if (latest && TERMINAL_DEPLOYMENT_STATES.has(latest.state)) {
        delete this.state.openDeployments[id];
      } else if (createdAt) {
        this.state.openDeployments[id] = { createdAt };
      }
    }
    await this.save(key, page);
  }

  /**
   * The workflow run that created a deployment, as the webhook would carry it
   * (`workflow_run`). REST deployments do not link it; Actions deployment
   * statuses point at the job (`/actions/runs/<id>/job/<id>`). A re-run's
   * deployment cannot be tied to its attempt, so it is left unlinked.
   */
  async linkedRun(
    deployment: GitHubDeployment,
    statuses: GitHubDeploymentStatus[],
  ): Promise<{ run: GitHubWorkflowRun | null; note?: string }> {
    const runId = runIdFromStatuses(statuses);
    if (runId === null) return { run: null };
    let run = this.seenRuns.get(runId) ?? null;
    if (!run) {
      try {
        const { page } = await this.get<GitHubWorkflowRun>(
          `${this.base}/actions/runs/${seg(runId)}`,
        );
        run = needWorkflowRun(page.data, "run");
      } catch (err) {
        if (err instanceof GitHubRateLimitError) throw err;
        if (err instanceof GitHubPayloadError || err instanceof GitHubApiError) {
          return { run: null, note: `linked workflow run ${runId} could not be read` };
        }
        throw err;
      }
    }
    const attempt = run.run_attempt ?? 1;
    const started = ms(run.run_started_at);
    const created = ms(deployment.created_at);
    if (attempt > 1 && (started === null || created === null || created < started)) {
      return {
        run: null,
        note: `created by workflow run ${runId}, attempt unknown (the run has ${attempt} attempts)`,
      };
    }
    return { run };
  }

  // --- repository events API (pushes, pull requests) -----------------------

  async repoEvents(): Promise<void> {
    const now = this.o.now.getTime();
    const unavailable = ms(this.state.eventsUnavailableUntil);
    if (unavailable !== null && unavailable > now) {
      this.note("repository events API unavailable; pushes and pull requests not reconciled");
      return;
    }
    const notBefore = ms(this.state.eventsNotBefore);
    if (this.routine && notBefore !== null && notBefore > now) return;
    const from = this.o.from.getTime();
    let url: string | null = `${this.base}/events`;
    let q: Query | undefined = { per_page: 100 };
    let reachedOlder = false;
    for (let n = 1; url && n <= this.limits.eventPages; n++) {
      let page: ConditionalPage<GitHubRepoEvent[]>;
      let stored: PollState | null;
      let key: PollKey | null;
      try {
        ({ page, stored, key } = await this.get<GitHubRepoEvent[]>(url, q, `events#${n}`));
      } catch (err) {
        if (
          err instanceof GitHubApiError &&
          !(err instanceof GitHubRateLimitError) &&
          (err.status === 403 || err.status === 404)
        ) {
          this.state.eventsUnavailableUntil = new Date(
            now + EVENTS_UNAVAILABLE_RETRY_MS,
          ).toISOString();
          this.note(
            `repository events API returned ${err.status}; pushes and pull requests not reconciled`,
          );
          return;
        }
        throw err;
      }
      q = undefined;
      if (n === 1 && page.pollIntervalSeconds) {
        this.state.eventsNotBefore = new Date(now + page.pollIntervalSeconds * 1000).toISOString();
      }
      if (page.status === 304) {
        url = typeof stored?.data.next === "string" ? stored.data.next : null;
        continue;
      }
      for (const ev of Array.isArray(page.data) ? page.data : []) {
        if (!isObject(ev)) continue;
        const created = ms(ev.created_at);
        if (created !== null && created < from) {
          reachedOlder = true;
          continue;
        }
        if (ev.type === "PushEvent" && this.o.pushes) await this.pushFromEvent(ev);
        else if (ev.type === "PullRequestEvent" && this.o.pullRequests) await this.prFromEvent(ev);
      }
      await this.save(key, page, { next: page.next });
      url = reachedOlder ? null : page.next;
    }
    if (url && !reachedOlder && this.o.mode === "backfill") {
      this.note(
        "repository events API holds at most 300 events / 90 days; older pushes and pull requests cannot be recovered",
      );
    }
  }

  async pushFromEvent(ev: GitHubRepoEvent): Promise<void> {
    const p = isObject(ev.payload) ? ev.payload : {};
    const before = typeof p.before === "string" ? p.before : "";
    const head = typeof p.head === "string" ? p.head : typeof p.after === "string" ? p.after : "";
    const commits = (Array.isArray(p.commits) ? p.commits : [])
      .filter(isObject)
      .map((c) => ({ id: c.sha, message: c.message }));
    const synthesized: Record<string, unknown> = {
      ref: p.ref,
      before,
      after: head,
      created: ZERO_SHA.test(before),
      deleted: ZERO_SHA.test(head),
      commits,
      sender: ev.actor ?? null,
    };
    await this.ingest(`push event ${ev.id}`, () => {
      const e = pushEvent(
        synthesized,
        this.repo,
        this.ctx(
          `GET ${this.repo.full_name} events (PushEvent ${ev.id}); the events API does not report forced pushes and lists at most 20 commits`,
          ev,
        ),
      );
      const data = (e.data ?? {}) as Record<string, JsonValue>;
      return {
        ...e,
        occurredAt: ev.created_at ?? e.occurredAt,
        data: {
          ...data,
          forced: null,
          commitCount: typeof p.size === "number" ? p.size : commits.length,
        },
      };
    });
  }

  async prFromEvent(ev: GitHubRepoEvent): Promise<void> {
    const p = isObject(ev.payload) ? ev.payload : {};
    // The PR body is not stored (R8), as for webhooks.
    const clean = structuredClone(ev) as GitHubRepoEvent & { payload: Record<string, unknown> };
    const stripped: string[] = [];
    if (isObject(clean.payload?.pull_request) && clean.payload.pull_request.body != null) {
      delete clean.payload.pull_request.body;
      stripped.push("payload.pull_request.body");
    }
    await this.ingest(`pull request event ${ev.id}`, () =>
      pullRequestEvent(
        { ...p, sender: ev.actor ?? null },
        this.repo,
        this.ctx(`GET ${this.repo.full_name} events (PullRequestEvent ${ev.id})`, clean, stripped),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Scheduling and rate-limit budget
// ---------------------------------------------------------------------------

/** GitHub's baseline primary rate limit for an App installation (requests per hour). */
export const INSTALLATION_HOURLY_LIMIT = 5000;

export interface ReconcileBudgetInput {
  /** Repositories to reconcile on this connection. */
  repositories: number;
  /** Shortest interval between two passes of one repository. */
  baseIntervalMs: number;
  /** Fraction of the installation's hourly limit reconciliation may use. Default 0.5. */
  budgetShare?: number;
  /** Worst-case requests one pass makes when something changed. Default 4. */
  requestsPerPass?: number;
  /** `x-ratelimit-limit` if known, else 5000. */
  hourlyLimit?: number;
  /** Last known `x-ratelimit-remaining` / reset of the installation. */
  remaining?: number | null;
  resetAt?: Date | null;
  now: Date;
  /** Upper bound of the interval. Default 6 h. */
  maxIntervalMs?: number;
}

/**
 * Interval between two passes of each repository of a connection. Polling
 * scales with the number of repositories so that reconciliation stays within
 * `budgetShare` of the installation's hourly limit, and slows down further
 * when the current window's remaining budget is low:
 *
 *   interval = max(base, repos * requestsPerPass / (limit * share) hours,
 *                  repos * requestsPerPass / (remaining * share / timeToReset))
 *
 * Conditional requests answered 304 do not count against the limit, so the
 * real cost of an unchanged repository is far lower; the estimate is a worst case.
 */
export function reconcileIntervalMs(input: ReconcileBudgetInput): number {
  const share = input.budgetShare ?? 0.5;
  const cost = Math.max(1, input.repositories) * (input.requestsPerPass ?? 4);
  const limit = input.hourlyLimit ?? INSTALLATION_HOURLY_LIMIT;
  let interval = Math.max(input.baseIntervalMs, (cost / (limit * share)) * 3600_000);
  if (input.remaining !== null && input.remaining !== undefined && input.resetAt) {
    const untilReset = Math.max(60_000, input.resetAt.getTime() - input.now.getTime());
    const usable = Math.max(1, input.remaining * share);
    interval = Math.max(interval, (cost / usable) * untilReset);
  }
  return Math.round(Math.min(interval, input.maxIntervalMs ?? 6 * 3600_000));
}

/** Start time of the `index`-th of `count` passes spread evenly over `intervalMs`. */
export function spreadStart(now: Date, index: number, count: number, intervalMs: number): Date {
  if (count <= 1) return now;
  return new Date(now.getTime() + Math.floor((index * intervalMs) / count));
}

/** In-memory `PollStateStore` (tests, single-process use). */
export function createMemoryPollStateStore(): PollStateStore & { entries: Map<string, PollState> } {
  const entries = new Map<string, PollState>();
  const k = (key: PollKey) =>
    JSON.stringify([key.tenantId, key.connectionId, key.repositoryId, key.endpoint]);
  return {
    entries,
    async get(key) {
      const s = entries.get(k(key));
      return s ? structuredClone(s) : null;
    },
    async put(key, state) {
      entries.set(k(key), structuredClone(state));
    },
  };
}
