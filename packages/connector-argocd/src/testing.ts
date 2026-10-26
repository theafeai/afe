/**
 * A local fake ArgoCD API server for tests (never for production). Serves the
 * read endpoints Afe uses over HTTPS with a test certificate signed by a test
 * CA (`test/fixtures/tls`), and records every request it receives.
 */
import { readFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ArgoCdApplication, ArgoCdApplicationWatchEvent } from "./types.ts";

const FIXTURES = new URL("../test/fixtures/tls/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");

/** The test CA that signed the fake server's certificate. */
export const TEST_CA_PEM = fixture("ca.pem");
/** An unrelated CA: trusting it must not make the fake server trusted. */
export const OTHER_CA_PEM = fixture("other-ca.pem");

export interface FakeAccount {
  username: string;
  /** RBAC decision for `can-i`; defaults to read-only (`get` on applications/projects/clusters). */
  can?: (resource: string, action: string, object: string) => boolean;
}

export const readOnlyPolicy = (resource: string, action: string): boolean =>
  ["applications", "projects", "clusters"].includes(resource) && action === "get";

export interface FakeArgoCdOptions {
  /** Bearer token -> account. */
  accounts: Record<string, FakeAccount>;
  applications?: ArgoCdApplication[];
  version?: string;
  /** Serve plain HTTP instead of HTTPS. */
  insecure?: boolean;
  /** Answer every request with this redirect location. */
  redirectTo?: string;
  /** Respond 404 to can-i (older ArgoCD). */
  noCanI?: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  hasAuthorization: boolean;
}

export interface FakeArgoCd {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Pushes a watch event to every open `/api/v1/stream/applications` stream. */
  emit(event: ArgoCdApplicationWatchEvent): void;
  /** Writes raw bytes to every open stream (for parser tests). */
  emitRaw(text: string): void;
  /** Ends every open stream. */
  endStreams(): void;
  /** Resolves when at least `n` streams are open. */
  waitForStreams(n?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeArgoCd(options: FakeArgoCdOptions): Promise<FakeArgoCd> {
  const requests: RecordedRequest[] = [];
  const streams = new Set<http.ServerResponse>();
  let streamWaiters: { n: number; resolve: () => void }[] = [];
  const apps = options.applications ?? [];

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const auth = req.headers.authorization;
    requests.push({ method: req.method ?? "", path: url.pathname, hasAuthorization: !!auth });
    if (options.redirectTo) {
      res.writeHead(302, { location: options.redirectTo });
      res.end();
      return;
    }
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (url.pathname === "/api/version")
      return json(res, 200, { Version: options.version ?? "v2.13.1+af54ef8" });

    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const account = token !== undefined ? options.accounts[token] : undefined;
    if (!account)
      return json(res, 401, { error: "invalid session", code: 16, message: "invalid session" });
    const can = account.can ?? ((r: string, a: string) => readOnlyPolicy(r, a));

    if (url.pathname === "/api/v1/session/userinfo") {
      return json(res, 200, { loggedIn: true, username: account.username, iss: "argocd" });
    }
    const canI = /^\/api\/v1\/account\/can-i\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (canI) {
      if (options.noCanI) return json(res, 404, { message: "Not Found" });
      const [, resource, action, object] = canI.map((s) => decodeURIComponent(s)) as string[];
      return json(res, 200, { value: can(resource!, action!, object!) ? "yes" : "no" });
    }
    if (!can("applications", "get", "*/*")) return json(res, 403, { message: "permission denied" });
    if (url.pathname === "/api/v1/applications") {
      return json(res, 200, { metadata: { resourceVersion: "100" }, items: apps });
    }
    const one = /^\/api\/v1\/applications\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const app = apps.find((a) => a.metadata?.name === decodeURIComponent(one[1]!));
      return app ? json(res, 200, app) : json(res, 404, { message: "not found" });
    }
    if (url.pathname === "/api/v1/stream/applications") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      streamWaiters = streamWaiters.filter((w) => {
        if (streams.size >= w.n) w.resolve();
        return streams.size < w.n;
      });
      return;
    }
    json(res, 404, { message: "not found" });
  };

  const server = options.insecure
    ? http.createServer(handler)
    : https.createServer({ key: fixture("server-key.pem"), cert: fixture("server.pem") }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `${options.insecure ? "http" : "https"}://127.0.0.1:${port}`,
    port,
    requests,
    emit(event) {
      for (const s of streams) s.write(`data: ${JSON.stringify({ result: event })}\n\n`);
    },
    emitRaw(text) {
      for (const s of streams) s.write(text);
    },
    endStreams() {
      for (const s of streams) s.end();
      streams.clear();
    },
    waitForStreams(n = 1) {
      if (streams.size >= n) return Promise.resolve();
      return new Promise((resolve) => streamWaiters.push({ n, resolve }));
    },
    async close() {
      for (const s of streams) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
