import https from "node:https";
import http from "node:http";
import { z } from "zod";
import {
  createSafeLookup,
  validateOutboundUrl,
  type OutboundUrlPolicy,
  type Secret,
} from "@afe/core/security";
import type { TerraformOperationInput } from "@afe/core";

export const workspaceId = z.string().regex(/^ws-[A-Za-z0-9]{1,64}$/);
export const runId = z.string().regex(/^run-[A-Za-z0-9]{1,64}$/);
export const policyCheckId = z.string().regex(/^polchk-[A-Za-z0-9]{1,64}$/);
export const remoteConnectionInput = z.strictObject({
  serverUrl: z.url().max(2048).default("https://app.terraform.io"),
  organization: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  workspaceId,
});
export const operationInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.enum(["terraform.plan", "terraform.run", "terraform.lock", "terraform.unlock"]),
  }),
  z.strictObject({
    action: z.enum([
      "terraform.apply",
      "terraform.discard",
      "terraform.cancel",
      "terraform.force_cancel",
    ]),
    runId,
  }),
  z.strictObject({ action: z.literal("terraform.policy_override"), runId, policyCheckId }),
]);
export const executeInput = z.strictObject({
  operation: operationInput,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.uuid(),
  confirmed: z.literal(true),
});

export interface RemoteResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type?: string } | null }>;
}
export interface RemoteDocument {
  data: RemoteResource | RemoteResource[];
  meta?: { pagination?: { "next-page"?: number | null } };
}
export class TerraformApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    super(`Terraform API returned ${status}.`);
  }
}

/** Only origins: no credentials, query, fragment, or custom base paths. */
export function terraformOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Use a Terraform server origin without a path or credentials.");
  return url.origin;
}

