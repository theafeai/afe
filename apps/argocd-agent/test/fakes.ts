/**
 * Local fakes for agent tests: a Kubernetes API server emulating list/watch
 * of applications.argoproj.io and core/v1 Events, and an Afe endpoint that
 * verifies signatures and records what it receives. No real cluster or Afe.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { verifyAgentSignature } from "@afe/connector-argocd/agent-protocol";
import type { ArgoCdApplication, ArgoCdKubeEvent } from "@afe/connector-argocd";

export const KUBE_TOKEN = "fake-serviceaccount-token";

export class FakeKube {
  server!: http.Server;
  url = "";
  rv = 100;
  apps = new Map<string, ArgoCdApplication>();
  events: ArgoCdKubeEvent[] = [];
  requests: string[] = [];
  watchers = new Set<http.ServerResponse>();
  /** resourceVersions watches were started from. */
  watchFrom: string[] = [];
  forbidEvents = false;

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const w of this.watchers) w.destroy();
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  #withRv(app: ArgoCdApplication): ArgoCdApplication {
    this.rv++;
    return { ...app, metadata: { ...app.metadata, resourceVersion: String(this.rv) } };
  }

  /** Changes an application and notifies watchers. */
  emit(type: "ADDED" | "MODIFIED" | "DELETED", app: ArgoCdApplication): void {
    const a = this.#withRv(app);
    if (type === "DELETED") this.apps.delete(a.metadata!.uid!);
    else this.apps.set(a.metadata!.uid!, a);
    for (const w of this.watchers) w.write(`${JSON.stringify({ type, object: a })}\n`);
  }

  put(app: ArgoCdApplication): void {
    const a = this.#withRv(app);
    this.apps.set(a.metadata!.uid!, a);
  }

  /** Ends every watch with a 410 Gone ERROR frame. */
  expire(): void {
    for (const w of this.watchers) {
      w.end(
        `${JSON.stringify({ type: "ERROR", object: { kind: "Status", code: 410, reason: "Expired" } })}\n`,
      );
    }
    this.watchers.clear();
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.requests.push(`${req.method} ${req.url}`);
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${KUBE_TOKEN}`) {
      res.writeHead(401).end("{}");
      return;
    }
    const u = new URL(req.url!, "http://x");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (u.pathname === "/version") return json({ gitVersion: "v1.30.2" });
    if (u.pathname === "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications") {
      if (u.searchParams.get("watch") === "1") {
        this.watchFrom.push(u.searchParams.get("resourceVersion") ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        this.watchers.add(res);
        res.on("close", () => this.watchers.delete(res));
        return;
      }
      const limit = Number(u.searchParams.get("limit") ?? 500);
      const start = Number(u.searchParams.get("continue") ?? 0);
      const all = [...this.apps.values()];
      const items = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : undefined;
      return json({
        kind: "ApplicationList",
        metadata: { resourceVersion: String(this.rv), ...(next ? { continue: next } : {}) },
        items,
      });
    }
    if (u.pathname === "/api/v1/namespaces/argocd/events") {
      if (this.forbidEvents) {
        res.writeHead(403).end("{}");
        return;
      }
      const sel = u.searchParams.get("fieldSelector") ?? "";
      const uid = /involvedObject\.uid=([^,]+)/.exec(sel)?.[1];
      return json({ items: this.events.filter((e) => e.involvedObject?.uid === uid) });
    }
    res.writeHead(404).end("{}");
  }
}

export interface Received {
  path: string;
  body: Record<string, any>;
  raw: string;
}

export class FakeAfe {
  server!: http.Server;
  url = "";
  received: Received[] = [];
  /** Override responses: return [status, body, headers?] or undefined for the default. */
  respond?: (r: Received) => [number, object, Record<string, string>?] | undefined;
  badSignatures = 0;

  constructor(
    readonly agentId: string,
    readonly secret: string,
  ) {}

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const ok =
          req.headers["x-afe-agent-id"] === this.agentId &&
          verifyAgentSignature({
            secrets: [this.secret],
            timestamp: req.headers["x-afe-timestamp"],
            signature: req.headers["x-afe-signature"],
            body: raw,
          }) === "ok";
        if (!ok) {
          this.badSignatures++;
          res.writeHead(401).end('{"error":"unauthorized"}');
          return;
        }
        const r: Received = { path: req.url!, body: JSON.parse(raw.toString()), raw: raw.toString() };
        this.received.push(r);
        const custom = this.respond?.(r);
        if (custom) {
          res.writeHead(custom[0], { "content-type": "application/json", ...custom[2] });
          res.end(JSON.stringify(custom[1]));
          return;
        }
        if (r.path.endsWith("/heartbeat")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ ok: true, resync: false, serverTime: new Date().toISOString() }),
          );
        } else {
          res.writeHead(202, { "content-type": "application/json" });
          res.end('{"status":"accepted"}');
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  batches(): Record<string, any>[] {
    return this.received.filter((r) => r.path.endsWith("/batches")).map((r) => r.body);
  }
  items(): Record<string, any>[] {
    return this.batches().flatMap((b) => b.items);
  }
  heartbeats(): Record<string, any>[] {
    return this.received.filter((r) => r.path.endsWith("/heartbeat")).map((r) => r.body);
  }
}

export async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
