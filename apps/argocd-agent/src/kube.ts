/**
 * Read-only Kubernetes API client for what the agent needs: list and watch
 * `applications.argoproj.io/v1alpha1` and (optionally) list the core/v1
 * Events about one Application. Only GET requests exist in this file.
 *
 * Authentication: the pod's ServiceAccount token, re-read from the projected
 * token file on every request (kubelet rotates it), and the cluster CA.
 *
 * API conventions relied on (https://kubernetes.io/docs/reference/using-api/api-concepts/):
 * - list with `limit`/`continue` pagination; `metadata.resourceVersion` of the
 *   list is the point to start a watch from;
 * - `?watch=1&resourceVersion=RV&allowWatchBookmarks=true&timeoutSeconds=N`
 *   streams newline-delimited `{"type","object"}` frames (ADDED, MODIFIED,
 *   DELETED, BOOKMARK, ERROR); an ERROR with a Status `code: 410` (or a 410
 *   response) means the resourceVersion is too old: list again.
 */
import { readFile } from "node:fs/promises";
import { readJsonLines } from "@afe/connector-argocd/sse";
import type { ArgoCdApplication, ArgoCdKubeEvent } from "@afe/connector-argocd";
import { HttpError, request } from "./http.ts";

export const APPLICATIONS_API = "/apis/argoproj.io/v1alpha1";

export class KubeError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network errors. 410 = resourceVersion expired. */
    readonly status: number,
  ) {
    super(message);
    this.name = "KubeError";
  }
}

export interface KubeClientOptions {
  /** e.g. https://kubernetes.default.svc (from KUBERNETES_SERVICE_HOST/PORT). */
  baseUrl: string;
  /** ServiceAccount token (a function so the projected token file is re-read). */
  token: () => Promise<string> | string;
  /** Cluster CA (PEM). */
  ca?: string;
  /** Socket idle timeout for list/get requests. */
  timeoutMs?: number;
}

export interface ApplicationList {
  resourceVersion: string;
  continue?: string;
  items: ArgoCdApplication[];
}

export interface WatchFrame {
  type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK";
  object: ArgoCdApplication;
}

/** Reads a file each time it is needed (projected ServiceAccount tokens rotate). */
export function fileToken(path: string): () => Promise<string> {
  return async () => (await readFile(path, "utf8")).trim();
}

export class KubeClient {
  readonly #o: KubeClientOptions;

  constructor(options: KubeClientOptions) {
    this.#o = options;
  }

  #path(namespace: string | null, resource = "applications"): string {
    return namespace
      ? `${APPLICATIONS_API}/namespaces/${encodeURIComponent(namespace)}/${resource}`
      : `${APPLICATIONS_API}/${resource}`;
  }

  async #get(path: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const token = await this.#o.token();
    try {
      return await request({
        url: new URL(path, this.#o.baseUrl).toString(),
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        ...(this.#o.ca ? { ca: this.#o.ca } : {}),
        timeoutMs: opts.timeoutMs ?? this.#o.timeoutMs ?? 30_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      if (e instanceof HttpError) throw new KubeError(`kubernetes API: ${e.message}`, 0);
      throw e;
    }
  }

  async #json<T>(path: string): Promise<T> {
    const res = await this.#get(path);
    if (res.status !== 200) {
      res.discard();
      throw new KubeError(`kubernetes API answered ${res.status} for GET ${pathOnly(path)}`, res.status);
    }
    try {
      return JSON.parse(await res.text()) as T;
    } catch (e) {
      if (e instanceof HttpError) throw new KubeError(`kubernetes API: ${e.message}`, 0);
      throw new KubeError("kubernetes API returned invalid JSON", 0);
    }
  }

  /** `GET /version` (gitVersion), for the heartbeat. */
  async version(): Promise<string | undefined> {
    const v = await this.#json<{ gitVersion?: string }>("/version");
    return typeof v.gitVersion === "string" ? v.gitVersion.slice(0, 64) : undefined;
  }

  /** One page of applications. */
  async listApplications(
    namespace: string | null,
    page: { limit: number; continue?: string },
  ): Promise<ApplicationList> {
    const q = new URLSearchParams({ limit: String(page.limit) });
    if (page.continue) q.set("continue", page.continue);
    const list = await this.#json<{
      metadata?: { resourceVersion?: string; continue?: string };
      items?: ArgoCdApplication[] | null;
    }>(`${this.#path(namespace)}?${q}`);
    return {
      resourceVersion: list.metadata?.resourceVersion ?? "",
      ...(list.metadata?.continue ? { continue: list.metadata.continue } : {}),
      items: list.items ?? [],
    };
  }

  /**
   * Watches applications from `resourceVersion` until the server ends the
   * watch (`timeoutSeconds`), `signal` aborts, or an error (KubeError 410:
   * list again).
   */
  async *watchApplications(
    namespace: string | null,
    resourceVersion: string,
    opts: { signal?: AbortSignal; timeoutSeconds?: number } = {},
  ): AsyncGenerator<WatchFrame> {
    const timeoutSeconds = opts.timeoutSeconds ?? 300;
    const q = new URLSearchParams({
      watch: "1",
      resourceVersion,
      allowWatchBookmarks: "true",
      timeoutSeconds: String(timeoutSeconds),
    });
    const res = await this.#get(`${this.#path(namespace)}?${q}`, {
      // Idle timeout above the server-side watch timeout; bookmarks keep it alive.
      timeoutMs: (timeoutSeconds + 60) * 1000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status !== 200) {
      res.discard();
      throw new KubeError(`kubernetes watch answered ${res.status}`, res.status);
    }
    try {
      for await (const raw of readJsonLines(res.stream)) {
        const frame = raw as { type?: string; object?: Record<string, unknown> };
        if (frame.type === "ERROR") {
          const code = Number((frame.object as { code?: number } | undefined)?.code ?? 500);
          throw new KubeError(`kubernetes watch error ${code}`, code);
        }
        if (
          frame.type === "ADDED" ||
          frame.type === "MODIFIED" ||
          frame.type === "DELETED" ||
          frame.type === "BOOKMARK"
        ) {
          yield { type: frame.type, object: (frame.object ?? {}) as ArgoCdApplication };
        }
      }
    } catch (e) {
      if (e instanceof KubeError) throw e;
      if (opts.signal?.aborted) return;
      throw new KubeError("kubernetes watch stream broke", 0);
    }
  }

  /** core/v1 Events about one Application (actor attribution). */
  async listApplicationEvents(
    namespace: string,
    uid: string,
    limit = 100,
  ): Promise<ArgoCdKubeEvent[]> {
    const q = new URLSearchParams({
      fieldSelector: `involvedObject.kind=Application,involvedObject.uid=${uid}`,
      limit: String(limit),
    });
    const list = await this.#json<{ items?: ArgoCdKubeEvent[] | null }>(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/events?${q}`,
    );
    return list.items ?? [];
  }
}

const pathOnly = (p: string) => p.split("?")[0];
