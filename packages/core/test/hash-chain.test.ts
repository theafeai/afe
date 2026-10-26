import { describe, expect, it } from "vitest";
import {
  buildChainedEvent,
  canonicalEventSchema,
  ChainVerifier,
  createMemoryEventSink,
  eventHashInput,
  GENESIS_HASH,
  hashEvent,
  parseEventInput,
  sha256Hex,
  verifyChain,
  type CanonicalEvent,
} from "../src/index.ts";
import { deploymentInput } from "./fixtures.ts";

function fixedEvent(): CanonicalEvent {
  return buildChainedEvent({
    tenantId: "default",
    seq: 1,
    prevHash: GENESIS_HASH,
    input: parseEventInput(deploymentInput()),
    rawPayload: {
      id: "6f1c3c1e-8a7e-4b8e-9d4a-2f1e0c9b8a70",
      sha256: sha256Hex('{"deployment":{"id":1234567}}'),
    },
    id: "0b9f6c43-2f8e-4b49-a9c5-0c3c6d1d7e21",
    recordedAt: new Date("2026-10-01T10:00:02Z"),
  });
}

async function chainOf(n: number): Promise<CanonicalEvent[]> {
  const sink = createMemoryEventSink();
  for (let i = 0; i < n; i++) {
    await sink.ingest("t1", deploymentInput({ sourceEventId: `deployment:${i}:created` }));
  }
  return sink.events("t1");
}

describe("event hashing", () => {
  it("is stable (golden value; changing it breaks every stored chain)", () => {
    const e = fixedEvent();
    const expectedInput =
      '{"action":"deployment.created","actor":{"id":"583231","login":"octocat",' +
      '"name":"The Octocat","triggeredBy":{"id":"41898282","login":"github-actions[bot]",' +
      '"type":"bot"},"type":"user"},"connectionId":"conn_gh_1","correlation":{"commitShas":' +
      '["4f2c9b8e1d7a6b5c3e2f1a0b9c8d7e6f5a4b3c2d"],"deploymentIds":["github:1234567"],' +
      '"environments":["production"],"refs":["refs/heads/main"],"repositories":' +
      '["github.com/acme/api"]},"data":{"payload":{"n":1},"task":"deploy"},' +
      '"id":"0b9f6c43-2f8e-4b49-a9c5-0c3c6d1d7e21","observation":{"deliveryId":' +
      '"72d3162e-cc78-11e3-81ab-4c9367dc0958","method":"webhook"},' +
      '"observedAt":"2026-10-01T10:00:01.500Z","occurredAt":"2026-10-01T10:00:00.123Z",' +
      '"outcome":"pending","prevHash":"0000000000000000000000000000000000000000000000000000000000000000",' +
      '"rawPayload":{"id":"6f1c3c1e-8a7e-4b8e-9d4a-2f1e0c9b8a70","sha256":' +
      '"a6d1dd11b5814791460c21f38f62611e2cc1e05bf0807cc7d429f0c8c72c3343"},' +
      '"recordedAt":"2026-10-01T10:00:02.000Z","schemaVersion":1,"seq":1,"source":"github",' +
      '"sourceEventId":"deployment:1234567:created","target":{"environment":"production",' +
      '"id":"acme/api:production","name":"production","ref":"refs/heads/main",' +
      '"repository":"acme/api","type":"environment"},"tenantId":"default",' +
      '"trigger":{"sourceValue":"workflow_run","type":"upstream"}}';
    expect(eventHashInput(e)).toBe(expectedInput);
    expect(sha256Hex(expectedInput)).toBe(e.hash);
    expect(e.hash).toBe("10d43e189b804e4dc1b69fbc5a89acc90c26589505256b974aff665f81a1a431");
  });

  it("does not depend on key order or on the hash field", () => {
    const e = fixedEvent();
    const reordered = Object.fromEntries(Object.entries(e).reverse()) as CanonicalEvent;
    expect(hashEvent(reordered)).toBe(e.hash);
    expect(hashEvent({ ...e, hash: "x".repeat(64) })).toBe(e.hash);
  });

  it("survives a JSON round trip (as in exports and jsonb storage)", () => {
    const e = fixedEvent();
    const back = JSON.parse(JSON.stringify(e)) as CanonicalEvent;
    expect(hashEvent(back)).toBe(e.hash);
    expect(canonicalEventSchema.safeParse(back).success).toBe(true);
  });

  it("covers every field", () => {
    const e = fixedEvent();
    const variants: Partial<CanonicalEvent>[] = [
      { tenantId: "other" },
      { seq: 2 },
      { prevHash: "1".repeat(64) },
      { actor: { ...e.actor, login: "mallory" } },
      { correlation: {} },
      { occurredAt: "2026-10-01T10:00:00.124Z" },
      { rawPayload: { id: e.rawPayload!.id, sha256: "2".repeat(64) } },
      { data: { ...e.data, extra: true } },
    ];
    for (const v of variants) expect(hashEvent({ ...e, ...v })).not.toBe(e.hash);
  });
});

