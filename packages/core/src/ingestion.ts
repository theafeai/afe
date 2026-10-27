/**
 * Ingestion contract between connectors (and Afe's own producers, such as
 * connection health) and the event store. Connectors never write to the
 * database directly; they map source data to `CanonicalEventInputLike` and
 * call `EventSink.ingest`. The PostgreSQL implementation is `createPgEventSink`
 * in `@afe/db`. Contract details: docs/event-model.md "Ingestion contract".
 *
 * `EventSink` is also the seam another build can wrap or replace (for example
 * to copy events into a long-term store): pass it as `createAfe({ sink })`.
 */
import { randomUUID } from "node:crypto";
import { sha256Hex } from "./digest.ts";
import {
  EVENT_SCHEMA_VERSION,
  parseEventInput,
  type CanonicalEvent,
  type CanonicalEventInput,
  type CanonicalEventInputLike,
  type RawPayloadRef,
} from "./event.ts";
import { isOutsideRetention, type RetentionPolicy } from "./retention.ts";

export type IngestResult =
  /** The event was stored. */
  | { status: "inserted"; inserted: true; event: CanonicalEvent }
  /**
   * An event with the same (tenantId, source, sourceEventId) already existed.
   * Not an error: the first stored version is kept unchanged and returned.
   */
  | { status: "duplicate"; inserted: false; event: CanonicalEvent }
  /**
   * The event's occurredAt is already outside the tenant's retention window,
   * so it was not stored (and a re-delivery cannot resurrect a purged event).
   */
  | { status: "expired"; inserted: false; event: null };

export interface EventSink {
  /**
   * Validates, normalises and stores one event.
   *
   * - Idempotent on (tenantId, source, sourceEventId): safe to call again
   *   after a crash/retry, and safe for webhook and polling to both deliver.
   * - Drops events that are outside the retention window (`status: "expired"`).
   * - Throws `EventValidationError` (from `@afe/core`) for invalid input:
   *   that is a connector bug and must not be retried.
   * - Other errors (database unavailable...) are transient: retry the job.
   * - Resolves only once the event is durably committed.
   */
  ingest(tenantId: string, input: CanonicalEventInputLike): Promise<IngestResult>;
}

/** Bytes of a raw payload body as stored (strings are UTF-8 encoded). */
export function rawPayloadBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

export interface BuildEventParams {
  tenantId: string;
  /** Per-tenant ordering key assigned by the store. */
  seq: number;
  input: CanonicalEventInput;
  rawPayload: RawPayloadRef | null;
  id?: string;
  recordedAt?: Date;
}

/** Builds the stored form of a validated input. Used by every EventSink implementation. */
export function buildStoredEvent(p: BuildEventParams): CanonicalEvent {
  const { rawPayload: _raw, ...input } = p.input;
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: p.id ?? randomUUID(),
    tenantId: p.tenantId,
    seq: p.seq,
    ...input,
    recordedAt: (p.recordedAt ?? new Date()).toISOString(),
    rawPayload: p.rawPayload,
  };
}

/** An EventSink that keeps events in memory; for tests. */
export interface MemoryEventSink extends EventSink {
  /** Events per tenant, in seq order. */
  events(tenantId: string): CanonicalEvent[];
  /** Raw payload bytes by id. */
  readonly rawPayloads: Map<string, { contentType: string; body: Uint8Array }>;
}

export interface MemoryEventSinkOptions {
  /** Drop events outside this policy's window (default: keep everything). */
  retention?: RetentionPolicy;
  now?: () => Date;
}

export function createMemoryEventSink(options: MemoryEventSinkOptions = {}): MemoryEventSink {
  const byTenant = new Map<string, CanonicalEvent[]>();
  const byKey = new Map<string, CanonicalEvent>();
  const rawPayloads = new Map<string, { contentType: string; body: Uint8Array }>();
  const now = options.now ?? (() => new Date());
  return {
    rawPayloads,
    events: (tenantId) => [...(byTenant.get(tenantId) ?? [])],
    async ingest(tenantId, raw) {
      const input = parseEventInput(raw);
      const key = JSON.stringify([tenantId, input.source, input.sourceEventId]);
      const existing = byKey.get(key);
      if (existing) return { status: "duplicate", inserted: false, event: existing };
      const cutoff = options.retention ? await options.retention.cutoff(tenantId, now()) : null;
      if (isOutsideRetention(input.occurredAt, cutoff)) {
        return { status: "expired", inserted: false, event: null };
      }
      const list = byTenant.get(tenantId) ?? [];
      let ref: RawPayloadRef | null = null;
      if (input.rawPayload) {
        const body = rawPayloadBytes(input.rawPayload.body);
        ref = { id: randomUUID(), sha256: sha256Hex(body) };
        rawPayloads.set(ref.id, { contentType: input.rawPayload.contentType, body });
      }
      const event = buildStoredEvent({
        tenantId,
        seq: (list.at(-1)?.seq ?? 0) + 1,
        input,
        rawPayload: ref,
      });
      list.push(event);
      byTenant.set(tenantId, list);
      byKey.set(key, event);
      return { status: "inserted", inserted: true, event };
    },
  };
}
