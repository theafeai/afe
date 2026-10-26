/**
 * A local fake of the Vercel REST API for tests (never call the real one).
 * Shapes follow the fixtures in docs/connectors/vercel.md.
 */
import { signHmac } from "@afe/core/security";
import type { FetchLike } from "./client.ts";
import type { VercelCaptureStore, VercelPollState } from "./capture.ts";
import type { ProductionState } from "./mapping.ts";
import type {
  VercelAliasRequest,
  VercelDeployment,
  VercelDeploymentListItem,
  VercelProject,
  VercelTeam,
  VercelUser,
} from "./types.ts";

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
}

interface TokenGrant {
  userId: string;
  /** Teams the token may access; null = all teams of the user (personal token). */
  teamIds: string[] | null;
}

export interface FakeOAuthCode {
  code: string;
  token: string;
  configurationId: string;
  userId: string;
  teamId: string | null;
  redirectUri: string;
}

export class FakeVercelApi {
  readonly requests: FakeRequest[] = [];
  readonly users = new Map<string, VercelUser>();
  readonly teams = new Map<string, VercelTeam>();
  /** projects per owner (team id, or user id for personal accounts) */
  readonly projects = new Map<string, VercelProject[]>();
  readonly deployments: (VercelDeployment & { ownerId: string })[] = [];
  readonly tokens = new Map<string, TokenGrant>();
  readonly oauthCodes = new Map<string, FakeOAuthCode>();
  readonly deletedConfigurations: string[] = [];
  clientId = "oac_test";
  clientSecret = "client-secret-test";
  pageSize = 2;
  /** Respond 429 to the next N requests. */
  rateLimitNext = 0;

  addUser(user: VercelUser): this {
    this.users.set(user.id, user);
    return this;
  }
  addTeam(team: VercelTeam): this {
    this.teams.set(team.id, team);
    return this;
  }
  addProject(ownerId: string, project: VercelProject): this {
    const list = this.projects.get(ownerId) ?? [];
    list.push(project);
    this.projects.set(ownerId, list);
    return this;
  }
  addDeployment(ownerId: string, d: VercelDeployment): this {
    this.deployments.push({ ...d, ownerId });
    return this;
  }
  /** Updates a stored deployment (state changes, cancellation, ...). */
  updateDeployment(id: string, patch: Partial<VercelDeployment>): this {
    const d = this.deployments.find((x) => x.id === id);
    if (!d) throw new Error(`no deployment ${id}`);
    Object.assign(d, patch);
    return this;
  }

  /**
   * Points a project's production target at a deployment, as a git
   * production deploy, a promotion or an instant rollback would. With
   * `aliasRequest`, also sets `lastAliasRequest`.
   */
  setProduction(
    ownerId: string,
    projectId: string,
    deploymentId: string,
    aliasRequest?: VercelAliasRequest | null,
  ): this {
    const project = (this.projects.get(ownerId) ?? []).find((x) => x.id === projectId);
    const d = this.deployments.find((x) => x.id === deploymentId);
    if (!project || !d) throw new Error("unknown project or deployment");
    project.targets = {
      ...(project.targets ?? {}),
      production: {
        id: d.id,
        createdAt: d.createdAt,
        ...(d.readyState ? { readyState: d.readyState } : {}),
        target: d.target ?? null,
        url: d.url ?? null,
      },
    };
    if (aliasRequest !== undefined) project.lastAliasRequest = aliasRequest;
    return this;
  }

  grant(token: string, userId: string, teamIds: string[] | null): this {
    this.tokens.set(token, { userId, teamIds });
    return this;
  }
  revoke(token: string): void {
    this.tokens.delete(token);
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const req: FakeRequest = {
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      authorization: headers.get("authorization"),
    };
    this.requests.push(req);

    if (method === "POST" && u.pathname === "/v2/oauth/access_token") {
      const form = new URLSearchParams(String(init.body));
      const code = this.oauthCodes.get(form.get("code") ?? "");
      if (
        !code ||
        form.get("client_id") !== this.clientId ||
        form.get("client_secret") !== this.clientSecret ||
        form.get("redirect_uri") !== code.redirectUri
      ) {
        return json(400, { error: "invalid_grant" });
      }
      this.oauthCodes.delete(code.code);
      this.grant(code.token, code.userId, code.teamId ? [code.teamId] : null);
      return json(200, {
        token_type: "Bearer",
        access_token: code.token,
        installation_id: code.configurationId,
        user_id: code.userId,
        team_id: code.teamId,
      });
    }

    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return json(429, { error: { code: "rate_limited" } }, rateHeaders(0));
    }

    const token = req.authorization?.replace(/^Bearer /, "") ?? "";
    const grant = this.tokens.get(token);
    if (!grant) return json(401, { error: { code: "forbidden", message: "Not authorized" } });

    if (method === "DELETE" && u.pathname.startsWith("/v1/integrations/configuration/")) {
      this.deletedConfigurations.push(decodeURIComponent(u.pathname.split("/").pop()!));
      this.revoke(token);
      return new Response(null, { status: 204 });
    }
    if (method !== "GET") return json(405, { error: { code: "method_not_allowed" } });

    const teamId = u.searchParams.get("teamId");
    const canTeam = (id: string) =>
      grant.teamIds === null ? this.teams.has(id) : grant.teamIds.includes(id);
    if (teamId && !canTeam(teamId)) return json(403, { error: { code: "forbidden" } });
    const owner = teamId ?? grant.userId;

