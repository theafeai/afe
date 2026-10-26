import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret, validateOutboundUrl, type OutboundUrlPolicy } from "@afe/core/security";
import {
  ArgoCdClient,
  ArgoCdError,
  createArgoCdClient,
  normaliseServerUrl,
  parseCaBundle,
  InvalidConnectionInputError,
  testArgoCdConnection,
  type ArgoCdApplicationWatchEvent,
  type HttpGet,
} from "../src/index.ts";
import { OTHER_CA_PEM, TEST_CA_PEM, startFakeArgoCd, type FakeArgoCd } from "../src/testing.ts";

const READ_TOKEN = "read-only-token-SECRET";
const ADMIN_TOKEN = "admin-token-SECRET";
const LOGS_TOKEN = "logs-token-SECRET";
const allowPrivate: OutboundUrlPolicy = { allowPrivateNetworks: true };

const apps = [
  { metadata: { name: "guestbook", namespace: "argocd" }, spec: { project: "default" } },
  { metadata: { name: "payments", namespace: "argocd" }, spec: { project: "prod" } },
];

function connect(
  fake: FakeArgoCd,
  token: string,
  opts: { caPem?: string; policy?: OutboundUrlPolicy } = {},
) {
  return createArgoCdClient({
    config: { serverUrl: fake.url, caPem: opts.caPem ?? TEST_CA_PEM },
    token: () => new Secret(token),
    policy: opts.policy ?? allowPrivate,
    retries: 0,
  });
}

