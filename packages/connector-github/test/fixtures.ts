import { generateKeyPairSync } from "node:crypto";

/** A throwaway RSA key in the PKCS#1 PEM form GitHub issues for Apps. */
export function testKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicKey,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response>;

/** A local fake of api.github.com: routes "METHOD /path" to handlers, records requests. */
export function fakeGitHub(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const req: RecordedRequest = {
      method: init.method ?? "GET",
      url,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const handler = routes[`${req.method} ${u.pathname}`];
    if (!handler) return json(404, { message: "Not Found" });
    return handler(req);
  };
  return { fetch, requests };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function installationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 4242,
    app_id: 77,
    app_slug: "afe-test",
    account: { id: 9001, login: "acme", type: "Organization" },
    target_type: "Organization",
    repository_selection: "selected",
    permissions: { actions: "read", deployments: "read", environments: "read", metadata: "read" },
    events: ["deployment", "deployment_status", "workflow_run"],
    created_at: "2026-10-26T10:00:00Z",
    updated_at: "2026-10-26T10:00:00Z",
    suspended_at: null,
    ...overrides,
  };
}
