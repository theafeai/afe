/**
 * Publishes signed chain checkpoints to the configured anchors and checks the
 * live chain against them (ADR 0007).
 */
import type pg from "pg";
import {
  anchoredSeqs,
  createCheckpoint,
  signCheckpoint,
  verifyAnchorsAgainstChain,
  type AnchorReceipt,
  type AnchorReceiptIssue,
  type AnchorCheckResult,
  type ChainAnchor,
  type CheckpointSigner,
  type SignedCheckpoint,
} from "@afe/core";
import {
  getAnchorState,
  getChainHead,
  getEventHashesBySeq,
  getLatestAnchorReceipts,
  insertAnchorReceipt,
  listAnchorReceipts,
  listChainHeadsAcrossTenants,
  recordAnchorAttempt,
  type ChainAnchorState,
} from "@afe/db";

export const ANCHOR_JOBS = { PUBLISH: "anchor.publish" } as const;

export interface AnchorLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface AnchorServiceOptions {
  pool: pg.Pool;
  anchors: ChainAnchor[];
  signer: CheckpointSigner | null;
  /** Keys accepted on receipts besides the signer's own. */
  trustedPublicKeys?: string[];
  log: AnchorLogger;
  intervalMs: number;
  onExport: boolean;
  now?: () => Date;
}

export type PublishStatus =
  | "disabled"
  | "empty"
  | "unchanged"
  | "published"
  | "partial"
  | "failed"
  /** A previous anchor no longer matches the live chain: not anchoring the rewritten chain. */
  | "conflict";

export interface PublishResult {
  tenantId: string;
  status: PublishStatus;
  seq?: number;
  receipts: AnchorReceipt[];
  errors: string[];
}

export interface LiveAnchorStatus {
  /** Anchors and a signing key are configured. */
  configured: boolean;
  ok: boolean;
  total: number;
  matched: number;
  /** At least one source outside the database (file, ...) was read. */
  externalSourceChecked: boolean;
  sources: { name: string; receipts: number; error?: string }[];
  latest:
    | (AnchorCheckResult & {
        ageSeconds: number;
        /** Head moved and the newest anchor is older than twice the interval. */
        stale: boolean;
      })
    | null;
  errors: AnchorReceiptIssue[];
  warnings: string[];
  lastRun: ChainAnchorState | null;
}

/** TSA anchors run first so later anchors (file, webhook) carry the token. */
function ordered(anchors: ChainAnchor[]): ChainAnchor[] {
  return [...anchors].sort((a, b) => Number(b.kind === "rfc3161") - Number(a.kind === "rfc3161"));
}

export class AnchorService {
  readonly anchors: ChainAnchor[];
  private readonly now: () => Date;

  constructor(private readonly o: AnchorServiceOptions) {
    this.anchors = ordered(o.anchors);
    this.now = o.now ?? (() => new Date());
  }

  get configured(): boolean {
    return this.anchors.length > 0 && this.o.signer !== null;
  }

  get trustedPublicKeys(): string[] {
    return [
      ...(this.o.signer ? [this.o.signer.publicKey] : []),
      ...(this.o.trustedPublicKeys ?? []),
    ];
  }

  /** External (readable) anchors' latest receipts plus the newest DB receipts. */
  private async priorReceipts(tenantId: string): Promise<AnchorReceipt[]> {
    const out: AnchorReceipt[] = [];
    for (const a of this.anchors) {
      const latest = a.latest
        ? await a.latest(tenantId)
        : a.list
          ? ((await a.list(tenantId)).at(-1) ?? null)
          : null;
      if (latest) out.push(latest);
    }
    out.push(...(await getLatestAnchorReceipts(this.o.pool, tenantId)));
    return out;
  }

  /**
   * Anchors the tenant's chain head (or `head`, e.g. an export snapshot's) if
   * it is newer than the last anchor. Before publishing, checks that the
   * previous anchors still match the live chain; if not, refuses (status
   * "conflict") so a rewritten chain is never blessed with a new anchor.
   */
  async publishTenant(
    tenantId: string,
    head?: { seq: number; hash: string },
  ): Promise<PublishResult> {
    const result: PublishResult = { tenantId, status: "disabled", receipts: [], errors: [] };
    if (!this.configured) return result;
    const h = head ?? (await getChainHead(this.o.pool, tenantId));
    if (h.seq === 0) return { ...result, status: "empty" };
    result.seq = h.seq;

    let prior: AnchorReceipt[];
    try {
      prior = await this.priorReceipts(tenantId);
    } catch (err) {
      const msg = `cannot read previous anchors: ${(err as Error).message}`;
      await recordAnchorAttempt(this.o.pool, tenantId, msg, this.now());
      this.o.log.error({ tenantId }, `chain anchoring failed: ${msg}`);
      return { ...result, status: "failed", errors: [msg] };
    }
    const live = await getEventHashesBySeq(this.o.pool, tenantId, anchoredSeqs(prior));
    const broken = prior.find((r) => live.get(r.checkpoint.seq) !== r.checkpoint.hash);
    if (broken) {
      const msg =
        `anchor at seq ${broken.checkpoint.seq} (${broken.checkpoint.createdAt}) no longer matches ` +
        "the live chain: the audit log may have been rewritten; not anchoring";
      await recordAnchorAttempt(this.o.pool, tenantId, msg, this.now());
      this.o.log.error(
        { tenantId, seq: broken.checkpoint.seq, anchor: broken.anchor.kind },
        `chain anchoring refused: ${msg}`,
      );
      return { ...result, status: "conflict", errors: [msg] };
    }
    const newest = Math.max(0, ...prior.map((r) => r.checkpoint.seq));
    if (newest >= h.seq) return { ...result, status: "unchanged" };

    let signed: SignedCheckpoint = await signCheckpoint(
      createCheckpoint({ tenantId, seq: h.seq, hash: h.hash, createdAt: this.now() }),
      this.o.signer!,
    );
    for (const anchor of this.anchors) {
      try {
        const receipt = await anchor.publish(signed);
        if (receipt.timestamp && !signed.timestamp)
          signed = { ...signed, timestamp: receipt.timestamp };
        await insertAnchorReceipt(this.o.pool, tenantId, receipt);
        result.receipts.push(receipt);
      } catch (err) {
        result.errors.push(`${anchor.kind}: ${(err as Error).message}`);
      }
    }
    const error = result.errors.length ? result.errors.join("; ") : null;
    await recordAnchorAttempt(this.o.pool, tenantId, error, this.now());
    result.status =
      result.errors.length === 0 ? "published" : result.receipts.length ? "partial" : "failed";
    if (error) this.o.log.warn({ tenantId, seq: h.seq }, `chain anchoring incomplete: ${error}`);
    else this.o.log.info({ tenantId, seq: h.seq }, "chain head anchored");
    return result;
  }

