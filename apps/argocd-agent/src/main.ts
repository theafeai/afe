#!/usr/bin/env node
/**
 * Entry point of the in-cluster ArgoCD agent container (AFE-28).
 * Configuration: environment variables, see src/config.ts and
 * docs/connectors/argocd.md "In-cluster agent".
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { AfeClient } from "./afe-client.ts";
import { ArgoCdAgent, type Logger } from "./agent.ts";
import { ConfigError, loadConfig, type AgentConfig } from "./config.ts";
import { KubeClient, fileToken } from "./kube.ts";
import { AGENT_VERSION } from "./version.ts";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/** JSON-lines logger on stdout. Callers never pass secrets. */
export function createLogger(level: AgentConfig["logLevel"]): Logger {
  const min = LEVELS[level];
  const write = (l: keyof typeof LEVELS) => (msg: string, fields?: object) => {
    if (LEVELS[l] < min) return;
    process.stdout.write(
      `${JSON.stringify({ time: new Date().toISOString(), level: l, msg, ...fields })}\n`,
    );
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

/** Prometheus text exposition of the agent's counters. */
export function metricsText(agent: ArgoCdAgent): string {
  const s = agent.snapshotStats();
  const lines = [
    ["afe_agent_buffered_items", "gauge", "Observations waiting to be sent", s.buffered],
    ["afe_agent_inflight_items", "gauge", "Observations in the batch being sent", s.inFlight],
    ["afe_agent_dropped_total", "counter", "Observations dropped (buffer full or batch rejected)", s.droppedTotal],
    ["afe_agent_batches_accepted_total", "counter", "Batches accepted by Afe", s.batchesAccepted],
    ["afe_agent_snapshots_total", "counter", "Full snapshots taken", s.snapshots],
    ["afe_agent_watch_events_total", "counter", "Watch events received", s.watchEvents],
    ["afe_agent_heartbeats_ok_total", "counter", "Heartbeats accepted by Afe", s.heartbeatsOk],
    ["afe_agent_heartbeats_failed_total", "counter", "Heartbeats that failed", s.heartbeatsFailed],
    ["afe_agent_watching", "gauge", "1 while the watch is open", s.watching ? 1 : 0],
  ] as const;
  return lines
    .map(([n, t, h, v]) => `# HELP ${n} ${h}\n# TYPE ${n} ${t}\n${n} ${v}`)
    .join("\n")
    .concat("\n");
}

async function main(): Promise<void> {
  let config: AgentConfig;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`afe-argocd-agent: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const log = createLogger(config.logLevel);
  const secretFile = config.secretFile;
  const secret = secretFile
    ? async () => (await readFile(secretFile, "utf8")).trim()
    : () => config.secret!;
  const agent = new ArgoCdAgent({
    agentId: config.agentId,
    kube: new KubeClient({
      baseUrl: config.kubeUrl,
      token: fileToken(config.kubeTokenFile),
      ...(config.kubeCa ? { ca: config.kubeCa } : {}),
    }),
    afe: new AfeClient({
      baseUrl: config.afeUrl,
      agentId: config.agentId,
      secret,
      ...(config.afeCa ? { ca: config.afeCa } : {}),
    }),
    log,
    namespaces: config.namespaces,
    attributeWithEvents: config.attributeWithEvents,
    bufferMaxItems: config.bufferMaxItems,
    bufferMaxBytes: config.bufferMaxBytes,
    batchMaxItems: config.batchMaxItems,
    batchMaxBytes: config.batchMaxBytes,
    listPageSize: config.listPageSize,
    watchTimeoutSeconds: config.watchTimeoutSeconds,
  });

  const controller = new AbortController();
  let server: http.Server | undefined;
  if (config.healthPort) {
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      } else if (req.method === "GET" && req.url === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(metricsText(agent));
      } else {
        res.writeHead(404).end();
      }
    });
    server.listen(config.healthPort, "0.0.0.0");
  }
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      log.info("shutting down", { signal: sig });
      controller.abort();
      server?.close();
    });
  }
  log.info("afe-argocd-agent starting", {
    version: AGENT_VERSION,
    runId: agent.runId,
    agentId: config.agentId,
    afeUrl: config.afeUrl,
    namespaces: config.namespaces ?? "*",
    attributeWithEvents: config.attributeWithEvents,
  });
  await agent.run(controller.signal);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((e: unknown) => {
    console.error(`afe-argocd-agent: fatal: ${e instanceof Error ? e.message : "error"}`);
    process.exit(1);
  });
}
