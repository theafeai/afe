import type { Secret } from "@afe/core/security";
import { ArgoCdError, statusError, toArgoCdError } from "./errors.ts";
import { apiUrl } from "./server-url.ts";
import { readJsonLines, readSseStream, SseParseError } from "./sse.ts";
import type { HttpGet, HttpResponse } from "./transport.ts";
import type {
  ArgoCdApplication,
  ArgoCdApplicationList,
  ArgoCdApplicationWatchEvent,
  ArgoCdCanIResponse,
  ArgoCdKubeEventList,
  ArgoCdUserInfo,
  ArgoCdVersion,
} from "./types.ts";

/** Supplies the API token at the point of use, so rotation/revocation apply on the next call. */
export type TokenProvider = () => Secret<string> | Promise<Secret<string>>;

export interface ArgoCdClientOptions {
  /** Normalised server URL (see `normaliseServerUrl`). */
  serverUrl: string;
  token: TokenProvider;
  /** Transport; production uses `createArgoCdTransport(...).get`. */
  get: HttpGet;
  /** Total timeout per non-streaming request; default 30 s. */
  timeoutMs?: number;
  /** Response size limit for non-streaming requests; default 32 MiB. */
  maxResponseBytes?: number;
  /** Retries for retryable failures (5xx, 429, network); default 2. */
  retries?: number;
  /** Backoff base in ms (doubled per attempt, with jitter); default 500. */
  backoffMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ListApplicationsOptions {
  /** Project names (`projects=` query, repeated). */
  projects?: string[];
  /** Kubernetes label selector. */
  selector?: string;
  /**
   * Partial response field paths, e.g. `["items.metadata.name", "items.status.sync"]`
   * (ArgoCD `fields=`), to keep responses small. Afe never needs manifests.
   */
  fields?: string[];
  /** Namespace of the Application objects (apps-in-any-namespace). */
  appNamespace?: string;
  /** Filter by repository URL. */
  repo?: string;
  resourceVersion?: string;
}

export interface GetApplicationOptions {
  appNamespace?: string;
  project?: string;
}

export interface WatchApplicationsOptions {
  /** Watch one application only. */
  name?: string;
  projects?: string[];
  selector?: string;
  appNamespace?: string;
  /** Resume after this resourceVersion (from a list or a previous event). */
  resourceVersion?: string;
  /** Partial fields, e.g. `["result.type", "result.application.metadata"]`. */
  fields?: string[];
  signal?: AbortSignal;
  /**
   * Called once the server has accepted the watch (response headers
   * received), before any event. AFE-10 starts a catch-up reconciliation
   * here, so nothing that changed while disconnected is missed.
   */
  onOpen?: () => void;
}

export interface ListApplicationEventsOptions {
  appNamespace?: string;
  project?: string;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read-only ArgoCD REST client. It can only issue GET requests (the transport
 * has no other method), authenticates with a bearer API token, never follows
 * redirects and limits response sizes.
 */
export class ArgoCdClient {
  readonly serverUrl: string;
  readonly #token: TokenProvider;
  readonly #get: HttpGet;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #retries: number;
  readonly #backoffMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #host: string;

  constructor(options: ArgoCdClientOptions) {
    this.serverUrl = options.serverUrl;
    this.#token = options.token;
    this.#get = options.get;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
    this.#retries = options.retries ?? 2;
    this.#backoffMs = options.backoffMs ?? 500;
    this.#sleep = options.sleep ?? sleepDefault;
    this.#host = new URL(options.serverUrl).host;
  }

  /** `GET /api/version`. Works without RBAC permissions. */
  getVersion(): Promise<ArgoCdVersion> {
    return this.#getJson<ArgoCdVersion>("/api/version", "get version");
  }

  /** `GET /api/v1/session/userinfo`: who the token belongs to. */
  getUserInfo(): Promise<ArgoCdUserInfo> {
    return this.#getJson<ArgoCdUserInfo>("/api/v1/session/userinfo", "get user info");
  }

