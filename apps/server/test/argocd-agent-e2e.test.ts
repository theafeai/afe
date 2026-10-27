/**
 * End to end (AFE-28): the real agent (apps/argocd-agent) against a fake
 * Kubernetes API, sending over HTTP to a real Afe server and database.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvKeyProvider } from "@afe/core/security";
import { createTestPool } from "@afe/db/testing";
import { FakeApplication } from "@afe/connector-argocd/testing";
import { InlineJobQueue, buildAfe, createHealthModule } from "../src/index.ts";
import { createArgoCdAgentModule } from "../src/connectors/argocd-agent.ts";
import { getAgentRow } from "../src/connectors/argocd-agent-state.ts";
import { AfeClient } from "../../argocd-agent/src/afe-client.ts";
import { ArgoCdAgent } from "../../argocd-agent/src/agent.ts";
import { KubeClient } from "../../argocd-agent/src/kube.ts";
import { FakeKube, KUBE_TOKEN } from "../../argocd-agent/test/fakes.ts";
import { tokenMapAuth } from "./helpers/auth.ts";

const SHA1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("ArgoCD agent end to end (agent process -> Afe over HTTP)", () => {
  it("a real agent against a fake Kubernetes API lands deduplicated events in Afe", async () => {
    const pool = await createTestPool();
    const jobs = new InlineJobQueue();
    const built = await buildAfe({
      authProvider: tokenMapAuth({ admin: { tenantId: "default", roles: ["admin"] } }),
      pool,
      logLevel: "silent",
      keys: new EnvKeyProvider({ keys: { default: randomBytes(32) } }),
      jobs,
      connectors: [createArgoCdAgentModule(), createHealthModule({ env: {} })],
    });
    jobs.register(built.jobDefinitions);
    await built.app.listen({ port: 0, host: "127.0.0.1" });
    const address = built.app.server.address() as { port: number };
    const kube = await new FakeKube().start();
    const controller = new AbortController();
    let running: Promise<void> | undefined;
    try {
      const reg = await built.app.inject({
        method: "POST",
        url: "/api/connections/argocd/agents",
        headers: { authorization: "Bearer admin" },
        payload: { instanceId: "e2e" },
      });
      expect(reg.statusCode, reg.body).toBe(201);
      const { agentId, secret } = reg.json() as { agentId: string; secret: string };
      const a = new FakeApplication({ name: "e2e-app", createdAt: "2026-10-01T00:00:00Z" });
      kube.put(a.snapshot());
      const agent = new ArgoCdAgent({
        agentId,
        kube: new KubeClient({ baseUrl: kube.url, token: () => KUBE_TOKEN }),
        afe: new AfeClient({
          baseUrl: `http://127.0.0.1:${address.port}`,
          agentId,
          secret: () => secret,
        }),
        log: { debug() {}, info() {}, warn() {}, error() {} },
        namespaces: ["argocd"],
        heartbeatIntervalMs: 50,
        backoffMs: () => 20,
      });
      running = agent.run(controller.signal);
      const rows = async () =>
        (
          await pool.query<{ action: string; method: string }>(
            `SELECT action, observation->>'method' AS method FROM events
             WHERE connection_id = $1 ORDER BY seq`,
            [agentId],
          )
        ).rows;
      const until = async (cond: () => Promise<boolean>, what: string) => {
        const end = Date.now() + 8000;
        while (!(await cond())) {
          if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
          await jobs.drain();
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      const row = async () => (await getAgentRow(pool, "default", agentId))!;
      await until(async () => (await row()).lastSnapshotCompletedAt !== null, "snapshot");
      await until(async () => kube.watchFrom.length === 1, "watch");

      a.startSync({ at: new Date(Date.now() + 1000).toISOString(), by: "alice", revision: SHA1 });
      kube.emit("MODIFIED", a.snapshot());
      await until(
        async () => (await rows()).some((r) => r.action === "argocd.sync.started"),
        "sync started",
      );
      expect((await rows()).filter((r) => r.action === "argocd.sync.started")).toEqual([
        { action: "argocd.sync.started", method: "stream" },
      ]);

      // A relist (410 Gone) sends the same object again: nothing is duplicated.
      kube.expire();
      await until(async () => agent.snapshotStats().snapshots === 2, "relist");
      await until(
        async () =>
          agent.snapshotStats().buffered === 0 &&
          agent.snapshotStats().inFlight === 0 &&
          (await row()).lastSequence === agent.snapshotStats().lastSequenceAccepted,
        "all processed",
      );
      await jobs.drain();
      expect((await rows()).filter((r) => r.action === "argocd.sync.started")).toHaveLength(1);
      expect((await row()).lastHeartbeatAt).not.toBeNull();
      expect((await row()).awaitingSnapshot).toBe(false);
    } finally {
      controller.abort();
      await kube.close();
      await running?.catch(() => undefined);
      await built.app.close();
      await pool.end();
    }
  });
});
