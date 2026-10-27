/**
 * Correlation reads (AFE-20): a compact projection of the events that take
 * part in correlation (any correlation key, or an observation gap), read in
 * `seq` order so a reader can keep a window in memory and fetch only what was
 * stored since. Tenant-scoped (rules R5).
 *
 * Only the `data` fields correlation and mapping read are returned
 * (`aliasAssigned`, `headCommit`, `correlationHints`, `gap`, `projectName`),
 * plus ArgoCD's image override changes for drift detection (`change`
 * fields/imageOverrides/removedImageOverrides, `spec.imageOverrides`).
 */
import type { CanonicalEvent, JsonObject } from "@afe/core";
import type { CorrelationEvent } from "@afe/core/correlation";
import type { Queryable } from "./event-store.ts";

export interface CorrelationEventRecord extends CorrelationEvent {
  seq: number;
  connectionId: string | null;
  /** Whether a raw payload is stored (mapping reads ArgoCD labels from it). */
  hasRawPayload: boolean;
}

export interface ListCorrelationEventsOptions {
  /** Only events with seq > afterSeq. */
  afterSeq: number;
  /** Only events with seq <= throughSeq (pin a snapshot). */
  throughSeq: number;
  /** Only events with occurredAt >= this (the retention cutoff). */
  occurredFrom?: Date | null;
  /** Page size (default 5000). */
  limit?: number;
}

interface Row {
  id: string;
  seq: string;
  source: string;
  action: string;
  actor: CanonicalEvent["actor"];
  target: CanonicalEvent["target"];
  trigger: CanonicalEvent["trigger"];
  outcome: CanonicalEvent["outcome"];
  occurred_at: Date;
  connection_id: string | null;
  correlation: CanonicalEvent["correlation"];
  data: JsonObject;
  has_raw: boolean;
}

/**
 * One page of correlation-relevant events with afterSeq < seq <= throughSeq,
 * in seq order. Call again with `afterSeq` = the last returned seq until
 * fewer than `limit` come back.
 */
export async function listCorrelationEvents(
  db: Queryable,
  tenantId: string,
  options: ListCorrelationEventsOptions,
): Promise<CorrelationEventRecord[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 5000), 1), 50_000);
  const params: unknown[] = [tenantId, options.afterSeq, options.throughSeq, limit];
  let occurred = "";
  if (options.occurredFrom) {
    params.push(options.occurredFrom.toISOString());
    occurred = `AND e.occurred_at >= $${params.length}::timestamptz`;
  }
  const { rows } = await db.query<Row>(
    `SELECT e.id, e.seq, e.source, e.action, e.actor, e.target, e.trigger, e.outcome,
            e.occurred_at, e.connection_id, e.correlation,
            (e.raw_payload_id IS NOT NULL) AS has_raw,
            jsonb_strip_nulls(jsonb_build_object(
              'aliasAssigned', e.data -> 'aliasAssigned',
              'headCommit', e.data -> 'headCommit',
              'correlationHints', e.data -> 'correlationHints',
              'gap', e.data -> 'gap',
              'projectName', e.data -> 'projectName',
              -- ArgoCD Application image overrides (drift detection, AFE-26).
              'change', CASE
                WHEN e.source <> 'argocd' THEN NULL
                WHEN jsonb_typeof(e.data -> 'change') = 'object' THEN jsonb_strip_nulls(
                  jsonb_build_object(
                    'fields', e.data #> '{change,fields}',
                    'imageOverrides', e.data #> '{change,imageOverrides}',
                    'removedImageOverrides', e.data #> '{change,removedImageOverrides}'))
                ELSE e.data -> 'change' END,
              'spec', CASE
                WHEN e.source = 'argocd' AND e.data #> '{spec,imageOverrides}' IS NOT NULL
                THEN jsonb_build_object('imageOverrides', e.data #> '{spec,imageOverrides}')
                END)) AS data
       FROM events e
      WHERE e.tenant_id = $1 AND e.seq > $2 AND e.seq <= $3 ${occurred}
        AND (e.correlation <> '{}'::jsonb OR e.action LIKE 'observation\\_gap.%')
      ORDER BY e.seq
      LIMIT $4`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    seq: Number(r.seq),
    source: r.source,
    action: r.action,
    actor: r.actor,
    target: r.target,
    trigger: r.trigger,
    outcome: r.outcome,
    occurredAt: r.occurred_at.toISOString(),
    connectionId: r.connection_id,
    correlation: r.correlation,
    data: r.data,
    hasRawPayload: r.has_raw,
  }));
}