  /** The scheduled job: anchors every tenant whose head moved. */
  async publishAll(): Promise<PublishResult[]> {
    if (!this.configured) return [];
    const out: PublishResult[] = [];
    for (const head of await listChainHeadsAcrossTenants(this.o.pool)) {
      out.push(await this.publishTenant(head.tenantId, head));
    }
    return out;
  }

  /**
   * Export time: anchors the export's chain head (when enabled) and returns
   * the receipts of the newest checkpoint at or before it, for the manifest.
   * Never fails the export: problems are logged.
   */
  async receiptsForExport(
    tenantId: string,
    head: { seq: number; hash: string },
  ): Promise<AnchorReceipt[]> {
    try {
      if (this.o.onExport && head.seq > 0) await this.publishTenant(tenantId, head);
      return await getLatestAnchorReceipts(this.o.pool, tenantId, head.seq);
    } catch (err) {
      this.o.log.warn({ tenantId }, `anchoring at export failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Checks the live chain against every receipt from external anchors and the database. */
  async status(tenantId: string): Promise<LiveAnchorStatus> {
    const receipts: AnchorReceipt[] = [];
    const sourceOf: string[] = [];
    const sources: LiveAnchorStatus["sources"] = [];
    const errors: AnchorReceiptIssue[] = [];
    const seen = new Set<string>();
    const add = (r: AnchorReceipt, source: string) => {
      const key = `${r.anchor?.kind}|${r.signature?.value}`;
      if (seen.has(key)) return;
      seen.add(key);
      receipts.push(r);
      sourceOf.push(source);
    };
    let external = false;
    for (const a of this.anchors) {
      if (!a.list) continue;
      try {
        const list = await a.list(tenantId);
        list.forEach((r) => add(r, a.kind));
        sources.push({ name: a.kind, receipts: list.length });
        external = true;
      } catch (err) {
        const msg = (err as Error).message;
        sources.push({ name: a.kind, receipts: 0, error: msg });
        errors.push({ code: "anchor_source_error", message: `${a.kind}: ${msg}` });
      }
    }
    const stored = await listAnchorReceipts(this.o.pool, tenantId, { limit: 10_000 });
    stored.forEach((s) => add(s.receipt, "database"));
    sources.push({ name: "database", receipts: stored.length });

    const head = await getChainHead(this.o.pool, tenantId);
    const hashes = await getEventHashesBySeq(this.o.pool, tenantId, anchoredSeqs(receipts));
    const report = verifyAnchorsAgainstChain(
      receipts,
      { tenantId, head, hashes, complete: true },
      { trustedPublicKeys: this.trustedPublicKeys, sources: sourceOf },
    );
    const warnings = [...report.warnings];
    if (receipts.length > 0 && !external) {
      warnings.push(
        "only the database copy of the anchors was checked; check against the anchor file or a TSA receipt for independent evidence",
      );
    }
    let latest: LiveAnchorStatus["latest"] = null;
    if (report.latest) {
      const ageSeconds = Math.max(
        0,
        Math.round((this.now().getTime() - Date.parse(report.latest.createdAt)) / 1000),
      );
      const stale =
        this.configured &&
        head.seq > report.latest.seq &&
        ageSeconds * 1000 > 2 * this.o.intervalMs;
      if (stale)
        warnings.push(`the newest anchor is ${ageSeconds}s old and the chain has moved on`);
      latest = { ...report.latest, ageSeconds, stale };
    }
    if (this.configured && receipts.length === 0 && head.seq > 0) {
      warnings.push("no anchors yet: the chain head has not been anchored");
    }
    const allErrors = [...errors, ...report.errors];
    return {
      configured: this.configured,
      ok: allErrors.length === 0,
      total: report.total,
      matched: report.matched,
      externalSourceChecked: external,
      sources,
      latest,
      errors: allErrors,
      warnings,
      lastRun: await getAnchorState(this.o.pool, tenantId),
    };
  }

  /** Checks receipts supplied by an auditor against the live chain. */
  async verifySupplied(tenantId: string, supplied: AnchorReceipt[], trustedPublicKeys?: string[]) {
    const head = await getChainHead(this.o.pool, tenantId);
    const hashes = await getEventHashesBySeq(this.o.pool, tenantId, anchoredSeqs(supplied));
    return verifyAnchorsAgainstChain(
      supplied,
      { tenantId, head, hashes, complete: true },
      {
        trustedPublicKeys:
          trustedPublicKeys && trustedPublicKeys.length
            ? trustedPublicKeys
            : this.trustedPublicKeys,
      },
    );
  }
}
