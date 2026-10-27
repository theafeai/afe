import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeApplication, auditEvent } from "@afe/connector-argocd/testing";
import { parseAgentBatch, parseAgentHeartbeat } from "@afe/connector-argocd/agent-protocol";
import { AfeClient } from "../src/afe-client.ts";
import { ArgoCdAgent, type AgentOptions, type Logger } from "../src/agent.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { KubeClient } from "../src/kube.ts";
import { metricsText } from "../src/main.ts";
import { sanitizeApplication } from "../src/sanitize.ts";
import { FakeAfe, FakeKube, KUBE_TOKEN, waitFor } from "./fakes.ts";

const SECRET = "afeag_test-secret-value-0123456789";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const logs: { level: string; msg: string; fields?: object }[] = [];
const log: Logger = {
  debug: (msg, fields) => logs.push({ level: "debug", msg, fields }),
  info: (msg, fields) => logs.push({ level: "info", msg, fields }),
  warn: (msg, fields) => logs.push({ level: "warn", msg, fields }),
  error: (msg, fields) => logs.push({ level: "error", msg, fields }),
};

function app(name: string, extra: Record<string, unknown> = {}) {
  const a = new FakeApplication({ name, createdAt: "2026-10-01T00:00:00Z" }).snapshot();
  return {
    ...a,
    metadata: {
      ...a.metadata,
      managedFields: [{ manager: "kubectl" }],
      annotations: <Record<string, string>>{
        "kubectl.kubernetes.io/last-applied-configuration": '{"spec":{"helm":"values"}}',
        "argocd.argoproj.io/tracking-id": "parent:argoproj.io/Application:argocd/x",
      },
    },
    status: {
      ...a.status,
      resources: [{ kind: "Secret", name: "x" }],
      conditions: [{ message: "m" }],
    },
    ...extra,
  };
}

