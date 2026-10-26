/**
 * Event capture shared by webhook processing and polling (AFE-12): the state
 * store interface, production-alias change recording and the `vercel.webhook`
 * job's mapping. Pure logic over injected `ScopedVercelReader`, `EventSink`
 * and `VercelCaptureStore`; the server provides the PostgreSQL store.
 */
import type { ActorRef, EventSink, IngestResult } from "@afe/core";
import { VercelApiError } from "./client.ts";
import {
  type DeploymentInfo,
  type ProductionState,
  type Provenance,
  classifyProductionChange,
  lifecycleEvent,
  normalizeDeployment,
  productionChangeEvent,
} from "./mapping.ts";
import {
  type ProjectSelection,
  type ScopedVercelReader,
  ProjectNotSelectedError,
  isProjectSelected,
} from "./selection.ts";
import type { VercelAliasRequest, VercelProject } from "./types.ts";

/** A deployment whose final state Afe has not recorded yet. */
export interface OpenDeployment {
  id: string;
  projectId: string;
  createdAt: number;
}

/** Per-connection polling state (migration 0011 `vercel_poll_state`). */
export interface VercelPollState {
  /**
   * Deployments created before this time (epoch ms) have had their `created`
   * event recorded. Null until the first poll (which backfills).
   */
  cursor: number | null;
  /** Non-terminal deployments to re-check even when outside the poll window. */
  openDeployments: OpenDeployment[];
  /** Projects whose history was already backfilled. */
  backfilled: ProjectSelection;
}

/** State storage for one connection (tenant and connection are bound in). */
export interface VercelCaptureStore {
  loadPollState(): Promise<VercelPollState | null>;
  savePollState(state: VercelPollState, polledAt: number): Promise<void>;
  /**
   * Runs `fn` with the project's production state locked against concurrent
   * webhook and poll processing, then stores `next` (when given).
   */
  withProductionState<T>(
    projectId: string,
    fn: (current: ProductionState | null) => Promise<{ next?: ProductionState; result: T }>,
  ): Promise<T>;
}

/**
 * Records what Afe sees as a project's production deployment and emits a
 * promotion/rollback event when the change is one (see `classifyProductionChange`).
 *
 * A webhook for a change a poll already recorded describes the same
 * from→to transition (`previousDeploymentId`), so it produces the same
 * idempotency key and is deduplicated.
 */
