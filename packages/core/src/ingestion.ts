/**
 * Ingestion contract between connectors (and Afe's own producers, such as
 * connection health) and the audit log. Connectors never write to the
 * database directly; they map source data to `CanonicalEventInputLike` and
 * call `EventSink.ingest`. The PostgreSQL implementation is `createPgEventSink`
 * in `@afe/db`. Contract details: docs/event-model.md "Ingestion contract".
 */
import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  parseEventInput,
  type CanonicalEvent,
  type CanonicalEventInput,
  type CanonicalEventInputLike,
  type RawPayloadRef,
} from "./event.ts";
import { GENESIS_HASH, hashEvent, sha256Hex } from "./hash-chain.ts";

export interface IngestResult {
  /**
   * true if the event was appended; false if an event with the same
   * (tenantId, source, sourceEventId) already existed. Duplicates are not
   * errors: the first stored version is kept unchanged and returned.
   */
  inserted: boolean;
  /** The stored event (the existing one when `inserted` is false). */
  event: CanonicalEvent;
}

export interface EventSink {
  /**
   * Validates, normalises and appends one event to the tenant's audit log.
   *
   * - Idempotent on (tenantId, source, sourceEventId): safe to call again
   *   after a crash/retry, and safe for webhook and polling to both deliver.
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
  /** seq of the new event (previous head seq + 1). */
  seq: number;
  /** hash of the previous event (GENESIS_HASH for seq 1). */
  prevHash: string;
  input: CanonicalEventInput;
  rawPayload: RawPayloadRef | null;
  id?: string;
  recordedAt?: Date;
}

/**
 * Builds the stored form of a validated input at a given chain position and
 * computes its hash. Used by every EventSink implementation so that all of
 * them hash identically.
 */
export function buildChainedEvent(p: BuildEventParams): CanonicalEvent {
  const { rawPayload: _raw, ...input } = p.input;
  const event: Omit<CanonicalEvent, "hash"> = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: p.id ?? randomUUID(),
    tenantId: p.tenantId,
    seq: p.seq,
    ...input,
    recordedAt: (p.recordedAt ?? new Date()).toISOString(),
    rawPayload: p.rawPayload,
    prevHash: p.prevHash,
  };
  return { ...event, hash: hashEvent(event) };
}

/** An EventSink that keeps events in memory, with a real hash chain; for tests. */
export interface MemoryEventSink extends EventSink {
  /** Events per tenant, in seq order. */
  events(tenantId: string): CanonicalEvent[];
  /** Raw payload bytes by id. */
  readonly rawPayloads: Map<string, { contentType: string; body: Uint8Array }>;
}

export function createMemoryEventSink(): MemoryEventSink {
  const chains = new Map<string, CanonicalEvent[]>();
  const byKey = new Map<string, CanonicalEvent>();
  const rawPayloads = new Map<string, { contentType: string; body: Uint8Array }>();
  return {
    rawPayloads,
    events: (tenantId) => [...(chains.get(tenantId) ?? [])],
    async ingest(tenantId, raw) {
      const input = parseEventInput(raw);
      const key = JSON.stringify([tenantId, input.source, input.sourceEventId]);
      const existing = byKey.get(key);
      if (existing) return { inserted: false, event: existing };
      const chain = chains.get(tenantId) ?? [];
      const last = chain.at(-1);
      let ref: RawPayloadRef | null = null;
      if (input.rawPayload) {
        const body = rawPayloadBytes(input.rawPayload.body);
        ref = { id: randomUUID(), sha256: sha256Hex(body) };
        rawPayloads.set(ref.id, { contentType: input.rawPayload.contentType, body });
      }
      const event = buildChainedEvent({
        tenantId,
        seq: (last?.seq ?? 0) + 1,
        prevHash: last?.hash ?? GENESIS_HASH,
        input,
        rawPayload: ref,
      });
      chain.push(event);
      chains.set(tenantId, chain);
      byKey.set(key, event);
      return { inserted: true, event };
    },
  };
}
