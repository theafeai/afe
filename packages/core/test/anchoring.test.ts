import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnchorConflictError,
  anchorFileName,
  buildFakeTimeStampResponse,
  checkAnchorReceipt,
  checkpointDigest,
  collectExport,
  createCheckpoint,
  createDefaultAuditExporter,
  createEd25519CheckpointSigner,
  createEd25519ExportSigner,
  createFileChainAnchor,
  createMemoryEventSink,
  createTsaChainAnchor,
  createWebhookChainAnchor,
  encodeTimeStampRequest,
  eventMatchesFilter,
  generateExportSigningKey,
  makeReceipt,
  parseAnchorReceipts,
  parseTimeStampResponse,
  parseTimeStampToken,
  signCheckpoint,
  verifyAnchorsAgainstChain,
  verifyCheckpointSignature,
  verifyExport,
  type AnchorReceipt,
  type CanonicalEvent,
  type EventFilter,
} from "../src/index.ts";
import { children, decodeOid, readRoot } from "../src/anchoring/asn1.ts";
import { deploymentInput } from "./fixtures.ts";

const TENANT = "t1";
const key = generateExportSigningKey();
const signer = createEd25519CheckpointSigner(key.privateKey);
const otherKey = generateExportSigningKey();
const LOCAL = { allowPrivateNetworks: true, allowInsecureHttp: true };

async function chain(rewrite = false): Promise<CanonicalEvent[]> {
  const sink = createMemoryEventSink();
  for (let i = 1; i <= 6; i++) {
    await sink.ingest(
      TENANT,
      deploymentInput({
        sourceEventId: `deployment:${i}:created`,
        actor: { type: "user", id: String(i), login: rewrite && i === 2 ? "mallory" : `user${i}` },
        occurredAt: new Date(Date.UTC(2026, 9, 1, 10, i)),
      }),
    );
  }
  return sink.events(TENANT);
}

async function receiptAt(events: CanonicalEvent[], seq: number, at?: Date): Promise<AnchorReceipt> {
  const e = events[seq - 1]!;
  const signed = await signCheckpoint(
    createCheckpoint({
      tenantId: TENANT,
      seq,
      hash: e.hash,
      createdAt: at ?? new Date("2026-10-01T11:00:00Z"),
    }),
    signer,
  );
  return makeReceipt(signed, "file", "/anchors/t1.anchors.jsonl");
}

async function exportOf(
  events: CanonicalEvent[],
  opts: { filter?: EventFilter; anchors?: AnchorReceipt[]; createdAt?: Date } = {},
) {
  const filter = opts.filter ?? {};
  const head = { seq: events.at(-1)!.seq, hash: events.at(-1)!.hash };
  return collectExport(
    createDefaultAuditExporter({ signer: createEd25519ExportSigner(key.privateKey) }).export({
      tenantId: TENANT,
      format: "json",
      filter,
      chainHead: head,
      exportId: "00000000-0000-4000-8000-000000000001",
      createdAt: opts.createdAt ?? new Date("2026-10-02T00:00:00Z"),
      includeRawPayloads: false,
      ...(opts.anchors ? { anchors: opts.anchors } : {}),
      records: events.filter((e) => eventMatchesFilter(e, filter)).map((event) => ({ event })),
    }),
  );
}

let events: CanonicalEvent[];
let rewritten: CanonicalEvent[];
beforeAll(async () => {
  events = await chain();
  rewritten = await chain(true);
});

describe("checkpoints", () => {
  it("signs and verifies; detects tampering and untrusted keys", async () => {
    const r = await receiptAt(events, 4);
    expect(verifyCheckpointSignature(r)).toBe("valid_unpinned");
    expect(verifyCheckpointSignature(r, [key.publicKey])).toBe("valid_trusted");
    expect(verifyCheckpointSignature(r, [otherKey.publicKey])).toBe("untrusted");
    const tampered = { ...r, checkpoint: { ...r.checkpoint, hash: events[4]!.hash } };
    expect(verifyCheckpointSignature(tampered)).toBe("invalid");
    expect(checkAnchorReceipt(tampered).issues[0]!.code).toBe("signature_invalid");
    expect(checkAnchorReceipt(r, { trustedPublicKeys: [otherKey.publicKey] }).issues[0]!.code).toBe(
      "signature_untrusted",
    );
    // A forged checkpoint signed with another key does not pass a pinned check.
    const forged = makeReceipt(
      await signCheckpoint(r.checkpoint, createEd25519CheckpointSigner(otherKey.privateKey)),
      "file",
    );
    expect(verifyCheckpointSignature(forged, [key.publicKey])).toBe("untrusted");
  });

  it("parses JSON Lines, arrays and single receipts", async () => {
    const a = await receiptAt(events, 2);
    const b = await receiptAt(events, 4);
    const lines = `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`;
    expect(parseAnchorReceipts(lines).receipts).toHaveLength(2);
    expect(parseAnchorReceipts(JSON.stringify([a, b])).receipts).toHaveLength(2);
    expect(parseAnchorReceipts(JSON.stringify(a, null, 2)).receipts).toHaveLength(1);
    const bad = parseAnchorReceipts(`${JSON.stringify(a)}\nnot json\n{"x":1}\n`);
    expect(bad.receipts).toHaveLength(1);
    expect(bad.issues.map((i) => i.code)).toEqual(["receipt_malformed", "receipt_malformed"]);
    // A bare signed checkpoint is accepted.
    const bare = parseAnchorReceipts(
      JSON.stringify({ checkpoint: a.checkpoint, signature: a.signature }),
    );
    expect(bare.receipts[0]!.anchor.kind).toBe("supplied");
  });
});