describe("ArgoCD client against a fake HTTPS server", () => {
  let fake: FakeArgoCd;
  beforeAll(async () => {
    fake = await startFakeArgoCd({
      applications: apps,
      accounts: {
        [READ_TOKEN]: { username: "afe" },
        [ADMIN_TOKEN]: { username: "admin", can: () => true },
        [LOGS_TOKEN]: {
          username: "afe-logs",
          can: (r, a) => ["applications", "logs"].includes(r) && a === "get",
        },
        // Sync allowed only on concrete prod apps: caught by sampling real apps.
        "prod-sync-token": {
          username: "deployer",
          can: (r, a, o) =>
            r === "applications" && (a === "get" || (a === "sync" && o.startsWith("prod/"))),
        },
      },
    });
  });
  afterAll(async () => {
    await fake.close();
  });

  it("connects with a read-only token and verifies it", async () => {
    const { client, close } = connect(fake, READ_TOKEN);
    try {
      const result = await testArgoCdConnection(client);
      expect(result).toMatchObject({
        version: "v2.13.1+af54ef8",
        username: "afe",
        applicationCount: 2,
        readOnly: { status: "verified", writeCapabilities: [], sensitiveReadCapabilities: [] },
        warnings: [],
      });
      expect(result.readOnly.objectsChecked).toEqual([
        "*",
        "*/*",
        "default/guestbook",
        "prod/payments",
      ]);
      const app = await client.getApplication("guestbook");
      expect(app.metadata?.name).toBe("guestbook");
    } finally {
      await close();
    }
  });

  it("only ever issues GET requests, each with a bearer token", async () => {
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(new Set(fake.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(fake.requests.every((r) => r.hasAuthorization)).toBe(true);
  });

  it("rejects a bad token as unauthorized", async () => {
    const { client, close } = connect(fake, "wrong-token");
    try {
      const err = await testArgoCdConnection(client).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ArgoCdError);
      expect((err as ArgoCdError).kind).toBe("unauthorized");
      expect(String((err as Error).message)).not.toContain("wrong-token");
    } finally {
      await close();
    }
  });

  it("flags a sync-capable (admin) token", async () => {
    const { client, close } = connect(fake, ADMIN_TOKEN);
    try {
      const result = await testArgoCdConnection(client);
      expect(result.readOnly.status).toBe("write_capable");
      expect(result.readOnly.writeCapabilities).toContain("applications/sync on *");
      expect(result.readOnly.writeCapabilities).toContain("exec/create on *");
    } finally {
      await close();
    }
  });

  it("flags sync rights limited to concrete applications", async () => {
    const { client, close } = connect(fake, "prod-sync-token");
    try {
      const result = await testArgoCdConnection(client);
      expect(result.readOnly.status).toBe("write_capable");
      expect(result.readOnly.writeCapabilities).toEqual(["applications/sync on prod/payments"]);
    } finally {
      await close();
    }
  });

  it("warns about log access", async () => {
    const { client, close } = connect(fake, LOGS_TOKEN);
    try {
      const result = await testArgoCdConnection(client);
      expect(result.readOnly.status).toBe("verified");
      expect(result.warnings.join(" ")).toContain("logs/get");
    } finally {
      await close();
    }
  });

  it("rejects the self-signed/private-CA certificate without a CA, and with the wrong CA", async () => {
    for (const caPem of [undefined, OTHER_CA_PEM]) {
      const handle = createArgoCdClient({
        config: { serverUrl: fake.url, caPem },
        token: () => new Secret(READ_TOKEN),
        policy: allowPrivate,
        retries: 0,
      });
      try {
        const err = await handle.client.getVersion().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ArgoCdError);
        expect((err as ArgoCdError).kind).toBe("tls");
      } finally {
        await handle.close();
      }
    }
  });

  it("accepts the certificate when the connection's CA is configured", async () => {
    const { client, close } = connect(fake, READ_TOKEN, { caPem: TEST_CA_PEM });
    try {
      expect((await client.getVersion()).Version).toBe("v2.13.1+af54ef8");
    } finally {
      await close();
    }
  });

  it("blocks private addresses unless allowed, at validation and at connect time", async () => {
    await expect(validateOutboundUrl(fake.url, {})).rejects.toThrow(/private/);
    await expect(validateOutboundUrl(fake.url, allowPrivate)).resolves.toBeInstanceOf(URL);
    const before = fake.requests.length;
    const { client, close } = connect(fake, READ_TOKEN, { policy: {} });
    try {
      const err = await client.getVersion().catch((e: unknown) => e);
      expect((err as ArgoCdError).kind).toBe("unsafe_address");
      expect(fake.requests.length).toBe(before);
    } finally {
      await close();
    }
  });

  it("parses the application watch stream (SSE)", async () => {
    const { client, close } = connect(fake, READ_TOKEN);
    const ac = new AbortController();
    try {
      const received: ArgoCdApplicationWatchEvent[] = [];
      const done = (async () => {
        for await (const ev of client.watchApplications({
          projects: ["default"],
          signal: ac.signal,
        })) {
          received.push(ev);
        }
      })();
      await fake.waitForStreams(1);
      fake.emit({ type: "ADDED", application: apps[0]! });
      fake.emitRaw(": keepalive\n\n");
      fake.emitRaw(
        `data: ${JSON.stringify({ result: { type: "MODIFIED", application: apps[1] } }).slice(0, 20)}`,
      );
      fake.emitRaw(
        `${JSON.stringify({ result: { type: "MODIFIED", application: apps[1] } }).slice(20)}\n\n`,
      );
      fake.endStreams();
      await done;
      expect(received.map((e) => [e.type, e.application.metadata?.name])).toEqual([
        ["ADDED", "guestbook"],
        ["MODIFIED", "payments"],
      ]);
      expect(fake.requests.at(-1)?.path).toBe("/api/v1/stream/applications");
    } finally {
      ac.abort();
      await close();
    }
  });
});

