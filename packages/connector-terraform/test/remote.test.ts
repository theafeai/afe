import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Secret } from "@afe/core/security";
import {
  TerraformApiError,
  TerraformClient,
  operationInput,
  terraformOrigin,
} from "../src/remote.ts";
let server: Server,
  origin: string,
  requests: string[] = [];
const policy = { allowPrivateNetworks: true, allowInsecureHttp: true };
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === "/api/v2/slow") {
      setTimeout(() => res.end("{}"), 150);
      return;
    }
    if (req.url === "/api/v2/redirect") {
      res.writeHead(302, { location: `${origin}/api/v2/target` });
      res.end("secret provider body");
      return;
    }
    if (req.url === "/api/v2/large") {
      res.end("x".repeat(1024));
      return;
    }
    if (req.url === "/api/v2/invalid") {
      res.end("{invalid");
      return;
    }
    if (req.url === "/api/v2/account/details") {
      res.end(JSON.stringify({ data: { id: "team-secret", type: "teams", attributes: {} } }));
      return;
    }
    res.writeHead(500);
    res.end("secret provider body");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
it("limits time and size, rejects malformed responses, and never follows redirects or retries", async () => {
  requests = [];
  const client = new TerraformClient(origin, new Secret("personal-secret"), policy, {
    timeoutMs: 60,
    maxResponseBytes: 128,
  });
  await expect(client.request("/api/v2/slow", "POST")).rejects.toThrow("failed or timed out");
  await expect(client.request("/api/v2/large")).rejects.toThrow();
  await expect(client.request("/api/v2/invalid")).rejects.toThrow("Invalid Terraform response");
  await expect(client.request("/api/v2/redirect", "POST")).rejects.toBeInstanceOf(
    TerraformApiError,
  );
  await expect(client.request("/api/v2/failure", "POST")).rejects.toThrow(
    "Terraform API returned 500",
  );
  expect(requests).toEqual([
    "/api/v2/slow",
    "/api/v2/large",
    "/api/v2/invalid",
    "/api/v2/redirect",
    "/api/v2/failure",
  ]);
});
it("rejects team identities and private endpoints without operator opt-in", async () => {
  const client = new TerraformClient(origin, new Secret("personal-secret"), policy);
  await expect(client.identity()).rejects.toThrow("Invalid Terraform resource identity");
  await expect(
    new TerraformClient(origin, new Secret("personal-secret")).identity(),
  ).rejects.toThrow("https");
});
it("revalidates DNS at connection time and rejects rebound private addresses", async () => {
  let resolutions = 0;
  const client = new TerraformClient("https://terraform.example", new Secret("personal-secret"), {
    resolve: async () => (++resolutions === 1 ? ["1.1.1.1"] : ["127.0.0.1"]),
  });
  await expect(client.identity()).rejects.toThrow("Terraform request failed");
  expect(resolutions).toBe(2);
});
it("accepts only origin URLs and strict typed operation inputs", () => {
  for (const origin of [
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?token=secret",
    "https://example.com/#fragment",
  ])
    expect(() => terraformOrigin(origin)).toThrow();
  expect(terraformOrigin("https://app.terraform.io/")).toBe("https://app.terraform.io");
  for (const input of [
    { action: "terraform.destroy" },
    { action: "terraform.apply", runId: "run-a", confirmed: true },
    { action: "terraform.apply", runId: "../other" },
    { action: "terraform.policy_override", runId: "run-a" },
    { action: "terraform.run", workspaceId: "ws-other" },
  ])
    expect(operationInput.safeParse(input).success).toBe(false);
});