describe("verifying a chain against anchors", () => {
  const view = (evs: CanonicalEvent[], complete = true) => ({
    tenantId: TENANT,
    head: { seq: evs.at(-1)!.seq, hash: evs.at(-1)!.hash },
    hashes: new Map(evs.map((e) => [e.seq, e.hash])),
    complete,
  });

  it("confirms matching anchors and detects a consistently rewritten chain", async () => {
    const anchors = [await receiptAt(events, 3), await receiptAt(events, 6)];
    const ok = verifyAnchorsAgainstChain(anchors, view(events), {
      trustedPublicKeys: [key.publicKey],
    });
    expect(ok.ok).toBe(true);
    expect(ok.matched).toBe(2);
    expect(ok.latestMatched!.seq).toBe(6);

    const bad = verifyAnchorsAgainstChain(anchors, view(rewritten));
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => e.code)).toEqual(["anchor_mismatch", "anchor_mismatch"]);
  });

  it("detects truncation (anchor beyond the head) and ignores other tenants", async () => {
    const anchors = [await receiptAt(events, 6)];
    const r = verifyAnchorsAgainstChain(anchors, view(events.slice(0, 4)));
    expect(r.errors[0]!.code).toBe("anchor_beyond_head");
    const other = { ...anchors[0]!, checkpoint: { ...anchors[0]!.checkpoint, tenantId: "t2" } };
    const r2 = verifyAnchorsAgainstChain([other], view(events));
    expect(r2.total).toBe(0);
    expect(r2.warnings[0]).toMatch(/other tenants/);
  });
});

