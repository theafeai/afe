/**
 * Building, signing and parsing chain checkpoints (docs/export-verification.md
 * "Chain anchors"). Signed bytes: UTF-8(JCS(checkpoint)), Ed25519.
 */
import { canonicalJson } from "../canonical-json.ts";
import { sha256Hex } from "../hash-chain.ts";
import {
  createEd25519ExportSigner,
  normaliseExportPublicKey,
  verifyEd25519,
} from "../export/signer.ts";
import {
  CHECKPOINT_TYPE,
  CHECKPOINT_VERSION,
  type AnchorReceipt,
  type AnchorReceiptIssue,
  type ChainCheckpoint,
  type CheckpointSigner,
  type SignedCheckpoint,
} from "./types.ts";

const HEX64 = /^[0-9a-f]{64}$/;

export function createCheckpoint(input: {
  tenantId: string;
  seq: number;
  hash: string;
  createdAt?: Date;
}): ChainCheckpoint {
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) {
    throw new Error("checkpoint seq must be a positive integer");
  }
  if (!HEX64.test(input.hash)) throw new Error("checkpoint hash must be 64 lowercase hex");
  return {
    type: CHECKPOINT_TYPE,
    version: CHECKPOINT_VERSION,
    tenantId: input.tenantId,
    seq: input.seq,
    hash: input.hash,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

/** The exact bytes a checkpoint signature (and an RFC 3161 imprint) covers. */
export function checkpointSigningInput(checkpoint: ChainCheckpoint): Uint8Array {
  return new TextEncoder().encode(canonicalJson(checkpoint));
}

/** SHA-256 of the signing input, hex: the RFC 3161 message imprint. */
export function checkpointDigest(checkpoint: ChainCheckpoint): string {
  return sha256Hex(checkpointSigningInput(checkpoint));
}

export async function signCheckpoint(
  checkpoint: ChainCheckpoint,
  signer: CheckpointSigner,
): Promise<SignedCheckpoint> {
  const value = await signer.sign(checkpointSigningInput(checkpoint));
  return {
    checkpoint,
    signature: {
      algorithm: signer.algorithm,
      keyId: signer.keyId,
      publicKey: signer.publicKey,
      value,
    },
  };
}

/** Ed25519 checkpoint signer from key material (same forms as AFE_EXPORT_SIGNING_KEY). */
export function createEd25519CheckpointSigner(material: string): CheckpointSigner {
  return createEd25519ExportSigner(material);
}

/** Checks only the shape of a checkpoint; returns a problem or null. */
export function checkCheckpointShape(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "checkpoint is not an object";
  const c = value as Record<string, unknown>;
  if (c.type !== CHECKPOINT_TYPE) return "checkpoint.type is not afe.chain-checkpoint";
  if (c.version !== CHECKPOINT_VERSION)
    return `unsupported checkpoint version ${String(c.version)}`;
  if (typeof c.tenantId !== "string" || !c.tenantId) return "checkpoint.tenantId missing";
  if (typeof c.seq !== "number" || !Number.isSafeInteger(c.seq) || c.seq < 1)
    return "checkpoint.seq invalid";
  if (typeof c.hash !== "string" || !HEX64.test(c.hash)) return "checkpoint.hash invalid";
  if (typeof c.createdAt !== "string" || Number.isNaN(Date.parse(c.createdAt)))
    return "checkpoint.createdAt invalid";
  return null;
}

/** Checks the shape of a receipt (or bare signed checkpoint); returns a problem or null. */
export function checkReceiptShape(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "receipt is not an object";
  const r = value as Record<string, unknown>;
  const cp = checkCheckpointShape(r.checkpoint);
  if (cp) return cp;
  const s = r.signature as Record<string, unknown> | undefined;
  if (
    !s ||
    typeof s !== "object" ||
    s.algorithm !== "ed25519" ||
    typeof s.publicKey !== "string" ||
    typeof s.value !== "string" ||
    typeof s.keyId !== "string"
  ) {
    return "receipt.signature invalid";
  }
  if (r.timestamp !== undefined) {
    const t = r.timestamp as Record<string, unknown>;
    if (!t || t.kind !== "rfc3161" || typeof t.token !== "string")
      return "receipt.timestamp invalid";
  }
  return null;
}

export type CheckpointSignatureStatus =
  "valid_trusted" | "valid_unpinned" | "invalid" | "untrusted";

/**
 * Verifies a checkpoint signature. With `trustedPublicKeys`, the signing key
 * must be one of them ("untrusted" otherwise). Never throws.
 */
export function verifyCheckpointSignature(
  signed: SignedCheckpoint,
  trustedPublicKeys: readonly string[] = [],
): CheckpointSignatureStatus {
  const s = signed.signature;
  const valid =
    s?.algorithm === "ed25519" &&
    verifyEd25519(s.publicKey, checkpointSigningInput(signed.checkpoint), s.value);
  if (!valid) return "invalid";
  if (trustedPublicKeys.length === 0) return "valid_unpinned";
  const trusted = trustedPublicKeys.map(normaliseExportPublicKey);
  return trusted.includes(s.publicKey) ? "valid_trusted" : "untrusted";
}

export class AnchorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorParseError";
  }
}

