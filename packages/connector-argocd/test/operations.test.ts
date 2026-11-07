import https from "node:https";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Secret } from "@afe/core/security";
import { createArgoCdActionClient, type ArgoCdActionClient } from "../src/operations.ts";
import { parseArgoCdOperation } from "@afe/core";
import { TEST_CA_PEM, OTHER_CA_PEM } from "../src/testing.ts";
let server: https.Server | undefined, client: ArgoCdActionClient | undefined;
beforeEach(() => {
  server = undefined;
  client = undefined;
});
afterEach(async () => {
  await client?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});
async function start(status = 200, caPem = TEST_CA_PEM, policy = { allowPrivateNetworks: true }) {
  let requests = 0;
  server = https.createServer(
    {
      cert: readFileSync(new URL("./fixtures/tls/server.pem", import.meta.url)),
      key: readFileSync(new URL("./fixtures/tls/server-key.pem", import.meta.url)),
    },
    (_req, res) => {
      requests++;
      res.writeHead(status, {
        "content-type": "application/json",
        ...(status === 302 ? { location: "https://forbidden.invalid/steal" } : {}),
      });
      res.end(status >= 400 ? '{"secret":"upstream-secret"}' : "{}");
    },
  );
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  client = createArgoCdActionClient({
    config: { serverUrl: `https://localhost:${(server.address() as AddressInfo).port}`, caPem },
    policy,
    token: () => new Secret("personal-secret"),
  });
  return () => requests;
}
it("supports a private CA for explicit action requests", async () => {
  const count = await start();
  await client!.request("/api/v1/applications/web/sync", "POST", { prune: false });
  expect(count()).toBe(1);
});
it("verifies TLS instead of trusting an unrelated CA", async () => {
  await start(200, OTHER_CA_PEM);
  await expect(client!.request("/api/v1/applications/web/sync", "POST", {})).rejects.toMatchObject({
    kind: "tls",
  });
});
it("rejects private addresses unless opted in", async () => {
  await start(200, TEST_CA_PEM, { allowPrivateNetworks: false });
  await expect(client!.request("/api/v1/applications/web/sync", "POST", {})).rejects.toThrow();
});
it.each([302, 429, 500])("does not follow redirects or retry action status %s", async (status) => {
  const count = await start(status);
  let error: unknown;
  try {
    await client!.request("/api/v1/applications/web/sync", "POST", {});
  } catch (e) {
    error = e;
  }
  expect(error).toMatchObject({ status });
  expect(String(error)).not.toMatch(/personal-secret|upstream-secret/);
  expect(count()).toBe(1);
});
it("rejects arbitrary patches, manifests, invalid resource identities and conflicting revisions", () => {
  for (const [action, params] of [
    ["argocd.sync", { manifests: ["secret"] }],
    ["argocd.sync_policy", { patch: "arbitrary" }],
    ["argocd.sync", { revision: "a", revisions: ["b"] }],
    [
      "argocd.resource_action",
      {
        resource: { group: "apps", kind: "Deployment", namespace: "prod", name: "../outside" },
        name: "restart",
      },
    ],
  ])
    expect(() => parseArgoCdOperation(action, params)).toThrow();
});
