/**
 * OSS chain anchors (ADR 0007): append-only file, HTTP webhook, RFC 3161 TSA.
 */
import { randomBytes, createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../canonical-json.ts";
import type { OutboundUrlPolicy } from "../security/outbound-url.ts";
import { checkpointDigest, makeReceipt, parseAnchorReceipts } from "./checkpoint.ts";
import { postBytes } from "./http.ts";
import { checkTimeStampToken, encodeTimeStampRequest, parseTimeStampResponse } from "./rfc3161.ts";
import type { AnchorReceipt, ChainAnchor, SignedCheckpoint } from "./types.ts";

export class AnchorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorConflictError";
  }
}

// --- File -----------------------------------------------------------------------

/** File name for a tenant's anchor log: the id when it is file-safe, else a hash. */
export function anchorFileName(tenantId: string): string {
  const safe = /^[A-Za-z0-9_-]{1,64}$/.test(tenantId)
    ? tenantId
    : `t-${createHash("sha256").update(tenantId).digest("hex").slice(0, 32)}`;
  return `${safe}.anchors.jsonl`;
}

export interface FileChainAnchorOptions {
  /** Directory, ideally on a separate volume or a WORM/backup mount (AFE_ANCHOR_DIR). */
  dir: string;
}

/**
 * Appends one JSON line (the receipt, RFC 8785 JSON) per checkpoint to
 * `<dir>/<tenant>.anchors.jsonl`, opened with O_APPEND and fsynced (file and,
 * on creation, the directory). Never rewrites or truncates. Refuses a
 * checkpoint that goes backwards (lower seq than the last line) or contradicts
 * it (same seq, different hash): that is what a rewritten chain looks like,
 * and anchoring it would bless the rewrite.
 *
 * It only helps if whoever can rewrite the database cannot also rewrite this
 * location (see ADR 0007 "Threat model").
 */
export function createFileChainAnchor(options: FileChainAnchorOptions): ChainAnchor {
  const dir = path.resolve(options.dir);
  const fileOf = (tenantId: string) => path.join(dir, anchorFileName(tenantId));

  const list = async (tenantId: string): Promise<AnchorReceipt[]> => {
    let text: string;
    try {
      text = await readFile(fileOf(tenantId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const { receipts, issues } = parseAnchorReceipts(text);
    if (issues.length > 0) {
      throw new Error(`anchor file ${fileOf(tenantId)}: ${issues[0]!.message}`);
    }
    return receipts.filter((r) => r.checkpoint.tenantId === tenantId);
  };

  return {
    kind: "file",
    list,
    async latest(tenantId) {
      return (await list(tenantId)).at(-1) ?? null;
    },
    async publish(signed: SignedCheckpoint) {
      const cp = signed.checkpoint;
      const file = fileOf(cp.tenantId);
      const last = (await list(cp.tenantId)).at(-1);
      if (last) {
        if (last.checkpoint.seq === cp.seq && last.checkpoint.hash !== cp.hash) {
          throw new AnchorConflictError(
            `anchor file already has a different hash at seq ${cp.seq}: the chain was rewritten`,
          );
        }
        if (last.checkpoint.seq > cp.seq) {
          throw new AnchorConflictError(
            `anchor file is already at seq ${last.checkpoint.seq}; refusing seq ${cp.seq}`,
          );
        }
      }
      await mkdir(dir, { recursive: true });
      const receipt = makeReceipt(signed, "file", file);
      let created = false;
      const fh = await open(file, "a", 0o640);
      try {
        created = (await fh.stat()).size === 0;
        await fh.appendFile(`${canonicalJson(receipt)}\n`, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (created) {
        // Make the new directory entry durable too.
        const dh = await open(dir, "r").catch(() => null);
        if (dh) {
          await dh.sync().catch(() => {});
          await dh.close();
        }
      }
      return receipt;
    },
  };
}

// --- Webhook ----------------------------------------------------------------------

export interface WebhookChainAnchorOptions {
  /** Operator-controlled endpoint (AFE_ANCHOR_WEBHOOK_URL). */
  url: string;
  policy: OutboundUrlPolicy;
  timeoutMs?: number;
}

/**
 * POSTs `{"type":"afe.chain_checkpoint","receipt":{...}}` (JSON) to an
 * operator endpoint, e.g. one that writes to object storage with a retention
 * lock. The receipt is Ed25519-signed, so the endpoint authenticates it by
 * verifying the signature with the pinned public key. Any non-2xx is a failure.
 */
export function createWebhookChainAnchor(options: WebhookChainAnchorOptions): ChainAnchor {
  return {
    kind: "webhook",
    async publish(signed) {
      const receipt = makeReceipt(signed, "webhook", options.url);
      const body = Buffer.from(canonicalJson({ type: "afe.chain_checkpoint", receipt }));
      const res = await postBytes(
        options.url,
        body,
        { "content-type": "application/json" },
        { policy: options.policy, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
        "anchor webhook",
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`anchor webhook responded with HTTP ${res.status}`);
      }
      return receipt;
    },
  };
}

// --- RFC 3161 TSA -----------------------------------------------------------------

export interface TsaChainAnchorOptions {
  /** TSA endpoint (AFE_ANCHOR_TSA_URL). */
  url: string;
  policy: OutboundUrlPolicy;
  timeoutMs?: number;
  /** Requested TSA policy OID (optional). */
  tsaPolicy?: string;
  /** Nonce source (tests). */
  randomNonce?: () => Buffer;
}

/**
 * Requests an RFC 3161 timestamp over SHA-256(UTF-8(JCS(checkpoint))) and
 * returns a receipt carrying the token. The service publishes TSA anchors
 * first, so later anchors (file, webhook) store the token too.
 */
export function createTsaChainAnchor(options: TsaChainAnchorOptions): ChainAnchor {
  return {
    kind: "rfc3161",
    async publish(signed) {
      const digestHex = checkpointDigest(signed.checkpoint);
      const nonce = (options.randomNonce ?? (() => randomBytes(8)))();
      nonce[0] = nonce[0]! & 0x7f || 1; // positive, no leading zero
      const req = encodeTimeStampRequest({
        digest: Buffer.from(digestHex, "hex"),
        nonce,
        certReq: true,
        ...(options.tsaPolicy ? { policy: options.tsaPolicy } : {}),
      });
      const res = await postBytes(
        options.url,
        req,
        { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" },
        {
          policy: options.policy,
          maxResponseBytes: 256 * 1024,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        },
        "timestamp authority",
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`timestamp authority responded with HTTP ${res.status}`);
      }
      const parsed = parseTimeStampResponse(res.body);
      if ((parsed.status !== 0 && parsed.status !== 1) || !parsed.token) {
        throw new Error(`timestamp authority refused the request (PKIStatus ${parsed.status})`);
      }
      const check = checkTimeStampToken(parsed.token, digestHex, nonce.toString("hex"));
      if (!check.ok) throw new Error(`timestamp authority returned a bad token: ${check.message}`);
      const withTs: SignedCheckpoint = {
        ...signed,
        timestamp: {
          kind: "rfc3161",
          tsaUrl: options.url,
          token: parsed.token.toString("base64"),
          genTime: check.tstInfo.genTime,
        },
      };
      return makeReceipt(withTs, "rfc3161", options.url);
    },
  };
}