  /**
   * `GET /api/v1/account/can-i/{resource}/{action}/{subresource}`: whether the
   * token's account may perform `action`. Returns true for "yes".
   */
  async canI(resource: string, action: string, subresource: string): Promise<boolean> {
    // The subresource may contain "/" (project/app); ArgoCD's route accepts it
    // unescaped, so encode each segment separately.
    const sub = subresource.split("/").map(encodeURIComponent).join("/");
    const res = await this.#getJson<ArgoCdCanIResponse>(
      `/api/v1/account/can-i/${encodeURIComponent(resource)}/${encodeURIComponent(action)}/${sub}`,
      "check permission",
    );
    return res.value === "yes";
  }

  /** `GET /api/v1/applications`. */
  listApplications(options: ListApplicationsOptions = {}): Promise<ArgoCdApplicationList> {
    const q = new URLSearchParams();
    for (const p of options.projects ?? []) q.append("projects", p);
    if (options.selector) q.set("selector", options.selector);
    if (options.fields?.length) q.set("fields", options.fields.join(","));
    if (options.appNamespace) q.set("appNamespace", options.appNamespace);
    if (options.repo) q.set("repo", options.repo);
    if (options.resourceVersion) q.set("resourceVersion", options.resourceVersion);
    const qs = q.toString();
    return this.#getJson<ArgoCdApplicationList>(
      `/api/v1/applications${qs ? `?${qs}` : ""}`,
      "list applications",
    );
  }

