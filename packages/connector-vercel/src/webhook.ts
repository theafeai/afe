import { type Secret, isTimestampFresh, verifyVercelSignature } from "@afe/core/security";
import { stripSensitive } from "./client.ts";

/**
 * Vercel webhook handling (pure logic). Deliveries are signed with
 * `x-vercel-signature: <hex HMAC-SHA1(raw body)>` keyed with the integration
 * client secret (integration webhooks) or the account webhook's secret.
 * https://vercel.com/docs/webhooks/webhooks-api#securing-webhooks
 */

/** Integration lifecycle events Afe acts on directly (connection status/config). */
export const LIFECYCLE_EVENT_TYPES = [
  "integration-configuration.removed",
  "integration-configuration.permission-upgraded",
  "integration-configuration.scope-change-confirmed",
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export function isLifecycleEvent(type: string): type is LifecycleEventType {
  return (LIFECYCLE_EVENT_TYPES as readonly string[]).includes(type);
}

export interface VercelWebhookEvent {
  /** Delivery id, used for replay rejection. */
  id: string;
  type: string;
  /** Epoch ms, inside the signed body. */
  createdAt: number;
  /** Team the event belongs to; null for personal accounts. */
  teamId: string | null;
  userId: string | null;
  /** Integration configuration id, when present (integration webhooks). */
  configurationId: string | null;
  /** Project the event concerns, when present. */
  projectId: string | null;
  /** For `scope-change-confirmed`: project ids the installation may now access, if listed. */
  configurationProjects: string[] | null;
  /** The event payload with environment-variable values removed. */
  payload: Record<string, unknown>;
}

export type VerifyWebhookResult =
  | { ok: true; event: VercelWebhookEvent }
  | { ok: false; reason: "bad_signature" | "malformed" | "stale" };

export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Verifies the signature over the raw bytes, then parses and checks the signed
 * `createdAt`. Only call parsing code on the result, never on the raw body.
 */
export function verifyVercelWebhook(input: {
  rawBody: Buffer;
  signature: string | string[] | undefined;
  secret: Secret<string>;
  now?: number;
  toleranceMs?: number;
}): VerifyWebhookResult {
  if (!verifyVercelSignature(input.rawBody, input.secret, input.signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  const event = parseVercelWebhookBody(input.rawBody);
  if (!event) return { ok: false, reason: "malformed" };
  if (
    !isTimestampFresh(
      event.createdAt,
      input.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS,
      input.now ?? Date.now(),
    )
  ) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, event };
}

/** Parses an already-verified body. Supports the current (`payload.team.id`) and legacy (`payload.teamId`) shapes. */
export function parseVercelWebhookBody(rawBody: Buffer): VercelWebhookEvent | null {
  let body: Record<string, unknown> | null;
  try {
    body = obj(JSON.parse(rawBody.toString("utf8")));
  } catch {
    return null;
  }
  if (!body) return null;
  const id = str(body.id);
  const type = str(body.type);
  const createdAt = typeof body.createdAt === "number" ? body.createdAt : NaN;
  const payload = obj(body.payload) ?? {};
  if (!id || !type || !Number.isFinite(createdAt)) return null;

  const team = obj(payload.team);
  const user = obj(payload.user);
  const configuration = obj(payload.configuration);
  const project = obj(payload.project);
  const deployment = obj(payload.deployment);
  const projects = configuration?.projects;

  return {
    id,
    type,
    createdAt,
    teamId: str(team?.id) ?? str(payload.teamId),
    userId: str(user?.id) ?? str(payload.userId),
    configurationId: str(configuration?.id) ?? str(payload.configurationId),
    projectId: str(project?.id) ?? str(payload.projectId) ?? str(deployment?.projectId),
    configurationProjects: Array.isArray(projects)
      ? projects.filter((p): p is string => typeof p === "string")
      : null,
    payload: stripSensitive(payload),
  };
}