describe("export verification with anchors", () => {
  it("keeps old exports (no anchors) verifiable", async () => {
    const r = verifyExport(await exportOf(events));
    expect(r.ok).toBe(true);
    expect(r.anchors).toBeNull();
    expect(r.proofs.anchored).toBe(false);
    expect(r.manifest!.anchors).toBeUndefined();
    expect(r.limitations.join(" ")).toMatch(/No chain anchor was confirmed/);
  });

  it("confirms supplied anchors against a complete export", async () => {
    const r = verifyExport(await exportOf(events), {
      trustedPublicKeys: [key.publicKey],
      anchors: [await receiptAt(events, 2), await receiptAt(events, 5)],
      requireAnchor: true,
    });
    expect(r.errors).toEqual([]);
    expect(r.proofs.anchored).toBe(true);
    expect(r.anchors!.matched).toBe(2);
  });

  it("detects an export of a consistently rewritten chain", async () => {
    const body = await exportOf(rewritten);
    // Plain export verification passes: the rewritten chain is internally consistent.
    expect(verifyExport(body, { trustedPublicKeys: [key.publicKey] }).ok).toBe(true);
    const r = verifyExport(body, {
      trustedPublicKeys: [key.publicKey],
      anchors: [await receiptAt(events, 4)],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("anchor_mismatch");
  });

  it("detects a truncated chain: an anchor made before the export is beyond its head", async () => {
    const short = events.slice(0, 4);
    const early = await receiptAt(events, 6, new Date("2026-10-01T12:00:00Z"));
    const r = verifyExport(await exportOf(short), { anchors: [early] });
    expect(r.errors.map((e) => e.code)).toContain("anchor_beyond_head");
    // An anchor made after the export is not an error.
    const late = await receiptAt(events, 6, new Date("2026-10-03T00:00:00Z"));
    const r2 = verifyExport(await exportOf(short), { anchors: [late] });
    expect(r2.ok).toBe(true);
    expect(r2.anchors!.results[0]!.status).toBe("after_view");
  });

  it("reports anchors on seqs a filtered export does not contain as not covered", async () => {
    const filter = { actors: ["user2"] } as EventFilter;
    const body = await exportOf(events, { filter });
    const r = verifyExport(body, { anchors: [await receiptAt(events, 4)] });
    expect(r.ok).toBe(true);
    expect(r.anchors!.results[0]!.status).toBe("not_covered");
    expect(
      verifyExport(body, { anchors: [await receiptAt(events, 4)], requireAnchor: true }).ok,
    ).toBe(false);
    // The head anchor is checked against the (signed) manifest chainHead.
    const r2 = verifyExport(body, { anchors: [await receiptAt(events, 6)], requireAnchor: true });
    expect(r2.ok).toBe(true);
    expect(r2.anchors!.results[0]!.status).toBe("match");
  });

  it("embeds receipts in the signed manifest and verifies them", async () => {
    const embedded = await receiptAt(events, 6);
    const body = await exportOf(events, { anchors: [embedded] });
    const r = verifyExport(body, { trustedPublicKeys: [key.publicKey], requireAnchor: true });
    expect(r.errors).toEqual([]);
    expect(r.manifest!.anchors).toHaveLength(1);
    expect(r.anchors!.results[0]!.source).toBe("manifest");
    // Wrong key for anchors.
    const r2 = verifyExport(body, {
      trustedPublicKeys: [key.publicKey],
      anchorPublicKeys: [otherKey.publicKey],
    });
    expect(r2.errors.map((e) => e.code)).toContain("anchor_invalid");
    // Tampering with the embedded receipt breaks the manifest signature.
    const tampered = body.replace(embedded.signature.value, otherKey.publicKey);
    expect(verifyExport(tampered).errors.map((e) => e.code)).toContain("signature_invalid");
  });
});

describe("RFC 3161", () => {
  const digest = Buffer.alloc(32, 7);

  it("encodes a TimeStampReq", () => {
    const req = encodeTimeStampRequest({ digest, nonce: Buffer.from([1, 2, 3]) });
    const f = children(readRoot(req));
    expect(f[0]!.content).toEqual(Buffer.from([1])); // version
    const mi = children(f[1]!);
    expect(decodeOid(children(mi[0]!)[0]!)).toBe("2.16.840.1.101.3.4.2.1");
    expect(mi[1]!.content).toEqual(digest);
    expect(f[2]!.content).toEqual(Buffer.from([1, 2, 3])); // nonce
    expect(f[3]!.content).toEqual(Buffer.from([0xff])); // certReq
    // Known-answer: the fixed prefix of a v1 SHA-256 request.
    // SEQUENCE(62) { INTEGER 1, SEQUENCE { SEQUENCE { OID sha256, NULL }, OCTET STRING(32) ...
    expect(req.subarray(0, 24).toString("hex")).toBe(
      "303e0201013031300d060960864801650304020105000420",
    );
  });

  it("parses a response and its TSTInfo", () => {
    const resp = buildFakeTimeStampResponse({
      digest,
      nonce: Buffer.from([0x0a, 0x0b]),
      genTime: new Date("2026-10-27T10:00:00.123Z"),
    });
    const parsed = parseTimeStampResponse(resp);
    expect(parsed.status).toBe(0);
    const tst = parseTimeStampToken(parsed.token!);
    expect(tst.hashedMessage).toBe(digest.toString("hex"));
    expect(tst.nonce).toBe("0a0b");
    expect(tst.genTime).toBe("2026-10-27T10:00:00.123Z");
    expect(parseTimeStampResponse(buildFakeTimeStampResponse({ digest, status: 2 })).token).toBe(
      null,
    );
    expect(() => parseTimeStampResponse(Buffer.from([0x30, 0x80, 0, 0]))).toThrow(/DER/);
  });
});

function listen(handler: (req: IncomingMessage, body: Buffer) => [number, Buffer | string]) {
  return new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const [status, body] = handler(req, Buffer.concat(chunks));
        res.writeHead(status).end(body);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }),
    );
  });
}

