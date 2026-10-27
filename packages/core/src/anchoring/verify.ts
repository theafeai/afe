/**
 * Verifying anchor receipts and checking a chain (live or exported) against
 * them. Pure: the caller supplies the hashes at the anchored positions.
 * Algorithm: docs/export-verification.md "Chain anchors".
 */
import {
  checkpointDigest,
  checkReceiptShape,
  verifyCheckpointSignature,
  type CheckpointSignatureStatus,
} from "./checkpoint.ts";
import { checkTimeStampToken } from "./rfc3161.ts";
import type { AnchorReceipt, AnchorReceiptIssue } from "./types.ts";

export type TimestampStatus = "absent" | "imprint_ok" | "imprint_mismatch" | "malformed";

export interface ReceiptCheck {
  signature: CheckpointSignatureStatus;
  timestamp: TimestampStatus;
  /** genTime from the TSA token, when present and parsed. */
  timestampGenTime?: string;
  issues: AnchorReceiptIssue[];
}

/**
 * Checks one receipt on its own: shape, Ed25519 signature (against trusted
 * keys if given) and, if it carries an RFC 3161 token, that the token's
 * message imprint is SHA-256 of the checkpoint. Does not trust the receipt's
 * unsigned metadata.
 */
export function checkAnchorReceipt(
  receipt: AnchorReceipt,
  options: { trustedPublicKeys?: readonly string[] } = {},
): ReceiptCheck {
  const shape = checkReceiptShape(receipt);
  if (shape) {
    return {
      signature: "invalid",
      timestamp: "absent",
      issues: [{ code: "receipt_malformed", message: shape }],
    };
  }
  const issues: AnchorReceiptIssue[] = [];
  const seq = receipt.checkpoint.seq;
  const signature = verifyCheckpointSignature(receipt, options.trustedPublicKeys ?? []);
  if (signature === "invalid") {
    issues.push({
      code: "signature_invalid",
      seq,
      message: `checkpoint at seq ${seq}: signature does not verify (checkpoint altered or forged)`,
    });
  } else if (signature === "untrusted") {
    issues.push({
      code: "signature_untrusted",
      seq,
      message: `checkpoint at seq ${seq} is signed by key ${receipt.signature.keyId}, which is not trusted`,
    });
  }
  let timestamp: TimestampStatus = "absent";
  let genTime: string | undefined;
  if (receipt.timestamp) {
    const check = checkTimeStampToken(
      Buffer.from(receipt.timestamp.token, "base64"),
      checkpointDigest(receipt.checkpoint),
    );
    if (check.ok) {
      timestamp = "imprint_ok";
      genTime = check.tstInfo.genTime;
    } else {
      timestamp = check.code === "timestamp_imprint_mismatch" ? "imprint_mismatch" : "malformed";
      issues.push({ code: check.code, seq, message: `checkpoint at seq ${seq}: ${check.message}` });
    }
  }
  return { signature, timestamp, ...(genTime ? { timestampGenTime: genTime } : {}), issues };
}

/** What is known about the chain being checked (the live chain, or an export). */
export interface ChainView {
  tenantId: string;
  /** The head of the chain as seen by this view (live head, or the export's chainHead). */
  head: { seq: number; hash: string };
  /** Hashes at (some of) the anchored seqs; see `anchoredSeqs`. */
  hashes: ReadonlyMap<number, string>;
  /** True if `hashes` covers every seq 1..head (live chain, complete export). */
  complete: boolean;
  /** When the view was taken (export createdAt); anchors made before it must be <= head. */
  takenAt?: string;
}

export type AnchorCheckStatus =
  /** The chain has the anchored hash at the anchored seq. */
  | "match"
  /** The chain has a different hash there: history was rewritten. */
  | "mismatch"
  /** The anchor was made before the view but is beyond its head: events were removed. */
  | "beyond_head"
  /** The anchor is newer than the view (e.g. made after the export): nothing to compare. */
  | "after_view"
  /** Filtered export without the event at the anchored seq: cannot be checked offline. */
  | "not_covered"
  /** Receipt invalid (signature, timestamp or shape). */
  | "invalid"
  /** Receipt for another tenant: ignored. */
  | "other_tenant";

export interface AnchorCheckResult {
  seq: number;
  hash: string;
  createdAt: string;
  kind: string;
  /** Where the receipt came from (e.g. "file", "database", "manifest", "supplied"). */
  source?: string;
  status: AnchorCheckStatus;
  signature: CheckpointSignatureStatus;
  timestamp: TimestampStatus;
  timestampGenTime?: string;
}