describe("ArgoCD agent (fake Kubernetes API and fake Afe)", () => {
  let kube: FakeKube;
  let afe: FakeAfe;
  let agent: ArgoCdAgent;
  let controller: AbortController;
  let running: Promise<void>;
  const agentId = randomUUID();

  async function start(overrides: Partial<AgentOptions> = {}) {
    agent = new ArgoCdAgent({
      agentId,
      kube: new KubeClient({ baseUrl: kube.url, token: () => KUBE_TOKEN }),
      afe: new AfeClient({ baseUrl: afe.url, agentId, secret: () => SECRET }),
      log,
      namespaces: ["argocd"],
      heartbeatIntervalMs: 40,
      backoffMs: () => 20,
      listPageSize: 2,
      ...overrides,
    });
    controller = new AbortController();
    running = agent.run(controller.signal);
  }

  beforeEach(async () => {
    logs.length = 0;
    kube = await new FakeKube().start();
    afe = await new FakeAfe(agentId, SECRET).start();
  });
  afterEach(async () => {
    controller?.abort();
    await kube.close();
    await running?.catch(() => undefined);
    await afe.close();
  });

  const snapshotEnds = () => afe.items().filter((i) => i.kind === "snapshot_end");

  it("sends a full snapshot (paginated), then watch events, signed and well-formed", async () => {
    const a = app("guestbook");
    const b = app("billing");
    const c = app("search");
    for (const x of [a, b, c]) kube.put(x);
    await start();
    await waitFor(() => snapshotEnds().length === 1, "snapshot");
    const snap = afe.items().filter((i) => i.kind === "snapshot");
    expect(snap.map((i) => i.application.metadata.name).sort()).toEqual([
      "billing",
      "guestbook",
      "search",
    ]);
    const end = snapshotEnds()[0]!;
    expect(end.uids.sort()).toEqual([a, b, c].map((x) => x.metadata.uid).sort());
    expect(end.droppedTotalAtStart).toBe(0);
    expect(new Set(snap.map((i) => i.snapshotId))).toEqual(new Set([end.snapshotId]));
    // Paginated list (page size 2), then a watch from the list's resourceVersion.
    expect(kube.requests.filter((r) => r.includes("continue=")).length).toBe(1);
    await waitFor(() => kube.watchFrom.length === 1, "watch");
    expect(kube.watchFrom[0]).toBe(String(kube.rv));

    // Watch: an operation starts; the agent attaches the app's Events.
    kube.events.push({
      ...auditEvent(
        "alice",
        "initiated sync to main (aaaaaaa)",
        "2026-10-27T10:00:00Z",
        "OperationStarted",
      ),
      involvedObject: {
        kind: "Application",
        name: "guestbook",
        namespace: "argocd",
        uid: a.metadata.uid,
      },
    });
    const synced = {
      ...a,
      operation: { sync: { revision: SHA }, initiatedBy: { username: "alice" } },
    };
    kube.emit("MODIFIED", synced);
    await waitFor(() => afe.items().some((i) => i.kind === "watch"), "watch item");
    const w = afe.items().find((i) => i.kind === "watch")!;
    expect(w.type).toBe("MODIFIED");
    expect(w.events).toHaveLength(1);
    expect(w.events[0].message).toBe("alice initiated sync to main (aaaaaaa)");
    // Sanitised: no managed fields, no last-applied copy, no resource list; spec intact.
    expect(w.application.metadata.managedFields).toBeUndefined();
    expect(w.application.metadata.annotations).toEqual({
      "argocd.argoproj.io/tracking-id": "parent:argoproj.io/Application:argocd/x",
    });
    expect(w.application.status.resources).toBeUndefined();
    expect(w.application.status.conditions).toBeUndefined();
    expect(w.application.spec).toEqual(a.spec);

    // An unchanged status-only update does not fetch Events again.
    const eventCalls = kube.requests.filter((r) => r.includes("/events")).length;
    kube.emit("MODIFIED", {
      ...synced,
      status: { ...synced.status, reconciledAt: "2026-10-27T10:05:00Z" },
    });
    await waitFor(() => afe.items().filter((i) => i.kind === "watch").length === 2, "2nd watch");
    expect(kube.requests.filter((r) => r.includes("/events")).length).toBe(eventCalls);

    kube.emit("DELETED", b);
    await waitFor(() => afe.items().some((i) => i.type === "DELETED"), "deleted");

    // Every batch validates against the protocol, sequences increase by one.
    const batches = afe.batches().map((x) => parseAgentBatch(x));
    expect(batches.map((x) => x.sequence)).toEqual(batches.map((_, i) => i + 1));
    expect(new Set(batches.map((x) => x.runId))).toEqual(new Set([agent.runId]));
    expect(afe.badSignatures).toBe(0);
    // Heartbeats validate too.
    await waitFor(() => afe.heartbeats().length >= 2, "heartbeats");
    const hb = parseAgentHeartbeat(afe.heartbeats().at(-1));
    expect(hb).toMatchObject({ agentId, runId: agent.runId, droppedTotal: 0, mode: "kubernetes" });
    expect(hb.kubernetesVersion).toBe("v1.30.2");
    // The secret never appears in what is sent or logged.
    expect(afe.received.map((r) => r.raw).join("")).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(metricsText(agent)).toContain("afe_agent_batches_accepted_total");
  });

  it("lists again when the watch's resourceVersion expires (410)", async () => {
    kube.put(app("guestbook"));
    await start();
    await waitFor(() => kube.watchFrom.length === 1, "watch");
    kube.expire();
    await waitFor(() => snapshotEnds().length === 2, "second snapshot");
    const [s1, s2] = snapshotEnds();
    expect(s1!.snapshotId).not.toBe(s2!.snapshotId);
  });

  it("takes a full snapshot when Afe asks for one in a heartbeat response", async () => {
    kube.put(app("guestbook"));
    let asked = false;
    afe.respond = (r) => {
      if (r.path.endsWith("/heartbeat") && snapshotEnds().length === 1 && !asked) {
        asked = true;
        return [200, { ok: true, resync: true, serverTime: new Date().toISOString() }];
      }
      return undefined;
    };
    await start();
    await waitFor(() => snapshotEnds().length === 2, "requested snapshot");
  });

  it("retries the same batch on 429/5xx (backpressure) and moves on when accepted", async () => {
    kube.put(app("guestbook"));
    let n = 0;
    afe.respond = (r) =>
      r.path.endsWith("/batches") && n++ < 2
        ? [n === 1 ? 429 : 503, { error: "busy" }, { "retry-after": "0" }]
        : undefined;
    await start();
    await waitFor(() => agent.snapshotStats().batchesAccepted === 1, "accepted");
    const ids = afe.batches().map((b) => b.batchId);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(1); // same batch retried
    expect(agent.snapshotStats().droppedTotal).toBe(0);
  });

  it("drops the oldest observations when the buffer is full, reports them and re-lists", async () => {
    const a = app("guestbook");
    kube.put(a);
    let down = false;
    afe.respond = (r) =>
      down && r.path.endsWith("/batches") ? [503, { error: "down" }] : undefined;
    await start({ bufferMaxItems: 4, batchMaxItems: 1 });
    await waitFor(() => kube.watchFrom.length === 1 && snapshotEnds().length === 1, "watching");
    down = true;
    for (let i = 0; i < 12; i++) {
      kube.emit("MODIFIED", {
        ...a,
        status: { ...a.status, reconciledAt: `2026-10-27T10:00:${10 + i}Z` },
      });
    }
    await waitFor(() => agent.snapshotStats().droppedTotal > 0, "drops");
    expect(logs.some((l) => l.msg.startsWith("buffer full"))).toBe(true);
    down = false;
    await waitFor(() => snapshotEnds().length === 2, "re-list after drops");
    const dropped = agent.snapshotStats().droppedTotal;
    await waitFor(() => afe.heartbeats().some((h) => h.droppedTotal === dropped), "reported");
    const later = afe.batches().filter((b) => b.droppedTotal === dropped);
    expect(later.length).toBeGreaterThan(0);
    expect(snapshotEnds()[1]!.droppedTotalAtStart).toBe(dropped);
  });

  it("drops (and counts) a batch Afe rejects as invalid", async () => {
    kube.put(app("guestbook"));
    let rejected = false;
    afe.respond = (r) => {
      if (r.path.endsWith("/batches") && !rejected) {
        rejected = true;
        return [400, { error: "invalid_batch" }];
      }
      return undefined;
    };
    await start();
    await waitFor(() => agent.snapshotStats().droppedTotal > 0, "drop");
    await waitFor(() => snapshotEnds().length >= 1, "new snapshot accepted");
    expect(logs.some((l) => l.level === "error" && l.msg.includes("rejected a batch"))).toBe(true);
  });

  it("continues without attribution when Events are forbidden", async () => {
    kube.forbidEvents = true;
    const a = app("guestbook");
    kube.put(a);
    await start();
    await waitFor(() => kube.watchFrom.length === 1, "watch");
    kube.emit("MODIFIED", { ...a, operation: { sync: { revision: SHA } } });
    await waitFor(() => afe.items().some((i) => i.kind === "watch"), "watch item");
    expect(afe.items().find((i) => i.kind === "watch")!.events).toBeUndefined();
    expect(logs.some((l) => l.msg.includes("without actor attribution"))).toBe(true);
  });
});

