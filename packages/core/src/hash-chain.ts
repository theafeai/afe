/**
 * Tamper evidence for the audit log: a per-tenant SHA-256 hash chain.
 *
 *   hash(e) = hex(SHA-256(UTF-8(JCS(e without "hash"))))
 *
 * where JCS is RFC 8785 canonical JSON (canonical-json.ts) and the hashed
 * object includes `tenantId`, `seq` and `prevHash`. `prevHash` of seq 1 is
 * GENESIS_HASH; `prevHash` of seq n is `hash` of seq n-1. Changing any field,
 * deleting an event or reordering events therefore breaks the chain at (or
 * right after) that point. See ADR 0003 and docs/event-model.md.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";
import type { CanonicalEvent } from "./event.ts";

/** `prevHash` of the first event of every tenant chain. */
export const GENESIS_HASH = "0".repeat(64);

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The exact bytes that are hashed for an event (canonical JSON, all fields but `hash`). */
export function eventHashInput(event: Omit<CanonicalEvent, "hash"> | CanonicalEvent): string {
  const { hash: _hash, ...rest } = event as CanonicalEvent;
  return canonicalJson(rest);
}

export function hashEvent(event: Omit<CanonicalEvent, "hash"> | CanonicalEvent): string {
  return sha256Hex(eventHashInput(event));
}

export type ChainBreakKind =
  /** Recomputed hash differs from the stored hash: the event was modified. */
  | "hash_mismatch"
  /** prevHash does not equal the previous event's hash: an event was removed, inserted or reordered. */
  | "prev_hash_mismatch"
  /** seq is not previous seq + 1: an event is missing (deleted) or out of order. */
  | "seq_gap"
  /** Event belongs to a different tenant than the chain being verified. */
  | "tenant_mismatch"
  /** The stored chain head does not match the last event (tail removed or head edited). */
  | "head_mismatch"
  /** A raw payload's bytes no longer match the sha256 recorded in its event. */
  | "raw_payload_mismatch"
  /** The event could not be hashed/parsed at all. */
  | "malformed";

export interface ChainBreak {
  kind: ChainBreakKind;
  /** 0-based position in the verified sequence where the break was detected. */
  index: number;
  /** seq of the offending event (or the head's seq for head_mismatch). */
  seq: number | null;
  eventId: string | null;
  expected: string | number | null;
  actual: string | number | null;
  message: string;
}

export type ChainVerification =
  | {
      ok: true;
      /** Number of events verified. */
      count: number;
      /** seq/hash of the last verified event (the anchor to continue from). */
      lastSeq: number;
      lastHash: string;
    }
  | {
      ok: false;
      count: number;
      lastSeq: number;
      lastHash: string;
      /** The first break found. Events before `break.index` verified correctly. */
      break: ChainBreak;
    };

export interface ChainVerifierOptions {
  tenantId?: string;
  /**
   * Anchor to verify a slice of the chain that does not start at seq 1:
   * the seq and hash of the event just before the slice. Default: genesis.
   */
  after?: { seq: number; hash: string };
}

/**
 * Incremental verifier for streaming large chains (DB pages, export files).
 * Feed events in seq order with `push`; it stops at the first break.
 */
export class ChainVerifier {
  private count = 0;
  private lastSeq: number;
  private lastHash: string;
  private failure: ChainBreak | null = null;
  private readonly tenantId: string | undefined;

  constructor(options: ChainVerifierOptions = {}) {
    this.tenantId = options.tenantId;
    this.lastSeq = options.after?.seq ?? 0;
    this.lastHash = options.after?.hash ?? GENESIS_HASH;
  }

  get broken(): ChainBreak | null {
    return this.failure;
  }

  /** Verifies the next event. Returns the break if this event breaks the chain. */
  push(event: CanonicalEvent): ChainBreak | null {
    if (this.failure) return this.failure;
    const index = this.count;
    const at = (
      kind: ChainBreakKind,
      expected: string | number | null,
      actual: string | number | null,
      message: string,
    ): ChainBreak => {
      this.failure = {
        kind,
        index,
        seq: typeof event?.seq === "number" ? event.seq : null,
        eventId: typeof event?.id === "string" ? event.id : null,
        expected,
        actual,
        message,
      };
      return this.failure;
    };

    if (this.tenantId !== undefined && event.tenantId !== this.tenantId) {
      return at("tenant_mismatch", this.tenantId, event.tenantId, "event from another tenant");
    }
    if (event.seq !== this.lastSeq + 1) {
      return at(
        "seq_gap",
        this.lastSeq + 1,
        event.seq,
        event.seq > this.lastSeq + 1
          ? `events ${this.lastSeq + 1}..${event.seq - 1} are missing`
          : `seq ${event.seq} is out of order`,
      );
    }
    if (event.prevHash !== this.lastHash) {
      return at("prev_hash_mismatch", this.lastHash, event.prevHash, "prevHash does not link");
    }
    let recomputed: string;
    try {
      recomputed = hashEvent(event);
    } catch (err) {
      return at("malformed", null, null, `cannot hash event: ${(err as Error).message}`);
    }
    if (recomputed !== event.hash) {
      return at("hash_mismatch", recomputed, event.hash, "event content does not match its hash");
    }
    this.count += 1;
    this.lastSeq = event.seq;
    this.lastHash = event.hash;
    return null;
  }

  /** Records an externally detected break (e.g. head or raw payload checks). */
  fail(b: Omit<ChainBreak, "index"> & { index?: number }): ChainBreak {
    if (!this.failure) this.failure = { ...b, index: b.index ?? this.count };
    return this.failure;
  }

  result(): ChainVerification {
    const base = { count: this.count, lastSeq: this.lastSeq, lastHash: this.lastHash };
    return this.failure ? { ok: false, ...base, break: this.failure } : { ok: true, ...base };
  }
}

/**
 * Verifies a sequence of events (in the order given, which must be seq order)
 * forms an intact chain. Detects modification (hash_mismatch), deletion
 * (seq_gap / prev_hash_mismatch) and reordering (seq_gap / prev_hash_mismatch),
 * and reports the first position where the chain breaks.
 *
 * Note: removing events from the *end* of a chain cannot be detected from the
 * events alone; compare `lastSeq`/`lastHash` with a trusted head (the DB chain
 * head, or a head published/exported earlier).
 */
export function verifyChain(
  events: Iterable<CanonicalEvent>,
  options: ChainVerifierOptions & { expectedHead?: { seq: number; hash: string } } = {},
): ChainVerification {
  const v = new ChainVerifier(options);
  for (const e of events) {
    if (v.push(e)) break;
  }
  const r = v.result();
  const head = options.expectedHead;
  if (r.ok && head && (head.seq !== r.lastSeq || head.hash !== r.lastHash)) {
    v.fail({
      kind: "head_mismatch",
      seq: head.seq,
      eventId: null,
      expected: `${head.seq}:${head.hash}`,
      actual: `${r.lastSeq}:${r.lastHash}`,
      message: "last event does not match the expected chain head",
    });
    return v.result();
  }
  return r;
}
