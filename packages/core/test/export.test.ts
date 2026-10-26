import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  collectExport,
  createDefaultAuditExporter,
  createEd25519ExportSigner,
  createMemoryEventSink,
  eventMatchesFilter,
  generateExportSigningKey,
  hashEvent,
  normaliseEventFilter,
  parseCsv,
  verifyExport,
  type CanonicalEvent,
  type EventFilter,
  type ExportRecord,
  type ExportSigner,
} from "../src/index.ts";
import { deploymentInput } from "./fixtures.ts";

const TENANT = "t1";
let events: CanonicalEvent[];
let raws: Map<string, { contentType: string; body: Uint8Array }>;

beforeAll(async () => {
  const sink = createMemoryEventSink();
  for (let i = 1; i <= 6; i++) {
    await sink.ingest(
      TENANT,
      deploymentInput({
        sourceEventId: `deployment:${i}:created`,
        source: i % 2 ? "github" : "vercel",
        actor: {
          type: "user",
          id: String(100 + i),
          login: i === 3 ? "=cmd|' /C calc'!A0" : `user${i}`,
        },
        occurredAt: new Date(Date.UTC(2026, 9, 1, 10, i)),
        rawPayload: { contentType: "application/json", body: `{"n":${i}}` },
      }),
    );
  }
  events = sink.events(TENANT);
  raws = sink.rawPayloads;
});

function records(filter: EventFilter = {}, withRaw = false): ExportRecord[] {
  return events
    .filter((e) => eventMatchesFilter(e, filter))
    .map((event) => ({ event, rawPayload: withRaw ? raws.get(event.rawPayload!.id)! : null }));
}