export async function observeProduction(input: {
  store: VercelCaptureStore;
  sink: EventSink;
  tenantId: string;
  projectId: string;
  current: DeploymentInfo;
  aliasRequest?: VercelAliasRequest | null;
  provenance: Provenance;
  /** Set for `deployment.promoted` webhooks. */
  webhook?: { at: number; actor: ActorRef | null } | null;
  /** False when the project no longer shows `current` as production: record the event, keep the state. */
  isLive?: boolean;
  raw: unknown;
  /** Loads the full deployment; called only when production differs from the stored state. */
  enrich?: (raw: unknown) => Promise<{ current: DeploymentInfo; raw: unknown } | null>;
}): Promise<IngestResult | null> {
  const now = input.provenance.observedAt.getTime();
  return input.store.withProductionState(input.projectId, async (state) => {
    let { current, raw } = input;
    if (input.enrich && state?.deploymentId !== current.id) {
      const full = await input.enrich(raw);
      if (full) ({ current, raw } = full);
    }
    let previous: Pick<
      ProductionState,
      "deploymentId" | "deploymentCreatedAt" | "lastSeenAt"
    > | null = state;
    const alreadyCurrent = state !== null && state.deploymentId === current.id;
    if (alreadyCurrent) {
      if (!input.webhook) {
        return { next: { ...state, lastSeenAt: Math.max(state.lastSeenAt, now) }, result: null };
      }
      previous = state.previousDeploymentId
        ? {
            deploymentId: state.previousDeploymentId,
            deploymentCreatedAt: state.previousDeploymentCreatedAt,
            lastSeenAt: state.changedAt,
          }
        : null;
    }
    const change = classifyProductionChange({
      previous,
      current,
      aliasRequest: input.aliasRequest ?? null,
      webhookAt: input.webhook?.at ?? null,
    });
    const result = change
      ? await input.sink.ingest(
          input.tenantId,
          productionChangeEvent({
            projectId: input.projectId,
            deployment: current,
            change,
            provenance: input.provenance,
            actor: input.webhook?.actor ?? null,
            raw,
          }),
        )
      : null;
    if (input.isLive === false) return { result };
    const next: ProductionState = alreadyCurrent
      ? { ...state, lastSeenAt: Math.max(state.lastSeenAt, now) }
      : {
          deploymentId: current.id,
          deploymentCreatedAt: current.createdAt,
          previousDeploymentId: change?.fromDeploymentId ?? state?.deploymentId ?? null,
          previousDeploymentCreatedAt:
            change?.fromDeploymentId && change.fromDeploymentId !== state?.deploymentId
              ? null
              : (state?.deploymentCreatedAt ?? null),
          lastSeenAt: now,
          changedAt: now,
        };
    return { next, result };
  });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** What the `vercel.webhook` job carries (see apps/server `VercelWebhookJob`). */
export interface VercelWebhookInput {
  deliveryId: string;
  type: string;
  /** Epoch ms of the event (signed). */
  createdAt: number;
  projectId: string | null;
  /** Event payload with env values stripped. */
  payload: Record<string, unknown>;
}

export type WebhookTransition = "created" | "succeeded" | "failed" | "cancelled" | "promoted";

/**
 * Deployment webhook types, current and legacy names
 * (https://vercel.com/docs/webhooks/webhooks-api#event-types).
 */
const WEBHOOK_TRANSITIONS: Record<string, WebhookTransition> = {
  "deployment.created": "created",
  deployment: "created",
  "deployment.succeeded": "succeeded",
  "deployment.ready": "succeeded",
  "deployment-ready": "succeeded",
  "deployment.error": "failed",
  "deployment-error": "failed",
  "deployment.canceled": "cancelled",
  "deployment.cancelled": "cancelled",
  "deployment-canceled": "cancelled",
  "deployment.promoted": "promoted",
};

export function webhookTransition(type: string): WebhookTransition | null {
  return WEBHOOK_TRANSITIONS[type] ?? null;
}

export interface CaptureWebhookResult {
  status: "ingested" | "duplicate" | "ignored" | "not_selected";
  results: IngestResult[];
  /**
   * Reading the deployment from the API failed; the event was mapped from the
   * webhook payload alone. Callers treat `isAuthError` as revocation.
   */
  enrichmentError?: unknown;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function s(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Maps and ingests one deployment webhook. The deployment is re-read through
 * the project-scoped reader (creator, `source`, `meta`), so webhook and poll
 * events carry the same who/what; if that read fails the payload alone is used.
 */
export async function captureWebhookEvent(input: {
  event: VercelWebhookInput;
  reader: ScopedVercelReader;
  sink: EventSink;
  store: VercelCaptureStore;
  tenantId: string;
  connectionId: string;
  observedAt: Date;
  jobId?: string | null;
}): Promise<CaptureWebhookResult> {
  const { event, reader } = input;
  const transition = webhookTransition(event.type);
  if (!transition) return { status: "ignored", results: [] };
  const payloadDeployment = obj(event.payload.deployment) ?? {};
  const deploymentId = s(payloadDeployment.id);
  const projectId =
    event.projectId ?? s(obj(event.payload.project)?.id) ?? s(payloadDeployment.projectId);
  if (!deploymentId || !projectId) return { status: "ignored", results: [] };
  // Selection may have changed since the delivery was queued.
  if (!isProjectSelected(reader.projectSelection, projectId)) {
    return { status: "not_selected", results: [] };
  }
  const webhookUserId = s(obj(event.payload.user)?.id);

  let enriched: Record<string, unknown> | null = null;
  let enrichmentError: unknown;
  try {
    enriched = (await reader.getDeployment(deploymentId, projectId)) as unknown as Record<
      string,
      unknown
    >;
  } catch (err) {
    if (err instanceof ProjectNotSelectedError) return { status: "not_selected", results: [] };
    enrichmentError = err;
  }

  const info = enriched
    ? normalizeDeployment(enriched as never)
    : normalizeDeployment({
        id: deploymentId,
        projectId,
        name: s(payloadDeployment.name) ?? undefined,
        url: s(payloadDeployment.url),
        target: s(event.payload.target),
        meta: (obj(payloadDeployment.meta) ?? {}) as Record<string, string>,
        ...(webhookUserId ? { creator: { uid: webhookUserId } } : {}),
      } as never);
  const raw = {
    webhook: {
      id: event.deliveryId,
      type: event.type,
      createdAt: event.createdAt,
      payload: event.payload,
    },
    deployment: enriched,
  };
  const provenance: Provenance = {
    method: "webhook",
    observedAt: input.observedAt,
    connectionId: input.connectionId,
    deliveryId: event.deliveryId,
    jobId: input.jobId ?? null,
  };
  const extraData = {
    webhookType: event.type,
    enriched: enriched !== null,
    ...(webhookUserId ? { webhookUserId } : {}),
    ...(enriched ? {} : { actorSource: "webhook payload.user" }),
  };

  const results: IngestResult[] = [];
  if (transition === "promoted") {
    let project: VercelProject | null = null;
    try {
      project = await reader.getProject(projectId);
    } catch (err) {
      if (err instanceof ProjectNotSelectedError) return { status: "not_selected", results: [] };
      enrichmentError ??= err;
    }
    const liveId = project?.targets?.production?.id ?? null;
    const result = await observeProduction({
      store: input.store,
      sink: input.sink,
      tenantId: input.tenantId,
      projectId,
      current: info,
      aliasRequest: project?.lastAliasRequest ?? null,
      provenance,
      webhook: {
        at: event.createdAt,
        actor: webhookUserId ? { type: "user", id: webhookUserId } : null,
      },
      isLive: liveId === null || liveId === info.id,
      raw: { ...raw, project: project ? { lastAliasRequest: project.lastAliasRequest } : null },
    });
    if (result) results.push(result);
  } else {
    results.push(
      await input.sink.ingest(
        input.tenantId,
        lifecycleEvent(info, {
          transition,
          provenance,
          // Created: the deployment's own time. Final states: the webhook's time.
          occurredAt:
            transition === "created" ? (info.createdAt ?? event.createdAt) : event.createdAt,
          raw,
          extraData,
        }),
      ),
    );
  }
  return {
    status: results.some((r) => r.inserted) ? "ingested" : "duplicate",
    results,
    ...(enrichmentError !== undefined ? { enrichmentError } : {}),
  };
}

/** True for errors that mean the deployment no longer exists. */
export function isNotFound(err: unknown): boolean {
  return err instanceof VercelApiError && err.status === 404;
}
