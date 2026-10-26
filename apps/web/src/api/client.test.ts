import { afterEach, describe, expect, it } from "vitest";
import { ApiError, api, request, setFetch } from "./client.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => setFetch((input, init) => fetch(input, init)));

describe("API client", () => {
  it("returns parsed JSON and sends filters as query parameters", async () => {
    let url = "";
    setFetch(async (u) => {
      url = u;
      return json(200, { items: [], nextCursor: null, snapshotSeq: 0 });
    });
    const page = await api.events(new URLSearchParams("source=github&limit=50"));
    expect(page.items).toEqual([]);
    expect(url).toBe("/api/events?source=github&limit=50");
  });

  it("uses the API's message for 400s", async () => {
    setFetch(async () =>
      json(400, { error: "bad_request", message: 'unknown query parameter "x"' }),
    );
    const err = await api.events(new URLSearchParams()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: "bad_request",
      message: 'unknown query parameter "x"',
    });
  });

  it("maps error codes without a message to readable text and keeps the body", async () => {
    setFetch(async () =>
      json(422, { error: "token_not_read_only", writeCapabilities: ["applications/sync on */*"] }),
    );
    const err = (await request("POST", "/api/connections/argocd", {}).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(err.message).toMatch(/can modify ArgoCD/);
    expect(err.body?.writeCapabilities).toEqual(["applications/sync on */*"]);

    setFetch(async () => json(409, { error: "connection_revoked" }));
    const revoked = (await api.vercelProjects("x").catch((e: unknown) => e)) as ApiError;
    expect(revoked.message).toMatch(/revoked/);
  });

  it("uses sentence-like `error` strings as the message (health/github routes)", async () => {
    setFetch(async () => json(404, { error: "connection not found" }));
    const err = (await api.connectionHealth("x").catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe("connection not found");
  });

  it("handles non-JSON error bodies and server failures", async () => {
    setFetch(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = (await api.connections().catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 502, code: "http_502" });
    expect(err.message).toMatch(/server failed/);
  });

  it("reports network failures with status 0", async () => {
    setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = (await api.connections().catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 0, code: "network_error" });
  });

  it("rejects a 200 that is not JSON (e.g. the SPA fallback answering an API path)", async () => {
    setFetch(async () => new Response("<!doctype html>", { status: 200 }));
    const err = (await api.connections().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("invalid_response");
  });

  it("builds export URLs with the current filters", () => {
    expect(api.exportUrl(new URLSearchParams("source=argocd"), "csv")).toBe(
      "/api/export?source=argocd&format=csv",
    );
  });
});