  /** `GET /api/v1/applications/{name}`. */
  getApplication(name: string, options: GetApplicationOptions = {}): Promise<ArgoCdApplication> {
    const q = new URLSearchParams();
    if (options.appNamespace) q.set("appNamespace", options.appNamespace);
    if (options.project) q.set("project", options.project);
    const qs = q.toString();
    return this.#getJson<ArgoCdApplication>(
      `/api/v1/applications/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`,
      "get application",
    );
  }

  /**
   * `GET /api/v1/applications/{name}/events`: Kubernetes Events about the
   * Application object itself (who created/updated/synced/rolled it back).
   * Covered by `applications, get`. Kubernetes keeps events for about an hour
   * (`--event-ttl`), so this is only useful shortly after a change.
   */
  listApplicationEvents(
    name: string,
    options: ListApplicationEventsOptions = {},
  ): Promise<ArgoCdKubeEventList> {
    const q = new URLSearchParams();
    if (options.appNamespace) q.set("appNamespace", options.appNamespace);
    if (options.project) q.set("project", options.project);
    const qs = q.toString();
    return this.#getJson<ArgoCdKubeEventList>(
      `/api/v1/applications/${encodeURIComponent(name)}/events${qs ? `?${qs}` : ""}`,
      "list application events",
    );
  }

  /**
   * `GET /api/v1/stream/applications`: watch Application changes (AFE-10).
   * Yields `{ type, application }` until the server closes the stream or
   * `signal` aborts. Not retried here: the caller reconnects with the last
   * `resourceVersion` and records an observation gap if it cannot.
   */
  async *watchApplications(
    options: WatchApplicationsOptions = {},
  ): AsyncGenerator<ArgoCdApplicationWatchEvent> {
    const q = new URLSearchParams();
    if (options.name) q.set("name", options.name);
    for (const p of options.projects ?? []) q.append("projects", p);
    if (options.selector) q.set("selector", options.selector);
    if (options.appNamespace) q.set("appNamespace", options.appNamespace);
    if (options.resourceVersion) q.set("resourceVersion", options.resourceVersion);
    if (options.fields?.length) q.set("fields", options.fields.join(","));
    const qs = q.toString();
    for await (const item of this.streamJson(
      `/api/v1/stream/applications${qs ? `?${qs}` : ""}`,
      "watch applications",
      options.signal,
      options.onOpen,
    )) {
      const result = (item as { result?: ArgoCdApplicationWatchEvent }).result;
      if (result && typeof result === "object" && result.application) yield result;
    }
  }

  /**
   * Generic reader for ArgoCD (grpc-gateway) server-streaming endpoints. Asks
   * for `text/event-stream` and parses SSE `data:` frames as JSON; falls back to
   * newline-delimited JSON if the server answers with plain JSON. Frames of the
   * form `{"error": {...}}` end the stream with an `ArgoCdError`.
   */
  async *streamJson(
    path: string,
    what: string,
    signal?: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<unknown> {
    const res = await this.#send(path, what, { stream: true, signal, accept: "text/event-stream" });
    onOpen?.();
    if (!res.body) return;
    const contentType = res.headers.get("content-type") ?? "";
    const frames: AsyncIterable<unknown> = contentType.includes("text/event-stream")
      ? (async function* () {
          for await (const msg of readSseStream(res.body!)) {
            if (!msg.data) continue;
            try {
              yield JSON.parse(msg.data);
            } catch {
              throw new SseParseError("stream contained invalid JSON");
            }
          }
        })()
      : readJsonLines(res.body);
    try {
      for await (const frame of frames) {
        const err = (frame as { error?: { message?: string; http_code?: number; code?: number } })
          ?.error;
        if (err) {
          const status = err.http_code;
          throw status
            ? statusError(status, what)
            : new ArgoCdError("invalid_response", `${what}: stream reported an error`);
        }
        yield frame;
      }
    } catch (e) {
      if (e instanceof ArgoCdError) throw e;
      if (e instanceof SseParseError) {
        throw new ArgoCdError("invalid_response", `${what}: ${e.message}`);
      }
      throw toArgoCdError(e, this.#host);
    }
  }

  async #getJson<T>(path: string, what: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.#send(path, what, {});
        const text = await readLimited(res, this.#maxBytes, what);
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new ArgoCdError("invalid_response", `${what}: response is not JSON`);
        }
      } catch (e) {
        const err = toArgoCdError(e, this.#host);
        if (!err.retryable || attempt >= this.#retries) throw err;
        const base = this.#backoffMs * 2 ** attempt;
        await this.#sleep(base / 2 + Math.random() * (base / 2));
      }
    }
  }

  async #send(
    path: string,
    what: string,
    opts: { stream?: boolean; signal?: AbortSignal | undefined; accept?: string },
  ): Promise<HttpResponse> {
    const token = (await this.#token()).reveal();
    const signals: AbortSignal[] = [];
    if (opts.signal) signals.push(opts.signal);
    if (!opts.stream) signals.push(AbortSignal.timeout(this.#timeoutMs));
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    let res: HttpResponse;
    try {
      res = await this.#get(apiUrl(this.serverUrl, path), {
        headers: {
          authorization: `Bearer ${token}`,
          accept: opts.accept ?? "application/json",
          "user-agent": "afe-argocd-connector",
        },
        signal,
        stream: opts.stream === true,
      });
    } catch (e) {
      throw toArgoCdError(e, this.#host);
    }
    if (res.status < 200 || res.status >= 300) {
      await discard(res);
      throw statusError(res.status, what);
    }
    return res;
  }
}

async function discard(res: HttpResponse): Promise<void> {
  try {
    const body = res.body as { cancel?: () => Promise<void> } | null;
    if (body?.cancel) await body.cancel();
  } catch {
    // ignore
  }
}

/** Reads a response body as UTF-8 text, failing once it exceeds `max` bytes. */
export async function readLimited(res: HttpResponse, max: number, what: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await discard(res);
    throw new ArgoCdError("too_large", `${what}: response exceeds ${max} bytes`);
  }
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) {
      await discard(res);
      throw new ArgoCdError("too_large", `${what}: response exceeds ${max} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
