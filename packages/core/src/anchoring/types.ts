/**
 * Chain anchoring (AFE-29, ADR 0007): signed checkpoints of a tenant's hash
 * chain head, published to places the database administrator cannot rewrite.
 *
 * The hash chain (ADR 0003) detects edits relative to a trusted head, but a
 * database superuser can disable the triggers and rewrite a whole chain
 * consistently. A checkpoint that left the database earlier ("at seq n the
 * hash was h") exposes that: the rewritten chain no longer has `h` at `n`.
 */

/** Version of the checkpoint and receipt format. */
export const CHECKPOINT_VERSION = 1 as const;

/** Domain separator: a checkpoint signature can never be mistaken for an export manifest signature. */
export const CHECKPOINT_TYPE = "afe.chain-checkpoint" as const;

/**
 * A statement "tenant T's chain had hash H at seq N", made at `createdAt`.
 * Signed as UTF-8(JCS(checkpoint)).
 */
export interface ChainCheckpoint {
  type: typeof CHECKPOINT_TYPE;
  version: typeof CHECKPOINT_VERSION;
  tenantId: string;
  /** Chain position (>= 1). */
  seq: number;
  /** Hash of the event at `seq` (64 lowercase hex). */
  hash: string;
  /** When Afe made the checkpoint (ISO 8601 UTC, milliseconds). */
  createdAt: string;
}

export interface CheckpointSignature {
  algorithm: "ed25519";
  /** First 16 hex characters of SHA-256 of the raw public key (same as export keys). */
  keyId: string;
  /** Raw 32-byte Ed25519 public key, base64url. Trust it only if it matches a key you hold. */
  publicKey: string;
  /** Signature over UTF-8(JCS(checkpoint)), base64url. */
  value: string;
}

/** An RFC 3161 timestamp over SHA-256(UTF-8(JCS(checkpoint))). */
export interface CheckpointTimestamp {
  kind: "rfc3161";
  /** The TSA the token came from (informational). */
  tsaUrl?: string;
  /** The DER TimeStampToken (CMS ContentInfo), base64. Verify with `openssl ts -verify`. */
  token: string;
  /** genTime from the token's TSTInfo (ISO 8601), informational. */
  genTime?: string;
}

/**
 * A signed checkpoint as published to anchors. `checkpoint` and `signature`
 * are the evidence; `timestamp` is self-authenticating (TSA signature).
 */
export interface SignedCheckpoint {
  checkpoint: ChainCheckpoint;
  signature: CheckpointSignature;
  timestamp?: CheckpointTimestamp;
}

/**
 * Proof that a signed checkpoint was published to one anchor. Everything
 * outside `checkpoint`/`signature`/`timestamp` is unsigned metadata.
 */
export interface AnchorReceipt extends SignedCheckpoint {
  afeAnchor: typeof CHECKPOINT_VERSION;
  anchor: {
    /** Anchor kind, e.g. "file", "webhook", "rfc3161", or a hosted kind such as "kms". */
    kind: string;
    /** Where it was published (file path, URL); informational. */
    location?: string;
    /** When the anchor accepted it (ISO 8601 UTC). */
    publishedAt: string;
  };
}

/**
 * Chain anchoring extension point (ADR 0002 / ADR 0007). OSS implementations:
 * append-only file (`createFileChainAnchor`), HTTP webhook
 * (`createWebhookChainAnchor`) and RFC 3161 TSA (`createTsaChainAnchor`). The
 * hosted service can supply e.g. KMS-signed checkpoints in object storage.
 */
export interface ChainAnchor {
  /** Kind recorded in receipts ("file", "webhook", "rfc3161", ...). */
  readonly kind: string;
  /**
   * Publishes a signed checkpoint and returns the receipt. May add a
   * `timestamp` (TSA anchors); later anchors in the same run publish it too.
   */
  publish(checkpoint: SignedCheckpoint): Promise<AnchorReceipt>;
  /**
   * Receipts this anchor holds for a tenant, oldest first. Only anchors that
   * can be read back (file, object storage) implement it; these are the
   * external sources the verifier trusts more than the database copy.
   */
  list?(tenantId: string): Promise<AnchorReceipt[]>;
  /** The newest receipt for a tenant (defaults to the last of `list`). */
  latest?(tenantId: string): Promise<AnchorReceipt | null>;
  /** Anchor-specific verification of a receipt it issued (e.g. re-fetch from storage). */
  verify?(receipt: AnchorReceipt): Promise<AnchorReceiptIssue[]>;
}

/** Signs checkpoints. Same shape as `ExportSigner` (an Ed25519 export key works; KMS in hosted). */
export interface CheckpointSigner {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly publicKey: string;
  sign(data: Uint8Array): string | Promise<string>;
}

export type AnchorIssueCode =
  | "receipt_malformed"
  | "signature_invalid"
  | "signature_untrusted"
  | "timestamp_malformed"
  | "timestamp_not_granted"
  | "timestamp_imprint_mismatch"
  | "tenant_mismatch"
  /** The chain has a different hash at the anchored seq: history was rewritten. */
  | "anchor_mismatch"
  /** The chain (or export head) is shorter than an anchor made before it: events were removed. */
  | "anchor_beyond_head"
  | "anchor_source_error";

export interface AnchorReceiptIssue {
  code: AnchorIssueCode;
  message: string;
  seq?: number;
}