describe("sanitizeApplication", () => {
  it("keeps spec and the annotations the mapping reads", () => {
    const a = app("x");
    a.metadata.annotations["argocd.argoproj.io/refresh"] = "hard";
    const s = sanitizeApplication(a);
    expect(s.spec).toEqual(a.spec);
    expect(s.metadata?.annotations).toEqual({
      "argocd.argoproj.io/refresh": "hard",
      "argocd.argoproj.io/tracking-id": "parent:argoproj.io/Application:argocd/x",
    });
  });
});

describe("loadConfig", () => {
  const base = {
    AFE_URL: "https://afe.example.com/",
    AFE_AGENT_ID: "3f6c1a52-0000-4000-8000-000000000000",
    AFE_AGENT_SECRET_FILE: "/run/secret",
    KUBERNETES_SERVICE_HOST: "10.0.0.1",
  };
  const exists = { exists: () => true, read: () => "-----BEGIN CERTIFICATE-----" };

  it("reads the in-cluster defaults", () => {
    const c = loadConfig(base, { exists: (p) => p === "/run/secret", read: () => "" });
    expect(c).toMatchObject({
      afeUrl: "https://afe.example.com",
      kubeUrl: "https://10.0.0.1:443",
      namespaces: ["argocd"],
      attributeWithEvents: true,
      healthPort: 8081,
    });
    expect(loadConfig({ ...base, AFE_AGENT_NAMESPACES: "*" }, exists).namespaces).toBeNull();
  });

  it("rejects unsafe or incomplete settings", () => {
    for (const env of [
      { ...base, AFE_URL: "http://afe.example.com" },
      { ...base, AFE_URL: "https://user:pw@afe.example.com" },
      { ...base, AFE_AGENT_ID: "agent-1" },
      { ...base, AFE_AGENT_SECRET: "x" },
      { ...base, AFE_AGENT_NAMESPACES: "Bad_NS" },
      { ...base, KUBERNETES_SERVICE_HOST: "" },
    ]) {
      expect(() => loadConfig(env, exists)).toThrow(ConfigError);
    }
    expect(
      loadConfig(
        { ...base, AFE_URL: "http://afe:8080", AFE_AGENT_ALLOW_INSECURE_HTTP: "true" },
        exists,
      ).afeUrl,
    ).toBe("http://afe:8080");
  });
});
