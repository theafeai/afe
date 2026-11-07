import { expect, it, vi } from "vitest";
import { Secret } from "@afe/core/security";
import { VercelActionClient, parseVercelIntent } from "../src/operations.ts";
it.each([429, 500, 307])(
  "never retries or follows redirects for mutation HTTP %s",
  async (status) => {
    const fetch = vi.fn(async () => new Response("private", { status }));
    const c = new VercelActionClient(new Secret("secret"), fetch);
    await expect(c.mutate("DELETE", "/v13/deployments/dpl_1", "team_1")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toHaveLength(2);
  },
);
it("drops returned secret fields, bounds responses and accepts an empty success", async () => {
  const c = new VercelActionClient(new Secret("secret"), async () =>
    Response.json({ id: "dpl_1", env: { SECRET: "private" } }),
  );
  expect(await c.mutate("POST", "/v13/deployments", null)).toEqual({
    status: 200,
    deploymentId: "dpl_1",
  });
  const empty = new VercelActionClient(
    new Secret("secret"),
    async () => new Response(null, { status: 204 }),
  );
  expect((await empty.mutate("DELETE", "/v13/deployments/dpl_1", null)).status).toBe(204);
  const large = new VercelActionClient(
    new Secret("secret"),
    async () => new Response("a".repeat(1024 * 1024 + 1)),
  );
  await expect(large.mutate("POST", "/v13/deployments", null)).rejects.toThrow(
    "Response too large",
  );
});
it("rejects unknown operations, unsafe IDs, arbitrary configuration and environment values", () => {
  for (const b of [
    { action: "vercel.elevate", params: {} },
    { action: "vercel.delete", params: { deploymentId: "../dpl" } },
    { action: "vercel.configure", params: { publicSource: true } },
    { action: "vercel.deploy", params: { ref: "main", target: "preview", env: { SECRET: "x" } } },
  ])
    expect(() => parseVercelIntent(b)).toThrow();
});
