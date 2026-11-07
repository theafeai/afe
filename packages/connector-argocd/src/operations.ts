/** Explicit action transport, separate from the GET-only observer. Never retries. */
import tls from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import { createSafeLookup, validateOutboundUrl } from "@afe/core/security";
import { ARGOCD_OPERATIONS, type ArgoCdOperation, type ArgoCdResource } from "@afe/core";
import { ArgoCdClient, readLimited } from "./client.ts";
import { createArgoCdTransport } from "./transport.ts";
import type { CreateClientOptions } from "./connect.ts";
import { apiUrl } from "./server-url.ts";
import { statusError, toArgoCdError } from "./errors.ts";

export interface ArgoCdActionClient {
  read: ArgoCdClient;
  request<T>(
    path: string,
    method?: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ): Promise<T>;
  close(): Promise<void>;
}
export function createArgoCdActionClient(options: CreateClientOptions): ArgoCdActionClient {
  const transport = createArgoCdTransport({ ...options, caPem: options.config.caPem ?? undefined });
  const roots = tls.getCACertificates?.("default") ?? [...tls.rootCertificates];
  const agent = new Agent({
    connect: {
      lookup: createSafeLookup(options.policy),
      timeout: 10_000,
      ...(options.config.caPem ? { ca: [...roots, options.config.caPem] } : {}),
    },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });
  const read = new ArgoCdClient({
    serverUrl: options.config.serverUrl,
    token: options.token,
    get: transport.get,
    retries: 0,
    timeoutMs: 15_000,
    maxResponseBytes: 2 * 1024 * 1024,
  });
  return {
    read,
    async request<T>(
      path: string,
      method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
      body?: unknown,
    ): Promise<T> {
      const url = apiUrl(options.config.serverUrl, path);
      await validateOutboundUrl(url.href, options.policy);
      try {
        const token = await options.token();
        const res = await undiciFetch(url, {
          method,
          redirect: "manual",
          dispatcher: agent,
          signal: AbortSignal.timeout(15_000),
          headers: {
            authorization: `Bearer ${token.reveal()}`,
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": "afe-argocd-actions",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (res.status < 200 || res.status >= 300) {
          await res.body?.cancel();
          throw statusError(res.status, "ArgoCD operation");
        }
        const text = await readLimited(res, 2 * 1024 * 1024, "ArgoCD operation");
        return (text ? JSON.parse(text) : null) as T;
      } catch (e) {
        throw toArgoCdError(e, url.host);
      }
    },
    async close() {
      await Promise.all([transport.close(), agent.close()]);
    },
  };
}
export function argoCdApplicationPath(
  name: string,
  namespace: string,
  project: string,
  suffix = "",
  extra: Record<string, string> = {},
) {
  const q = new URLSearchParams({ appNamespace: namespace, project, ...extra });
  return `/api/v1/applications/${encodeURIComponent(name)}${suffix}?${q}`;
}
export const argoCdResourceQuery = (r: ArgoCdResource) => ({
  group: r.group,
  kind: r.kind,
  namespace: r.namespace,
  resourceName: r.name,
});
export function argoCdPermission(action: ArgoCdOperation, params: Record<string, unknown>): string {
  if (action === "argocd.resource_action") {
    const r = params.resource as ArgoCdResource;
    return `action/${r.group}/${r.kind}/${params.name}`;
  }
  return ARGOCD_OPERATIONS.find((o) => o[0] === action)![2];
}