describe("verifyChain", () => {
  it("accepts an intact chain and reports its head", async () => {
    const events = await chainOf(5);
    const r = verifyChain(events, { tenantId: "t1" });
    expect(r).toMatchObject({ ok: true, count: 5, lastSeq: 5, lastHash: events[4]!.hash });
    expect(events[0]!.prevHash).toBe(GENESIS_HASH);
  });

  it("accepts an empty chain", () => {
    expect(verifyChain([])).toMatchObject({ ok: true, count: 0, lastSeq: 0 });
  });

  it("detects modification of an event", async () => {
    const events = await chainOf(5);
    events[2] = { ...events[2]!, actor: { type: "user", login: "mallory" } };
    const r = verifyChain(events);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.break).toMatchObject({ kind: "hash_mismatch", index: 2, seq: 3 });
      expect(r.count).toBe(2);
    }
  });

  it("detects modification even when the attacker rehashes the event", async () => {
    const events = await chainOf(5);
    const forged = { ...events[2]!, outcome: "failed" as const };
    events[2] = { ...forged, hash: hashEvent(forged) };
    const r = verifyChain(events);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.break).toMatchObject({ kind: "prev_hash_mismatch", index: 3, seq: 4 });
  });

  it("detects deletion", async () => {
    const events = await chainOf(5);
    events.splice(1, 1);
    const r = verifyChain(events);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.break).toMatchObject({ kind: "seq_gap", index: 1, seq: 3, expected: 2 });
    }
  });

  it("detects deletion with renumbering", async () => {
    const events = await chainOf(4);
    events.splice(1, 1);
    const renumbered = events.map((e, i) => ({ ...e, seq: i + 1 }));
    const r = verifyChain(renumbered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.break).toMatchObject({ kind: "prev_hash_mismatch", index: 1 });
  });

  it("detects reordering", async () => {
    const events = await chainOf(5);
    [events[1], events[3]] = [events[3]!, events[1]!];
    const r = verifyChain(events);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.break).toMatchObject({ kind: "seq_gap", index: 1, seq: 4 });

    // Swapping seq numbers too is caught by the hashes.
    const swapped = (await chainOf(3)).map((e) => ({ ...e }));
    [swapped[0]!.seq, swapped[1]!.seq] = [2, 1];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const r2 = verifyChain(swapped);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.break.index).toBe(0);
  });

  it("detects truncation of the tail only against a trusted head", async () => {
    const events = await chainOf(5);
    const head = { seq: 5, hash: events[4]!.hash };
    expect(verifyChain(events.slice(0, 4)).ok).toBe(true);
    const r = verifyChain(events.slice(0, 4), { expectedHead: head });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.break.kind).toBe("head_mismatch");
  });

  it("detects events from another tenant", async () => {
    const events = await chainOf(2);
    const r = verifyChain(events, { tenantId: "t2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.break.kind).toBe("tenant_mismatch");
  });

  it("verifies a slice from an anchor and incrementally", async () => {
    const events = await chainOf(6);
    const anchor = { seq: 3, hash: events[2]!.hash };
    expect(verifyChain(events.slice(3), { after: anchor })).toMatchObject({ ok: true, count: 3 });
    expect(verifyChain(events.slice(3)).ok).toBe(false);

    const v = new ChainVerifier();
    for (const e of events) expect(v.push(e)).toBeNull();
    expect(v.result()).toMatchObject({ ok: true, count: 6 });
  });
});

describe("memory event sink", () => {
  it("is idempotent per (tenant, source, sourceEventId) and keeps the first", async () => {
    const sink = createMemoryEventSink();
    const first = await sink.ingest("t1", deploymentInput());
    const second = await sink.ingest(
      "t1",
      deploymentInput({ observation: { method: "poll" }, observedAt: "2026-10-02T00:00:00Z" }),
    );
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ inserted: false, event: first.event });
    expect((await sink.ingest("t2", deploymentInput())).inserted).toBe(true);
    expect(sink.events("t1")).toHaveLength(1);
    const raw = sink.rawPayloads.get(first.event.rawPayload!.id)!;
    expect(sha256Hex(raw.body)).toBe(first.event.rawPayload!.sha256);
  });
});
