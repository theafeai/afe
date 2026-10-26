/**
 * A local fake of the GitHub REST endpoints reconciliation reads (AFE-8):
 * workflow runs (with `created` filters, the 1000-result cap, attempts and
 * approvals), deployments and statuses, the repository events API, the
 * installation's repositories and token minting. It paginates with `Link`
 * headers, answers conditional requests with 304 (not counted against the
 * rate limit, as on GitHub), keeps `x-ratelimit-*` headers and can be made
 * to exhaust the limit. No network.
 */
import { createHash } from "node:crypto";
import type { RecordedRequest } from "./fixtures.ts";
import { installationFixture } from "./fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

export interface FakeRepo {
  id: number;
  fullName: string;
  runs: Obj[];
  /** Earlier attempts: run id -> attempt objects. */
  attempts: Map<number, Obj[]>;
  approvals: Map<number, Obj[]>;
  deployments: Obj[];
  statuses: Map<number, Obj[]>;
  events: Obj[];
  /** Status answered by the events API instead of the events (e.g. 403). */
  eventsStatus?: number;
}

export interface FakeRequest extends RecordedRequest {
  path: string;
  status: number;
  conditional: boolean;
}

export class FakeGitHubApi {
  readonly repos = new Map<string, FakeRepo>();
  readonly requests: FakeRequest[] = [];
  /** Items per page cap (forces pagination in tests). */
  pageSize = 100;
  /** Result cap of filtered run queries (GitHub: 1000). */
  runQueryCap = 1000;
  limit = 5000;
  remaining = 5000;
  /** Epoch seconds. */
  reset = Math.floor(Date.parse("2026-10-26T14:00:00Z") / 1000);
  /** Counted requests answered before the limit runs out (then 403 remaining 0). */
  exhaustAfter: number | null = null;
  installationRepositories: { id: number; full_name: string }[] = [];

  repo(fullName: string, id: number): FakeRepo {
    let r = this.repos.get(fullName);
    if (!r) {
      r = {
        id,
        fullName,
        runs: [],
        attempts: new Map(),
        approvals: new Map(),
        deployments: [],
        statuses: new Map(),
        events: [],
      };
      this.repos.set(fullName, r);
    }
    return r;
  }

  /** Requests other than token minting. */
  get apiRequests(): FakeRequest[] {
    return this.requests.filter((r) => !r.path.endsWith("/access_tokens"));
  }

  get counted(): number {
    return this.apiRequests.filter((r) => r.status !== 304).length;
  }

  reset_requests() {
    this.requests.length = 0;
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const req: FakeRequest = {
      method: init.method ?? "GET",
      url,
      path: u.pathname,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      status: 0,
      conditional: Boolean(headers["if-none-match"]),
    };
    this.requests.push(req);
    const res = this.route(req, u);
    req.status = res.status;
    return res;
  };

  private rateHeaders(): Record<string, string> {
    return {
      "x-ratelimit-limit": String(this.limit),
      "x-ratelimit-remaining": String(this.remaining),
      "x-ratelimit-reset": String(this.reset),
    };
  }