/**
 * Parses receipts supplied by an auditor or read from an anchor file: JSON
 * Lines (one receipt per line, the file anchor's format), a JSON array, or a
 * single JSON object. A bare signed checkpoint (no `anchor` member) is
 * accepted as a receipt of kind "supplied". Malformed entries are reported in
 * `issues` and skipped.
 */
export function parseAnchorReceipts(text: string): {
  receipts: AnchorReceipt[];
  issues: AnchorReceiptIssue[];
} {
  const issues: AnchorReceiptIssue[] = [];
  let values: unknown[] = [];
  const trimmed = text.trim();
  if (trimmed === "") return { receipts: [], issues };
  let whole: unknown;
  let parsedWhole = false;
  try {
    whole = JSON.parse(trimmed);
    parsedWhole = true;
  } catch {
    // not a single JSON document: JSON Lines
  }
  if (parsedWhole) {
    values = Array.isArray(whole) ? whole : [whole];
  } else {
    if (trimmed.startsWith("[")) throw new AnchorParseError("anchors file is not valid JSON");
    trimmed.split("\n").forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        values.push(JSON.parse(line));
      } catch {
        issues.push({ code: "receipt_malformed", message: `line ${i + 1} is not valid JSON` });
      }
    });
  }
  const receipts: AnchorReceipt[] = [];
  values.forEach((v, i) => {
    const problem = checkReceiptShape(v);
    if (problem) {
      issues.push({ code: "receipt_malformed", message: `entry ${i + 1}: ${problem}` });
      return;
    }
    receipts.push(normaliseReceipt(v as AnchorReceipt));
  });
  return { receipts, issues };
}

function normaliseReceipt(r: AnchorReceipt): AnchorReceipt {
  return {
    afeAnchor: CHECKPOINT_VERSION,
    checkpoint: r.checkpoint,
    signature: r.signature,
    ...(r.timestamp ? { timestamp: r.timestamp } : {}),
    anchor:
      r.anchor && typeof r.anchor === "object" && typeof r.anchor.kind === "string"
        ? r.anchor
        : { kind: "supplied", publishedAt: r.checkpoint.createdAt },
  };
}

/** Builds a receipt for `signed` from anchor `kind`. */
export function makeReceipt(
  signed: SignedCheckpoint,
  kind: string,
  location?: string,
  publishedAt: Date = new Date(),
): AnchorReceipt {
  return {
    afeAnchor: CHECKPOINT_VERSION,
    checkpoint: signed.checkpoint,
    signature: signed.signature,
    ...(signed.timestamp ? { timestamp: signed.timestamp } : {}),
    anchor: {
      kind,
      ...(location ? { location } : {}),
      publishedAt: publishedAt.toISOString(),
    },
  };
}
