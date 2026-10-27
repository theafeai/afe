import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentProtocolError,
  agentRequestHeaders,
  generateAgentSecret,
  parseAgentBatch,
  parseAgentHeartbeat,
  signAgentRequest,
  verifyAgentSignature,
} from "../src/agent-protocol.ts";

const SECRET = generateAgentSecret();
const body = Buffer.from('{"hello":"world"}');
const t = 1_800_000_000;

describe("agent request signatures", () => {
  const sig = signAgentRequest(SECRET, String(t), body);
  const check = (o: Partial<Parameters<typeof verifyAgentSignature>[0]>) =>
    verifyAgentSignature({
      secrets: [SECRET],
      timestamp: String(t),
      signature: sig,
      body,
      now: t * 1000,
      ...o,
    });

  it("accepts a valid signature, also with the previous secret during rotation", () => {
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(check({})).toBe("ok");
    expect(check({ secrets: [generateAgentSecret(), SECRET] })).toBe("ok");
  });

  it("binds the timestamp and the exact body", () => {
    expect(check({ body: Buffer.from('{"hello": "world"}') })).toBe("bad_signature");
    expect(check({ timestamp: String(t + 1) })).toBe("bad_signature");
    expect(check({ secrets: [generateAgentSecret()] })).toBe("bad_signature");
    expect(check({ secrets: [""] })).toBe("bad_signature");
  });

  it("rejects malformed headers and skew above 5 minutes", () => {
    expect(check({ signature: undefined })).toBe("malformed");
    expect(check({ signature: [sig, sig] })).toBe("malformed");
    expect(check({ signature: sig.replace("v1=", "sha256=") })).toBe("malformed");
    expect(check({ timestamp: "abc" })).toBe("malformed");
    expect(check({ now: (t + 301) * 1000 })).toBe("stale");
    expect(check({ now: (t - 301) * 1000 })).toBe("stale");
    expect(check({ now: (t + 299) * 1000 })).toBe("ok");
  });

  it("builds headers without the secret", () => {
    const h = agentRequestHeaders(randomUUID(), SECRET, body, new Date(t * 1000));
    expect(JSON.stringify(h)).not.toContain(SECRET);
    expect(h["x-afe-timestamp"]).toBe(String(t));
  });
});

describe("message validation", () => {
  const env = {
    protocol: 1,
    agentId: randomUUID(),
    runId: randomUUID(),
    sentAt: "2026-10-27T10:00:00Z",
    agentVersion: "0.1.0",
    mode: "kubernetes",
    droppedTotal: 0,
  };
  const app = { metadata: { uid: "u1", name: "guestbook" } };

  it("parses batches with every item kind", () => {
    const b = parseAgentBatch({
      ...env,
      batchId: randomUUID(),
      sequence: 1,
      items: [
        { kind: "watch", type: "MODIFIED", observedAt: env.sentAt, application: app },
        { kind: "snapshot", snapshotId: randomUUID(), observedAt: env.sentAt, application: app, events: [] },
        {
          kind: "snapshot_end",
          snapshotId: randomUUID(),
          listedAt: env.sentAt,
          droppedTotalAtStart: 0,
          uids: ["u1"],
        },
      ],
    });
    expect(b.items.map((i) => i.kind)).toEqual(["watch", "snapshot", "snapshot_end"]);
    expect(b.sentAt).toBe("2026-10-27T10:00:00.000Z");
  });

  it("rejects malformed batches with a safe message", () => {
    const bad = [
      { ...env, protocol: 2, batchId: randomUUID(), sequence: 1, items: [] },
      { ...env, batchId: "x", sequence: 1, items: [] },
      { ...env, batchId: randomUUID(), sequence: 0, items: [] },
      { ...env, batchId: randomUUID(), sequence: 1, items: [{ kind: "watch", type: "BOOKMARK" }] },
      { ...env, batchId: randomUUID(), sequence: 1, items: [{ kind: "watch", type: "ADDED", observedAt: env.sentAt, application: {} }] },
      { ...env, batchId: randomUUID(), sequence: 1, items: new Array(1001).fill({}) },
      { ...env, droppedTotal: -1, batchId: randomUUID(), sequence: 1, items: [] },
    ];
    for (const b of bad) expect(() => parseAgentBatch(b)).toThrow(AgentProtocolError);
  });

  it("parses heartbeats", () => {
    const hb = parseAgentHeartbeat({
      ...env,
      heartbeatId: randomUUID(),
      lastSequence: 3,
      buffered: 0,
      watching: true,
      namespaces: ["argocd"],
    });
    expect(hb.namespaces).toEqual(["argocd"]);
    expect(() => parseAgentHeartbeat({ ...env, heartbeatId: randomUUID() })).toThrow(
      AgentProtocolError,
    );
  });
});
