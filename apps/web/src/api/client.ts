import type {
  ArgoCdConnectResult,
  ArgoCdConnection,
  ArgoCdTestResult,
  AuditVerifyResult,
  ConnectionHealthDetail,
  ConnectionWithHealth,
  DeploymentRow,
  EventDetail,
  EventItem,
  GitHubAppStatus,
  Page,
  ProjectSelection,
  VercelConnectionView,
  VercelIntegrationStatus,
  VercelProjects,
} from "./types.ts";

/**
 * An API call that did not succeed. `status` is 0 for network failures.
 * `code` is the API's machine-readable `error` field when present and
 * `body` the parsed JSON body (e.g. `writeCapabilities` on a 422).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const FRIENDLY: Record<string, string> = {
  not_found: "Not found.",
  bad_request: "The request was not accepted.",
  connection_revoked:
    "Afe's access to this connection was revoked or expired. Reconnect it to continue.",
  vercel_rate_limited: "Vercel is rate limiting Afe. Try again in a minute.",
  vercel_unavailable: "Vercel did not answer. Try again later.",
  token_rejected: "Vercel rejected the token.",
  team_not_accessible: "The token cannot access that team (check the team id and token scope).",
  invalid_token: "Enter a Vercel access token.",
  invalid_team_id: "The team id is not valid (letters, digits, _ and - only).",
  invalid_webhook_secret: "The webhook secret must be 16 to 512 characters.",
  invalid_selection: "The project selection is not valid.",
  unknown_projects: "Some selected projects no longer exist in Vercel.",
  token_not_read_only:
    "The token can modify ArgoCD. Create a dedicated account with the read-only role.",
};

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Builds an `ApiError` from a failed response body (JSON or text). */
export function toApiError(status: number, body: unknown): ApiError {
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const code = typeof obj?.error === "string" ? obj.error : `http_${status}`;
  const message =
    (typeof obj?.message === "string" && obj.message) ||
    FRIENDLY[code] ||
    (obj && typeof obj.error === "string" && obj.error.includes(" ") ? obj.error : null) ||
    (status >= 500
      ? `The Afe server failed (HTTP ${status}). Check the server logs.`
      : `Request failed (HTTP ${status}).`);
  return new ApiError(status, code, message, obj);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Tests replace the transport. */
export function setFetch(f: FetchLike): void {
  fetchImpl = f;
}

export async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
      credentials: "same-origin",
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Cannot reach the Afe server. Is it running?");
  }
  const parsed = await parseBody(res);
  if (!res.ok) throw toApiError(res.status, parsed);
  if (parsed === null || typeof parsed !== "object") {
    throw new ApiError(res.status, "invalid_response", "The server sent an unexpected response.");
  }
  return parsed as T;
}

const get = <T>(url: string, signal?: AbortSignal) => request<T>("GET", url, undefined, signal);

function withQuery(path: string, params: URLSearchParams | Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return q ? `${path}?${q}` : path;
}

export const api = {
  events: (params: URLSearchParams, signal?: AbortSignal) =>
    get<Page<EventItem>>(withQuery("/api/events", params), signal),
  event: (id: string, signal?: AbortSignal) =>
    get<EventDetail>(`/api/events/${encodeURIComponent(id)}`, signal),
  deployments: (params: URLSearchParams, signal?: AbortSignal) =>
    get<Page<DeploymentRow>>(withQuery("/api/deployments", params), signal),
  verifyAuditLog: (signal?: AbortSignal) => get<AuditVerifyResult>("/api/audit/verify", signal),
  exportUrl: (params: URLSearchParams, format: "json" | "csv") => {
    const q = new URLSearchParams(params);
    q.set("format", format);
    return withQuery("/api/export", q);
  },

  connections: (signal?: AbortSignal) =>
    get<{ connections: ConnectionWithHealth[] }>("/api/connections", signal),
  connectionHealth: (id: string, signal?: AbortSignal) =>
    get<ConnectionHealthDetail>(`/api/connections/${encodeURIComponent(id)}/health`, signal),

  githubApp: (signal?: AbortSignal) => get<GitHubAppStatus>("/api/connections/github/app", signal),

  argocdConnections: (signal?: AbortSignal) =>
    get<{ connections: ArgoCdConnection[] }>("/api/connections/argocd", signal),
  argocdConnect: (body: { url: string; token: string; caPem?: string; name?: string }) =>
    request<ArgoCdConnectResult>("POST", "/api/connections/argocd", body),
  argocdTest: (id: string) =>
    request<ArgoCdTestResult & { ok: boolean }>(
      "POST",
      `/api/connections/argocd/${encodeURIComponent(id)}/test`,
    ),
  argocdDisconnect: (id: string) =>
    request<{ connection: ArgoCdConnection }>(
      "DELETE",
      `/api/connections/argocd/${encodeURIComponent(id)}`,
    ),

  vercelIntegration: (signal?: AbortSignal) =>
    get<VercelIntegrationStatus>("/api/connections/vercel/integration", signal),
  vercelConnectToken: (body: { token: string; teamId?: string; webhookSecret?: string }) =>
    request<{ connection: VercelConnectionView; warnings: string[] }>(
      "POST",
      "/api/connections/vercel",
      body,
    ),
  vercelProjects: (id: string, signal?: AbortSignal) =>
    get<VercelProjects>(`/api/connections/vercel/${encodeURIComponent(id)}/projects`, signal),
  vercelSaveProjects: (id: string, body: { projects: "all" } | { projectIds: string[] }) =>
    request<{ selection: ProjectSelection }>(
      "PUT",
      `/api/connections/vercel/${encodeURIComponent(id)}/projects`,
      body,
    ),
  vercelDisconnect: (id: string) =>
    request<{
      connection: VercelConnectionView;
      vercelIntegrationRemoved: boolean;
      note?: string;
    }>("DELETE", `/api/connections/vercel/${encodeURIComponent(id)}`),
};