    const p = u.pathname;
    if (p === "/v2/user") return json(200, { user: this.users.get(grant.userId) });
    if (p === "/v2/teams") {
      const teams = [...this.teams.values()].filter((t) => canTeam(t.id));
      return json(200, { teams, pagination: { count: teams.length, next: null, prev: null } });
    }
    const teamMatch = /^\/v2\/teams\/([^/]+)$/.exec(p);
    if (teamMatch) {
      const id = decodeURIComponent(teamMatch[1]!);
      const team = this.teams.get(id);
      if (!team) return json(404, { error: { code: "not_found" } });
      if (!canTeam(id)) return json(403, { error: { code: "forbidden" } });
      return json(200, team);
    }
    if (p === "/v9/projects") {
      // Vercel returns env values with projects; the client must strip them.
      const all = (this.projects.get(owner) ?? []).map((pr) => ({
        ...pr,
        env: [{ key: "SECRET", value: "env-SECRET-value" }],
      }));
      return this.page("projects", all, u, (x) => x.updatedAt ?? 0);
    }
    if (p === "/v6/deployments") {
      const projectId = u.searchParams.get("projectId");
      const since = Number(u.searchParams.get("since") ?? 0);
      const list: VercelDeploymentListItem[] = this.deployments
        .filter((d) => d.ownerId === owner && (!projectId || d.projectId === projectId))
        .filter((d) => d.createdAt >= since)
        .map((d) => ({
          uid: d.id,
          name: d.name,
          url: d.url ?? null,
          projectId: d.projectId,
          state: d.readyState ?? "READY",
          target: d.target ?? null,
          created: d.createdAt,
          ...(d.creator ? { creator: d.creator } : {}),
          ...(d.meta ? { meta: d.meta } : {}),
          ...captureFields(d),
        }));
      return this.page("deployments", list, u, (x) => x.created);
    }
    const projectMatch = /^\/v9\/projects\/([^/]+)$/.exec(p);
    if (projectMatch) {
      const id = decodeURIComponent(projectMatch[1]!);
      const project = (this.projects.get(owner) ?? []).find((x) => x.id === id);
      if (!project) return json(404, { error: { code: "not_found" } });
      return json(200, { ...project, env: [{ key: "SECRET", value: "env-SECRET-value" }] });
    }
    const depMatch = /^\/v13\/deployments\/([^/]+)$/.exec(p);
    if (depMatch) {
      const d = this.deployments.find(
        (x) => x.id === decodeURIComponent(depMatch[1]!) && x.ownerId === owner,
      );
      if (!d) return json(404, { error: { code: "not_found" } });
      const { ownerId: _o, ...rest } = d;
      return json(200, { ...rest, build: { env: ["SECRET"] }, env: ["SECRET"] });
    }
    return json(404, { error: { code: "not_found" } });
  };

  private page<T>(key: string, all: T[], u: URL, ts: (x: T) => number): Response {
    const until = u.searchParams.get("until");
    const sorted = [...all].sort((a, b) => ts(b) - ts(a));
    const remaining = until ? sorted.filter((x) => ts(x) < Number(until)) : sorted;
    const items = remaining.slice(0, this.pageSize);
    const more = remaining.length > items.length;
    return json(
      200,
      {
        [key]: items,
        pagination: {
          count: items.length,
          next: more ? ts(items[items.length - 1]!) : null,
          prev: null,
        },
      },
      rateHeaders(99),
    );
  }

  /** Builds a signed webhook delivery as Vercel would send it. */
  signedWebhook(
    body: object,
    secret: string = this.clientSecret,
  ): { payload: string; headers: Record<string, string> } {
    const payload = JSON.stringify(body);
    return {
      payload,
      headers: {
        "content-type": "application/json",
        "x-vercel-signature": signHmac("sha1", secret, payload),
      },
    };
  }
}

function captureFields(d: VercelDeployment): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    "source",
    "buildingAt",
    "ready",
    "canceledAt",
    "inspectorUrl",
    "aliasAssigned",
    "isRollbackCandidate",
    "customEnvironment",
    "readyState",
  ] as const) {
    if (d[k] !== undefined) out[k] = d[k];
  }
  return out;
}

/** In-memory `VercelCaptureStore` for connector tests. */
export class MemoryVercelCaptureStore implements VercelCaptureStore {
  pollState: VercelPollState | null = null;
  lastPolledAt: number | null = null;
  readonly production = new Map<string, ProductionState>();
  #locks = new Map<string, Promise<unknown>>();

  async loadPollState(): Promise<VercelPollState | null> {
    return this.pollState ? structuredClone(this.pollState) : null;
  }
  async savePollState(state: VercelPollState, polledAt: number): Promise<void> {
    this.pollState = structuredClone(state);
    this.lastPolledAt = polledAt;
  }
  async withProductionState<T>(
    projectId: string,
    fn: (current: ProductionState | null) => Promise<{ next?: ProductionState; result: T }>,
  ): Promise<T> {
    const prev = this.#locks.get(projectId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const current = this.production.get(projectId) ?? null;
      const { next, result } = await fn(current ? { ...current } : null);
      if (next) this.production.set(projectId, next);
      return result;
    });
    this.#locks.set(
      projectId,
      run.catch(() => {}),
    );
    return run;
  }
}

function rateHeaders(remaining: number): Record<string, string> {
  return {
    "x-ratelimit-limit": "100",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000)),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-vercel-id": "fra1::test", ...headers },
  });
}