describe("anchors", () => {
  let dir: string;
  const servers: Server[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "afe-anchors-"));
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("file anchor appends one line per checkpoint and never rewrites", async () => {
    const anchor = createFileChainAnchor({ dir });
    const r1 = await anchor.publish(await receiptAt(events, 2));
    const file = path.join(dir, anchorFileName(TENANT));
    const first = await readFile(file, "utf8");
    expect(first.split("\n")).toHaveLength(2);
    await anchor.publish(await receiptAt(events, 4));
    const second = await readFile(file, "utf8");
    expect(second.startsWith(first)).toBe(true);
    expect(second.trim().split("\n")).toHaveLength(2);
    expect((await anchor.list!(TENANT)).map((r) => r.checkpoint.seq)).toEqual([2, 4]);
    expect((await anchor.latest!(TENANT))!.checkpoint.seq).toBe(4);
    expect(r1.anchor).toMatchObject({ kind: "file", location: file });

    // Rewritten chain: same seq, different hash -> refused, file unchanged.
    await expect(anchor.publish(await receiptAt(rewritten, 4))).rejects.toBeInstanceOf(
      AnchorConflictError,
    );
    // Going backwards is refused too.
    await expect(anchor.publish(await receiptAt(events, 3))).rejects.toThrow(/refusing/);
    expect(await readFile(file, "utf8")).toBe(second);
    // A corrupted file is reported, not silently skipped.
    await writeFile(path.join(dir, anchorFileName("t9")), "garbage\n");
    await expect(anchor.list!("t9")).rejects.toThrow(/not valid JSON/);
    expect(anchorFileName("../evil")).toMatch(/^t-[0-9a-f]{32}\.anchors\.jsonl$/);
  });

  it("webhook anchor posts the signed receipt and validates the URL", async () => {
    const got: Buffer[] = [];
    const { server, url } = await listen((_req, body) => {
      got.push(body);
      return [204, ""];
    });
    servers.push(server);
    const anchor = createWebhookChainAnchor({ url, policy: LOCAL });
    const r = await anchor.publish(await receiptAt(events, 5));
    const posted = JSON.parse(got[0]!.toString()) as { type: string; receipt: AnchorReceipt };
    expect(posted.type).toBe("afe.chain_checkpoint");
    expect(verifyCheckpointSignature(posted.receipt, [key.publicKey])).toBe("valid_trusted");
    expect(r.anchor.kind).toBe("webhook");
    // Outbound rules (R6): private/http targets refused by default.
    await expect(
      createWebhookChainAnchor({ url, policy: {} }).publish(await receiptAt(events, 5)),
    ).rejects.toThrow(/https/);
    const { server: s2, url: failing } = await listen(() => [500, "secret internals"]);
    servers.push(s2);
    const err = await createWebhookChainAnchor({ url: failing, policy: LOCAL })
      .publish(await receiptAt(events, 5))
      .catch((e: Error) => e);
    expect((err as Error).message).toBe("anchor webhook responded with HTTP 500");
  });

  it("TSA anchor stores the token; verification checks the imprint", async () => {
    let mode: "ok" | "wrong" | "reject" = "ok";
    const { server, url } = await listen((req, body) => {
      expect(req.headers["content-type"]).toBe("application/timestamp-query");
      const f = children(readRoot(body));
      const reqDigest = children(f[1]!)[1]!.content;
      const nonce = f.find((n, i) => i > 1 && n.tag === 0x02)!.content;
      if (mode === "reject")
        return [200, buildFakeTimeStampResponse({ digest: reqDigest, status: 2 })];
      return [
        200,
        buildFakeTimeStampResponse({
          digest: mode === "wrong" ? Buffer.alloc(32, 1) : reqDigest,
          nonce,
          genTime: new Date("2026-10-01T11:00:01Z"),
        }),
      ];
    });
    servers.push(server);
    const anchor = createTsaChainAnchor({ url, policy: LOCAL });
    const signed = await receiptAt(events, 6);
    const r = await anchor.publish(signed);
    expect(r.timestamp!.genTime).toBe("2026-10-01T11:00:01.000Z");
    const check = checkAnchorReceipt(r, { trustedPublicKeys: [key.publicKey] });
    expect(check).toMatchObject({
      signature: "valid_trusted",
      timestamp: "imprint_ok",
      issues: [],
    });
    expect(parseTimeStampToken(Buffer.from(r.timestamp!.token, "base64")).hashedMessage).toBe(
      checkpointDigest(signed.checkpoint),
    );

    // A token for different data (moved to another checkpoint) is detected.
    const moved = { ...(await receiptAt(events, 5)), timestamp: r.timestamp };
    expect(checkAnchorReceipt(moved).issues.map((i) => i.code)).toEqual([
      "timestamp_imprint_mismatch",
    ]);
    mode = "wrong";
    await expect(anchor.publish(signed)).rejects.toThrow(/imprint/);
    mode = "reject";
    await expect(anchor.publish(signed)).rejects.toThrow(/PKIStatus 2/);
  });
});
