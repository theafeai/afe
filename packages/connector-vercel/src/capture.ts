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
  type ProductionChangeRecord,
  type ProductionOccurrence,
  type ProductionState,
  type Provenance,
  OCCURRENCE_TOLERANCE_MS,
  PRODUCTION_HISTORY_LIMIT,
  classifyProductionChange,
  findProductionChange,
  legacyProductionChange,
  lifecycleEvent,
  normalizeDeployment,
  productionChangeEvent,
  productionChangeSourceEventId,
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
 * Every change is given a key `production_alias:<project>:<from>:<to>:<occurrence ms>`
 * (AFE-30) and remembered in `ProductionState.changes`. Webhook and poll
 * processing of a project are serialised by `withProductionState`, so the
 * second path to see a change finds it there (`findProductionChange`) and
 * reuses its key:
 *
 * - poll after webhook: production is already the stored deployment, nothing to do
 *   (unless `lastAliasRequest` reports a different, later change to it);
 * - webhook after poll: the webhook's time falls inside the window in which
 *   the poll saw the change happen, or matches its `requestedAt`;
 * - a webhook or `lastAliasRequest` for a change to the stored deployment that
 *   happened after Afe recorded it (production went away and came back while
 *   unobserved) is a new occurrence;
 * - a late webhook for a deployment that is no longer production is recorded
 *   unless the history already holds that change, and leaves the state alone.
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
  /** Loads the full deployment; called only when a change is about to be recorded. */
  enrich?: (raw: unknown) => Promise<{ current: DeploymentInfo; raw: unknown } | null>;
}): Promise<IngestResult | null> {
  const now = input.provenance.observedAt.getTime();
  const { projectId } = input;
  return input.store.withProductionState(projectId, async (state) => {
    let { current, raw } = input;
    const webhookAt = input.webhook?.at ?? null;
    const aliasRequest = aliasRequestFor(input.aliasRequest ?? null, current.id, webhookAt);
    const touched = (s: ProductionState): ProductionState => ({
      ...s,
      lastSeenAt: Math.max(s.lastSeenAt, now),
    });
    const alreadyCurrent = state !== null && state.deploymentId === current.id;
    // A poll of unchanged production, with nothing that could reveal a repeat.
    if (state && alreadyCurrent && webhookAt === null && !aliasRequest) {
      return { next: touched(state), result: null };
    }

    const occurrence: ProductionOccurrence = aliasRequest
      ? { source: "lastAliasRequest", at: aliasRequest.requestedAt, notBefore: null }
      : webhookAt !== null
        ? { source: "webhook", at: webhookAt, notBefore: null }
        : { source: "observed", at: now, notBefore: state?.lastSeenAt ?? null };
    const history = state
      ? state.changes.length > 0
        ? state.changes
        : [legacyProductionChange(projectId, state)]
      : [];
    const fromHint =
      aliasRequest?.fromDeploymentId ?? (alreadyCurrent ? null : (state?.deploymentId ?? null));
    const known = findProductionChange(history, current.id, occurrence, fromHint);

    const enrich = async () => {
      if (!input.enrich) return;
      const full = await input.enrich(raw);
      if (full) ({ current, raw } = full);
    };
    const ingest = async (
      previous: Pick<ProductionState, "deploymentId" | "deploymentCreatedAt" | "lastSeenAt"> | null,
      record: ProductionChangeRecord | null,
    ) => {
      const change = classifyProductionChange({ previous, current, aliasRequest, webhookAt });
      const from = record
        ? record.from
        : (change?.fromDeploymentId ?? previous?.deploymentId ?? null);
      const key =
        record?.key ?? productionChangeSourceEventId(projectId, from, current.id, occurrence.at);
      const result = change
        ? await input.sink.ingest(
            input.tenantId,
            productionChangeEvent({
              projectId,
              deployment: current,
              change,
              provenance: input.provenance,
              actor: input.webhook?.actor ?? null,
              occurrence: record ?? occurrence,
              sourceEventId: key,
              raw,
            }),
          )
        : null;
      const entry: ProductionChangeRecord = record ?? { key, from, to: current.id, ...occurrence };
      return { change, result, entry };
    };

    if (state && alreadyCurrent) {
      if (known) {
        // `lastAliasRequest` describes the change Afe already recorded.
        if (webhookAt === null) return { next: touched(state), result: null };
        // A webhook for the change that made the stored deployment production.
        const previous = known.from
          ? {
              deploymentId: known.from,
              deploymentCreatedAt:
                known.from === state.previousDeploymentId
                  ? state.previousDeploymentCreatedAt
                  : null,
              lastSeenAt: state.changedAt,
            }
          : null;
        const { result } = await ingest(previous, known);
        return { next: touched(state), result };
      }
      // Production left the stored deployment and came back while unobserved.
      await enrich();
      const from =
        aliasRequest?.fromDeploymentId ?? previousBefore(history, occurrence.at, current.id);
      const { result, entry } = await ingest(
        from ? { deploymentId: from, deploymentCreatedAt: null, lastSeenAt: occurrence.at } : null,
        null,
      );
      const next: ProductionState = {
        ...state,
        previousDeploymentId: entry.from,
        previousDeploymentCreatedAt: null,
        lastSeenAt: Math.max(state.lastSeenAt, now),
        changedAt: now,
        changes: pushChange(history, entry),
      };
      return { next, result };
    }

    await enrich();
    const { result, entry } = await ingest(state, known);
    const changes = known ? [...history] : pushChange(history, entry);
    if (input.isLive === false) {
      return state ? { next: { ...state, changes }, result } : { result };
    }
    const next: ProductionState = {
      deploymentId: current.id,
      deploymentCreatedAt: current.createdAt,
      previousDeploymentId: entry.from ?? state?.deploymentId ?? null,
      previousDeploymentCreatedAt:
        entry.from && entry.from !== state?.deploymentId
          ? null
          : (state?.deploymentCreatedAt ?? null),
      lastSeenAt: now,
      changedAt: now,
      changes,
    };
    return { next, result };
  });
}

/**
 * `lastAliasRequest` when it names `deploymentId` as a promote/rollback with a
 * `requestedAt`. For a webhook, a request made well after the webhook's own
 * time is a later change (the webhook arrived late) and is not used.
 */
function aliasRequestFor(
  ar: VercelAliasRequest | null,
  deploymentId: string,
  webhookAt: number | null,
): (VercelAliasRequest & { requestedAt: number }) | null {
  if (!ar || ar.toDeploymentId !== deploymentId) return null;
  const type = (ar.type ?? "").toLowerCase();
  if (type !== "promote" && type !== "rollback") return null;
  const at = ar.requestedAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (webhookAt !== null && at > webhookAt + OCCURRENCE_TOLERANCE_MS) return null;
  return { ...ar, requestedAt: at };
}

/** The deployment that the latest recorded change before `at` made production, unless it is `to`. */
function previousBefore(
  history: readonly ProductionChangeRecord[],
  at: number,
  to: string,
): string | null {
  let best: ProductionChangeRecord | null = null;
  for (const c of history) if (c.at < at && (!best || c.at >= best.at)) best = c;
  return best && best.to !== to ? best.to : null;
}

function pushChange(
  history: readonly ProductionChangeRecord[],
  entry: ProductionChangeRecord,
): ProductionChangeRecord[] {
  return [...history, entry].slice(-PRODUCTION_HISTORY_LIMIT);
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