export interface AnchorVerificationReport {
  ok: boolean;
  /** Receipts examined (excluding other tenants). */
  total: number;
  /** Receipts whose (seq, hash) was confirmed in the chain. */
  matched: number;
  results: AnchorCheckResult[];
  /** The newest confirmed anchor, if any. */
  latestMatched: AnchorCheckResult | null;
  /** The newest valid anchor (by seq) whatever its status. */
  latest: AnchorCheckResult | null;
  errors: AnchorReceiptIssue[];
  warnings: string[];
}

/** The seqs a view needs hashes for. */
export function anchoredSeqs(receipts: readonly AnchorReceipt[]): number[] {
  return [...new Set(receipts.map((r) => r.checkpoint?.seq).filter((s) => typeof s === "number"))];
}

export interface VerifyAnchorsOptions {
  trustedPublicKeys?: readonly string[];
  /** Label per receipt (parallel to receipts), e.g. "file" or "database". */
  sources?: readonly (string | undefined)[];
}

/**
 * Checks a chain view against anchor receipts. Fails on any invalid receipt
 * for this tenant, on a hash mismatch at an anchored seq, and on an anchor
 * that predates the view but lies beyond its head.
 */
export function verifyAnchorsAgainstChain(
  receipts: readonly AnchorReceipt[],
  view: ChainView,
  options: VerifyAnchorsOptions = {},
): AnchorVerificationReport {
  const errors: AnchorReceiptIssue[] = [];
  const warnings: string[] = [];
  const results: AnchorCheckResult[] = [];
  let otherTenant = 0;
  let notCovered = 0;
  receipts.forEach((receipt, i) => {
    const source = options.sources?.[i];
    const check = checkAnchorReceipt(receipt, options);
    const cp = receipt.checkpoint;
    if (check.issues.some((x) => x.code === "receipt_malformed")) {
      errors.push(...check.issues);
      return;
    }
    const base = {
      seq: cp.seq,
      hash: cp.hash,
      createdAt: cp.createdAt,
      kind: receipt.anchor?.kind ?? "supplied",
      ...(source ? { source } : {}),
      signature: check.signature,
      timestamp: check.timestamp,
      ...(check.timestampGenTime ? { timestampGenTime: check.timestampGenTime } : {}),
    };
    if (cp.tenantId !== view.tenantId) {
      otherTenant += 1;
      results.push({ ...base, status: "other_tenant" });
      return;
    }
    if (check.issues.length > 0) {
      errors.push(...check.issues);
      results.push({ ...base, status: "invalid" });
      return;
    }
    let status: AnchorCheckStatus;
    if (cp.seq > view.head.seq) {
      const before =
        view.takenAt !== undefined && Date.parse(cp.createdAt) <= Date.parse(view.takenAt);
      status = view.takenAt === undefined || before ? "beyond_head" : "after_view";
      if (status === "beyond_head") {
        errors.push({
          code: "anchor_beyond_head",
          seq: cp.seq,
          message: `anchored seq ${cp.seq} (${cp.createdAt}) is beyond the chain head ${view.head.seq}: events were removed or the chain was rewritten`,
        });
      }
    } else {
      const actual = cp.seq === view.head.seq ? view.head.hash : view.hashes.get(cp.seq);
      if (actual === undefined) {
        if (view.complete) {
          status = "mismatch";
          errors.push({
            code: "anchor_mismatch",
            seq: cp.seq,
            message: `the chain has no event at anchored seq ${cp.seq}`,
          });
        } else {
          status = "not_covered";
          notCovered += 1;
        }
      } else if (actual === cp.hash) {
        status = "match";
      } else {
        status = "mismatch";
        errors.push({
          code: "anchor_mismatch",
          seq: cp.seq,
          message: `hash at anchored seq ${cp.seq} differs from the checkpoint made at ${cp.createdAt}: the chain was rewritten`,
        });
      }
    }
    results.push({ ...base, status });
  });
  if (otherTenant) warnings.push(`${otherTenant} anchor(s) for other tenants were ignored`);
  if (notCovered) {
    warnings.push(
      `${notCovered} anchor(s) fall on seqs not included in this (filtered) export and could not be checked offline`,
    );
  }
  const mine = results.filter((r) => r.status !== "other_tenant" && r.status !== "invalid");
  const bySeq = (a: AnchorCheckResult, b: AnchorCheckResult) =>
    a.seq - b.seq || Date.parse(a.createdAt) - Date.parse(b.createdAt);
  const matchedList = mine.filter((r) => r.status === "match").sort(bySeq);
  return {
    ok: errors.length === 0,
    total: results.length - otherTenant,
    matched: matchedList.length,
    results,
    latestMatched: matchedList.at(-1) ?? null,
    latest: [...mine].sort(bySeq).at(-1) ?? null,
    errors,
    warnings,
  };
}