describe("ArgoCD client behaviour (injected transport)", () => {
  const response = (status: number, body: string, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    body: (async function* () {
      yield new TextEncoder().encode(body);
    })(),
  });

  it("does not follow redirects", async () => {
    const fake = await startFakeArgoCd({ accounts: {}, redirectTo: "https://evil.example/" });
    const { client, close } = createArgoCdClient({
      config: { serverUrl: fake.url, caPem: TEST_CA_PEM },
      token: () => new Secret("t"),
      policy: allowPrivate,
      retries: 0,
    });
    try {
      const err = await client.getVersion().catch((e: unknown) => e);
      expect((err as ArgoCdError).kind).toBe("unexpected_status");
      expect((err as ArgoCdError).status).toBe(302);
      expect(fake.requests).toHaveLength(1);
    } finally {
      await close();
      await fake.close();
    }
  });

  it("retries 5xx with backoff, reads the token at use time and limits response size", async () => {
    let calls = 0;
    const tokens: string[] = [];
    const get: HttpGet = async (_url, init) => {
      calls++;
      tokens.push(init.headers.authorization!);
      return calls === 1 ? response(503, "") : response(200, JSON.stringify({ Version: "v3.0.0" }));
    };
    let current = "first";
    const client = new ArgoCdClient({
      serverUrl: "https://argocd.example.com",
      token: () => new Secret(current),
      get,
      sleep: async () => {
        current = "rotated";
      },
    });
    expect((await client.getVersion()).Version).toBe("v3.0.0");
    expect(tokens).toEqual(["Bearer first", "Bearer rotated"]);

    const big = new ArgoCdClient({
      serverUrl: "https://argocd.example.com",
      token: () => new Secret("t"),
      get: async () => response(200, "x".repeat(2000)),
      maxResponseBytes: 1000,
    });
    await expect(big.getVersion()).rejects.toMatchObject({ kind: "too_large" });
  });

  it("reports stream error frames", async () => {
    const client = new ArgoCdClient({
      serverUrl: "https://argocd.example.com",
      token: () => new Secret("t"),
      get: async () =>
        response(200, 'data: {"error":{"http_code":403,"message":"permission denied"}}\n\n', {
          "content-type": "text/event-stream",
        }),
    });
    const iterate = async () => {
      for await (const _ of client.watchApplications()) void _;
    };
    await expect(iterate()).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("treats an unavailable can-i as 'unavailable', not as a failure", async () => {
    const fake = await startFakeArgoCd({ accounts: { t: { username: "afe" } }, noCanI: true });
    const { client, close } = createArgoCdClient({
      config: { serverUrl: fake.url, caPem: TEST_CA_PEM },
      token: () => new Secret("t"),
      policy: allowPrivate,
      retries: 0,
    });
    try {
      const result = await testArgoCdConnection(client);
      expect(result.readOnly.status).toBe("unavailable");
      expect(result.warnings.join(" ")).toContain("could not verify");
    } finally {
      await close();
      await fake.close();
    }
  });
});

describe("connection input", () => {
  it("normalises server URLs into a stable external id", () => {
    expect(normaliseServerUrl("HTTPS://ArgoCD.Example.com:443/")).toBe(
      "https://argocd.example.com",
    );
    expect(normaliseServerUrl("https://argocd.example.com/argocd/applications")).toBe(
      "https://argocd.example.com/argocd",
    );
    expect(normaliseServerUrl("https://argocd.example.com:8443/api/v1")).toBe(
      "https://argocd.example.com:8443",
    );
    expect(() => normaliseServerUrl("https://u:p@argocd.example.com")).toThrow(
      InvalidConnectionInputError,
    );
    expect(() => normaliseServerUrl("ftp://argocd.example.com")).toThrow(
      InvalidConnectionInputError,
    );
  });

  it("validates CA bundles and refuses private keys", () => {
    expect(parseCaBundle(TEST_CA_PEM)).toContain("BEGIN CERTIFICATE");
    expect(() => parseCaBundle("not a cert")).toThrow(InvalidConnectionInputError);
    expect(() =>
      parseCaBundle(
        `${TEST_CA_PEM}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`,
      ),
    ).toThrow(/private key/);
  });
});