/** Separate from the CLI reporter. No automatic retries, including on mutations. */
export class TerraformClient {
  constructor(
    readonly serverUrl: string,
    readonly token: Secret<string>,
    readonly policy: OutboundUrlPolicy = {},
    readonly limits: {
      timeoutMs?: number;
      connectTimeoutMs?: number;
      maxResponseBytes?: number;
    } = {},
  ) {}
  async request(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
  ): Promise<RemoteDocument> {
    if (!/^\/api\/v2\/[A-Za-z0-9/?=&[\]_.%-]+$/.test(path) || path.includes(".."))
      throw new Error("Invalid Terraform API path.");
    const url = new URL(path, terraformOrigin(this.serverUrl));
    await validateOutboundUrl(url.href, this.policy);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method,
          lookup: createSafeLookup(this.policy),
          signal: AbortSignal.timeout(this.limits.timeoutMs ?? 15_000),
          headers: {
            authorization: `Bearer ${this.token.reveal()}`,
            accept: "application/vnd.api+json",
            ...(payload
              ? {
                  "content-type": "application/vnd.api+json",
                  "content-length": Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (response) => {
          const status = response.statusCode ?? 502;
          // Never follow redirects or expose provider bodies/errors (may contain secrets).
          if (status < 200 || status >= 300) {
            response.resume();
            reject(
              new TerraformApiError(
                status,
                /^\d{1,6}$/.test(String(response.headers["retry-after"]))
                  ? String(response.headers["retry-after"])
                  : null,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > (this.limits.maxResponseBytes ?? 2 * 1024 * 1024)) {
              reject(new Error("Terraform response exceeded the size limit."));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", () => reject(new Error("Terraform response interrupted.")));
          response.on("end", () => {
            try {
              resolve(
                size
                  ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as RemoteDocument)
                  : { data: [] },
              );
            } catch {
              reject(new Error("Invalid Terraform response."));
            }
          });
        },
      );
      request.on("socket", (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(
          () => request.destroy(new Error("Terraform connect timed out.")),
          this.limits.connectTimeoutMs ?? 5000,
        );
        socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () =>
          clearTimeout(timer),
        );
        socket.once("close", () => clearTimeout(timer));
      });
      request.on("error", () => reject(new Error("Terraform request failed or timed out.")));
      request.end(payload);
    });
  }
  async resource(path: string, id?: string, type?: string): Promise<RemoteResource> {
    const { data } = await this.request(path);
    if (
      !data ||
      Array.isArray(data) ||
      !data.attributes ||
      typeof data.attributes !== "object" ||
      typeof data.id !== "string" ||
      (id && data.id !== id) ||
      (type && data.type !== type)
    )
      throw new Error("Invalid Terraform resource identity.");
    return data;
  }
  identity() {
    return this.resource("/api/v2/account/details", undefined, "users");
  }
}
export const relatedId = (r: RemoteResource, name: string) =>
  r.relationships?.[name]?.data?.id ?? null;
export function flag(r: RemoteResource, section: "permissions" | "actions", name: string) {
  const v = r.attributes[section];
  return !!v && typeof v === "object" && name in v && (v as Record<string, unknown>)[name] === true;
}
export function operationPermission(
  input: TerraformOperationInput,
  workspace: RemoteResource,
  run?: RemoteResource,
  check?: RemoteResource,
): boolean {
  switch (input.action) {
    case "terraform.plan":
    case "terraform.run":
      return flag(workspace, "permissions", "can-queue-run");
    case "terraform.lock":
      return flag(workspace, "permissions", "can-lock");
    case "terraform.unlock":
      return flag(workspace, "permissions", "can-unlock");
    case "terraform.policy_override":
      return (
        !!check &&
        !!run &&
        flag(check, "permissions", "can-override") &&
        flag(run, "permissions", "can-override-policy-check")
      );
    case "terraform.apply":
      return !!run && flag(run, "permissions", "can-apply");
    case "terraform.discard":
      return !!run && flag(run, "permissions", "can-discard");
    case "terraform.cancel":
      return !!run && flag(run, "permissions", "can-cancel");
    case "terraform.force_cancel":
      return !!run && flag(run, "permissions", "can-force-cancel");
  }
}
export function operationAvailable(
  input: TerraformOperationInput,
  workspace: RemoteResource,
  run?: RemoteResource,
  check?: RemoteResource,
): boolean {
  switch (input.action) {
    case "terraform.plan":
    case "terraform.run":
      return (
        workspace.attributes.locked === false &&
        ["remote", "agent"].includes(String(workspace.attributes["execution-mode"]))
      );
    case "terraform.lock":
      return workspace.attributes.locked === false;
    case "terraform.unlock":
      return workspace.attributes.locked === true;
    case "terraform.policy_override":
      return (
        check?.attributes.status === "soft_failed" &&
        flag(check, "actions", "is-overridable") &&
        run?.attributes.status === "policy_override"
      );
    case "terraform.apply":
      return !!run && flag(run, "actions", "is-confirmable");
    case "terraform.discard":
      return !!run && flag(run, "actions", "is-discardable");
    case "terraform.cancel":
      return !!run && flag(run, "actions", "is-cancelable");
    case "terraform.force_cancel":
      return !!run && flag(run, "actions", "is-force-cancelable");
  }
}
export function mutation(input: TerraformOperationInput, wsId: string) {
  if (input.action === "terraform.plan" || input.action === "terraform.run")
    return {
      path: "/api/v2/runs",
      body: {
        data: {
          type: "runs",
          attributes: {
            "plan-only": input.action === "terraform.plan",
            "auto-apply": false,
            "is-destroy": false,
          },
          relationships: { workspace: { data: { type: "workspaces", id: wsId } } },
        },
      },
    };
  if (input.action === "terraform.lock" || input.action === "terraform.unlock")
    return { path: `/api/v2/workspaces/${wsId}/actions/${input.action.split(".")[1]}` };
  if (input.action === "terraform.policy_override")
    return { path: `/api/v2/policy-checks/${input.policyCheckId}/actions/override` };
  return {
    path: `/api/v2/runs/${input.runId}/actions/${input.action === "terraform.force_cancel" ? "force-cancel" : input.action.split(".")[1]}`,
  };
}