  private respond(
    req: FakeRequest,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ) {
    const text = JSON.stringify(body);
    const etag = `W/"${createHash("sha1").update(text).digest("hex")}"`;
    if (status === 200 && req.headers["if-none-match"] === etag) {
      return new Response(null, { status: 304, headers: { etag, ...this.rateHeaders() } });
    }
    if (status === 200 && this.exhaustAfter !== null) {
      if (this.exhaustAfter <= 0) {
        this.remaining = 0;
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "content-type": "application/json", ...this.rateHeaders() },
        });
      }
      this.exhaustAfter -= 1;
    }
    if (status === 200) this.remaining = Math.max(0, this.remaining - 1);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json", etag, ...this.rateHeaders(), ...extra },
    });
  }

  private page<T>(
    req: FakeRequest,
    u: URL,
    items: T[],
    wrap?: (items: T[], total: number) => unknown,
  ) {
    const perPage = Math.min(Number(u.searchParams.get("per_page") ?? 30), this.pageSize);
    const page = Number(u.searchParams.get("page") ?? 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const extra: Record<string, string> = {};
    if (page * perPage < items.length) {
      const next = new URL(u.toString());
      next.searchParams.set("page", String(page + 1));
      extra.link = `<${next.toString()}>; rel="next"`;
    }
    return this.respond(req, 200, wrap ? wrap(slice, items.length) : slice, extra);
  }

  private route(req: FakeRequest, u: URL): Response {
    const p = u.pathname;
    let m: RegExpExecArray | null;
    if (req.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(p)) {
      return new Response(
        JSON.stringify({
          token: "ghs_FAKE_INSTALLATION_TOKEN_AFE8",
          expires_at: "2026-10-26T23:00:00Z",
          permissions: { actions: "read", deployments: "read", metadata: "read" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (req.method !== "GET") return this.respond(req, 405, { message: "method" });
    if ((m = /^\/app\/installations\/(\d+)$/.exec(p))) {
      return this.respond(req, 200, installationFixture({ id: Number(m[1]) }));
    }
    if (p === "/installation/repositories") {
      return this.page(req, u, this.installationRepositories, (repositories, total) => ({
        total_count: total,
        repositories,
      }));
    }
    m = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(p);
    if (!m) return this.respond(req, 404, { message: "Not Found" });
    const repo = this.repos.get(decodeURIComponent(m[1]!));
    if (!repo) return this.respond(req, 404, { message: "Not Found" });
    const rest = m[2]!;
    const byCreatedDesc = (a: Obj, b: Obj) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id;

    if (rest === "/actions/runs") {
      const created = u.searchParams.get("created");
      let runs = [...repo.runs].sort(byCreatedDesc);
      if (created) runs = runs.filter((r) => matchCreated(r.created_at, created));
      const total = runs.length;
      if (created && runs.length > this.runQueryCap) runs = runs.slice(0, this.runQueryCap);
      return this.page(req, u, runs, (workflow_runs) => ({ total_count: total, workflow_runs }));
    }
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(rest))) {
      const run = repo.runs.find((r) => r.id === Number(m![1]));
      return run ? this.respond(req, 200, run) : this.respond(req, 404, { message: "Not Found" });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(rest))) {
      const runId = Number(m[1]);
      const n = Number(m[2]);
      const current = repo.runs.find((r) => r.id === runId);
      const attempt =
        current?.run_attempt === n
          ? current
          : repo.attempts.get(runId)?.find((a) => a.run_attempt === n);
      return attempt
        ? this.respond(req, 200, attempt)
        : this.respond(req, 404, { message: "Not Found" });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/approvals$/.exec(rest))) {
      return this.respond(req, 200, repo.approvals.get(Number(m[1])) ?? []);
    }
    if (rest === "/deployments") {
      return this.page(req, u, [...repo.deployments].sort(byCreatedDesc));
    }
    if ((m = /^\/deployments\/(\d+)$/.exec(rest))) {
      const d = repo.deployments.find((x) => x.id === Number(m![1]));
      return d ? this.respond(req, 200, d) : this.respond(req, 404, { message: "Not Found" });
    }
    if ((m = /^\/deployments\/(\d+)\/statuses$/.exec(rest))) {
      const id = Number(m[1]);
      if (!repo.deployments.some((d) => d.id === id)) {
        return this.respond(req, 404, { message: "Not Found" });
      }
      return this.page(req, u, [...(repo.statuses.get(id) ?? [])].sort(byCreatedDesc));
    }
    if (rest === "/events") {
      if (repo.eventsStatus) return this.respond(req, repo.eventsStatus, { message: "Forbidden" });
      const events = [...repo.events]
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .slice(0, 300);
      return this.page(req, u, events);
    }
    return this.respond(req, 404, { message: "Not Found" });
  }
}

/** GitHub `created` qualifier: `>=YYYY-MM-DD`, `>=<ts>` or `<a>..<b>`. */
function matchCreated(createdAt: string, q: string): boolean {
  const t = Date.parse(createdAt);
  const parse = (s: string) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (q.startsWith(">=")) return t >= parse(q.slice(2));
  const range = q.split("..");
  if (range.length === 2) return t >= parse(range[0]!) && t <= parse(range[1]!);
  return true;
}
