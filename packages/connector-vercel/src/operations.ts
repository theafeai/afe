import { z } from "zod";
import type { VercelIntent, VercelOperation } from "@afe/core";
import {
  VercelApiError,
  VercelClient,
  VercelRateLimitError,
  VERCEL_API_URL,
  type TokenSource,
  type FetchLike,
} from "./client.ts";

export const sourceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const deployment = z.object({ deploymentId: sourceId }).strict();
const target = z.enum(["preview", "production"]);
const schemas = {
  "vercel.deploy": z
    .object({
      ref: z.string().regex(/^[a-fA-F0-9]{40}$/),
      target,
    })
    .strict(),
  "vercel.redeploy": deployment.extend({ target }).strict(),
  "vercel.cancel": deployment,
  "vercel.promote": deployment,
  "vercel.rollback": deployment,
  "vercel.delete": deployment,
  "vercel.alias_assign": deployment
    .extend({
      domain: z
        .string()
        .max(253)
        .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    })
    .strict(),
  "vercel.configure": z
    .object({ autoAssignCustomDomains: z.boolean(), previewDeploymentsDisabled: z.boolean() })
    .strict(),
};
export const vercelOperationSchema = (action: VercelOperation) => z.toJSONSchema(schemas[action]);

export function parseVercelIntent(value: unknown): VercelIntent {
  const b = z
    .object({
      action: z.enum(Object.keys(schemas) as [VercelOperation, ...VercelOperation[]]),
      params: z.unknown(),
    })
    .strict()
    .parse(value);
  return { action: b.action, params: schemas[b.action].parse(b.params) };
}

/** Dedicated opt-in transport. No automatic retries, redirects or raw error bodies. */
export class VercelActionClient {
  readonly reader: VercelClient;
  constructor(
    private readonly token: TokenSource,
    private readonly transport: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.reader = new VercelClient({ token, fetch: transport, maxRetries: 0 });
  }
  async mutate(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    teamId: string | null,
    body?: unknown,
  ) {
    if (!/^\/v\d+\/[A-Za-z0-9_/-]+$/.test(path)) throw new Error("Invalid action path");
    const url = new URL(VERCEL_API_URL + path);
    if (teamId) url.searchParams.set("teamId", teamId);
    const token = typeof this.token === "function" ? await this.token() : this.token;
    const res = await this.transport(url.toString(), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token.reveal()}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 429) throw new VercelRateLimitError(null, path, null);
      throw new VercelApiError(res.status, null, null, path);
    }
    // Keep only a new deployment identity. Never expose upstream configuration or secrets.
    const reader = res.body?.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > 1024 * 1024) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        chunks.push(next.value);
      }
    const text = Buffer.concat(chunks).toString("utf8");
    const data = text ? (JSON.parse(text) as { id?: unknown }) : {};
    return {
      status: res.status,
      deploymentId:
        typeof data.id === "string" && sourceId.safeParse(data.id).success ? data.id : undefined,
    };
  }
}