async function exportText(
  format: "json" | "csv",
  opts: { filter?: EventFilter; signer?: ExportSigner; raw?: boolean } = {},
): Promise<string> {
  const filter = opts.filter ?? {};
  const head = { seq: events.at(-1)!.seq, hash: events.at(-1)!.hash };
  return collectExport(
    createDefaultAuditExporter({ signer: opts.signer ?? null }).export({
      tenantId: TENANT,
      format,
      filter,
      chainHead: head,
      exportId: "00000000-0000-4000-8000-000000000001",
      createdAt: new Date("2026-10-26T00:00:00Z"),
      includeRawPayloads: opts.raw ?? false,
      records: records(filter, opts.raw),
    }),
  );
}

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe("export + offline verification", () => {
  it.each(["json", "csv"] as const)(
    "round-trips a full %s export as the complete chain",
    async (format) => {
      const text = await exportText(format);
      const r = verifyExport(text);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.eventCount).toBe(6);
      expect(r.proofs).toMatchObject({
        eventsIntact: true,
        exportIntact: true,
        completeChain: true,
        headIncluded: true,
        linksVerified: 5,
      });
      expect(r.manifest!.completeChain).toBe(true);
      expect(r.signature.status).toBe("absent");
      // Bytes in, bytes out.
      expect(verifyExport(new TextEncoder().encode(text)).ok).toBe(true);
    },
  );

  it("verifies a filtered (non-contiguous) export and states what is not proven", async () => {
    const filter = normaliseEventFilter({ sources: "github" });
    const text = await exportText("json", { filter });
    const r = verifyExport(text);
    expect(r.ok).toBe(true);
    expect(r.eventCount).toBe(3);
    expect(r.manifest!.contiguous).toBe(false);
    expect(r.proofs.completeChain).toBe(false);
    expect(r.proofs.linksVerified).toBe(0);
    expect(r.proofs.matchesFilter).toBe(true);
    expect(r.limitations.join(" ")).toMatch(/Completeness is not proven/);
  });

  it("embeds and checks raw payloads in JSON exports", async () => {
    const text = await exportText("json", { raw: true });
    expect(verifyExport(text).ok).toBe(true);
    const tampered = text.replace(
      Buffer.from('{"n":2}').toString("base64"),
      Buffer.from('{"n":9}').toString("base64"),
    );
    expect(codes(verifyExport(tampered))).toContain("raw_payload_mismatch");
  });

  it("detects a modified event field", async () => {
    for (const format of ["json", "csv"] as const) {
      const text = await exportText(format);
      const q = format === "csv" ? '""' : '"';
      const tampered = text.replace(`${q}login${q}:${q}user2${q}`, `${q}login${q}:${q}mallory${q}`);
      expect(tampered).not.toBe(text);
      const r = verifyExport(tampered);
      expect(r.ok).toBe(false);
      expect(codes(r)).toEqual(
        expect.arrayContaining(["hash_mismatch", "content_digest_mismatch"]),
      );
    }
  });

  it("detects an edited readable CSV column", async () => {
    const text = await exportText("csv");
    const tampered = text.replace(",user4,", ",mallory,");
    expect(tampered).not.toBe(text);
    expect(codes(verifyExport(tampered))).toContain("csv_column_mismatch");
  });

  it("neutralises spreadsheet formulas in readable CSV cells", async () => {
    const text = await exportText("csv");
    const row = parseCsv(text).find((r) => r.cells[1] === "3")!;
    expect(row.cells[10]).toBe("'=cmd|' /C calc'!A0");
  });

  it("detects a removed event", async () => {
    const text = await exportText("json");
    const lines = text.split("\n");
    lines.splice(2, 1);
    const r = verifyExport(lines.join("\n"));
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "contiguity_mismatch",
        "complete_chain_mismatch",
        "count_mismatch",
        "events_digest_mismatch",
        "content_digest_mismatch",
      ]),
    );
    const csv = parseCsv(await exportText("csv"));
    const csvText = await exportText("csv");
    const removed = csvText.slice(0, csv[2]!.start) + csvText.slice(csv[3]!.start);
    expect(codes(verifyExport(removed))).toContain("count_mismatch");
  });

  it("detects a removed and truncated manifest", async () => {
    const text = await exportText("json");
    const noManifest = text.split("\n").slice(0, -2).join("\n") + "\n";
    expect(codes(verifyExport(noManifest))).toEqual(["manifest_missing"]);
  });

  it("detects an altered unsigned manifest when it no longer matches the content", async () => {
    const text = await exportText("json");
    const r = verifyExport(text.replace('"count":6', '"count":5'));
    expect(codes(r)).toContain("count_mismatch");
    const head = verifyExport(
      text.replace(
        /"chainHead":\{"hash":"[0-9a-f]{64}"/,
        `"chainHead":{"hash":"${"a".repeat(64)}"`,
      ),
    );
    expect(codes(head)).toContain("head_mismatch");
  });

  it("signs manifests and detects any manifest change", async () => {
    const key = generateExportSigningKey();
    const signer = createEd25519ExportSigner(key.privateKey);
    expect(signer.publicKey).toBe(key.publicKey);
    for (const format of ["json", "csv"] as const) {
      const text = await exportText(format, { signer });
      const ok = verifyExport(text, { trustedPublicKeys: [key.publicKey] });
      expect(ok.errors).toEqual([]);
      expect(ok.signature).toEqual({ status: "valid_trusted", keyId: key.keyId });
      expect(verifyExport(text).signature.status).toBe("valid_unpinned");

      const altered = text.replace("2026-10-26T00:00:00.000Z", "2026-10-27T00:00:00.000Z");
      expect(codes(verifyExport(altered, { trustedPublicKeys: [key.publicKey] }))).toEqual([
        "signature_invalid",
      ]);
    }
    const other = generateExportSigningKey();
    const text = await exportText("json", { signer });
    expect(codes(verifyExport(text, { trustedPublicKeys: [other.publicKey] }))).toEqual([
      "signature_untrusted",
    ]);
    // Re-signing with an attacker's key is caught by pinning.
    const unsigned = await exportText("json");
    expect(codes(verifyExport(unsigned, { requireSignature: true }))).toEqual([
      "signature_missing",
    ]);
  });

  it("accepts a separately kept manifest and flags conflicts", async () => {
    const text = await exportText("json");
    const lines = text.trimEnd().split("\n");
    const manifestLine = lines.at(-1)!;
    const body = lines.slice(0, -1).join("\n") + "\n";
    expect(verifyExport(body, { manifest: manifestLine }).ok).toBe(true);
    const bare = JSON.stringify(JSON.parse(manifestLine).manifest);
    expect(verifyExport(body, { manifest: bare }).ok).toBe(true);
    const other = JSON.parse(manifestLine);
    other.manifest.count = 2;
    expect(codes(verifyExport(text, { manifest: JSON.stringify(other) }))).toContain(
      "manifest_conflict",
    );
  });

  it("detects events that do not match the stated filter", async () => {
    const filter = normaliseEventFilter({ sources: "github" });
    const text = await exportText("json", { filter });
    // Swap the stated filter (unsigned): every event now violates it.
    const r = verifyExport(text.replace('"sources":["github"]', '"sources":["vercel"]'));
    expect(codes(r)).toContain("filter_mismatch");
  });

  it("rejects a forged extra event even with recomputed hash", async () => {
    const text = await exportText("json");
    const lines = text.trimEnd().split("\n");
    const ev = JSON.parse(lines[0]!).event as CanonicalEvent;
    const forged = { ...ev, actor: { type: "user", login: "mallory" } } as CanonicalEvent;
    forged.hash = hashEvent(forged);
    lines.splice(1, 0, canonicalJson({ recordType: "event", event: forged }));
    const r = verifyExport(lines.join("\n") + "\n");
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(expect.arrayContaining(["seq_order", "count_mismatch"]));
  });
});
