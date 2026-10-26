import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AlertNotification } from "@afe/core";
import {
  createDefaultAlertSink,
  createWebhookAlertSink,
  loadHealthConfig,
  parseDuration,
  sanitizeDetail,
} from "../src/index.ts";

const alert: AlertNotification = {
  status: "opened",
  alertId: "a1",
  tenantId: "default",
  kind: "connection_blind",
  connectionId: "c1",
  connectionName: "acme",
  source: "github",
  message: "acme (github) has not been observed",
  openedAt: "2026-10-26T10:00:00.000Z",
  resolvedAt: null,
  gapId: "g1",
  blindSince: "2026-10-26T09:40:00.000Z",
};

describe("alert webhook sink", () => {
  let server: http.Server;
  let url: string;
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let status = 204;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.statusCode = status;
        res.end("internal details");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const lab = { allowPrivateNetworks: true, allowInsecureHttp: true };

  it("POSTs the alert as JSON", async () => {
    const sink = await createWebhookAlertSink({ url, policy: lab });
    await sink.send(alert);
    expect(received.at(-1)!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(received.at(-1)!.body)).toEqual({ type: "afe.alert", alert });
  });

  it("fails on non-2xx without echoing the response body", async () => {
    status = 500;
    const sink = await createWebhookAlertSink({ url, policy: lab });
    await expect(sink.send(alert)).rejects.toThrow(/^alert webhook responded with HTTP 500$/);
    status = 204;
  });

  it("does not follow redirects", async () => {
    status = 302;
    const sink = await createWebhookAlertSink({ url, policy: lab });
    const before = received.length;
    await expect(sink.send(alert)).rejects.toThrow(/HTTP 302/);
    expect(received.length).toBe(before + 1);
    status = 204;
  });

  it("re-validates the URL before every request", async () => {
    const policy = { ...lab };
    const sink = await createWebhookAlertSink({ url, policy });
    policy.allowPrivateNetworks = false;
    await expect(sink.send(alert)).rejects.toThrow(/https|private/);
  });

  it("rejects unsafe URLs at startup (outbound URL rules)", async () => {
    await expect(createWebhookAlertSink({ url, policy: {} })).rejects.toThrow(/https/);
    await expect(
      createWebhookAlertSink({ url: "https://169.254.169.254/latest", policy: {} }),
    ).rejects.toThrow(/disallowed/);
    await expect(
      createDefaultAlertSink({
        log: { warn: () => {}, info: () => {} },
        webhookUrl: "https://user:pw@example.com/",
        policy: {},
      }),
    ).rejects.toThrow(/credentials/);
  });

  it("logs only, when no webhook is configured", async () => {
    const lines: string[] = [];
    const sink = await createDefaultAlertSink({
      log: { warn: (_o: unknown, m: string) => void lines.push(m), info: () => {} },
      webhookUrl: null,
      policy: {},
    });
    await sink.send(alert);
    expect(lines).toEqual([`alert opened: ${alert.message}`]);
  });
});

describe("health config", () => {
  it("parses durations and env", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("250")).toBe(250);
    expect(() => parseDuration("soon")).toThrow();
    const c = loadHealthConfig({ AFE_HEALTH_ALERT_AFTER: "30m" });
    expect(c.alertAfterMs).toBe(1_800_000);
    expect(c.alertWebhookUrl).toBeNull();
  });

  it("sanitises failure details", () => {
    expect(sanitizeDetail("token=abc123 failed")).toBe("token=[REDACTED] failed");
    expect(sanitizeDetail("Authorization: Bearer xyzxyzxyz")).not.toContain("xyzxyzxyz");
    expect(sanitizeDetail("x".repeat(1000))!.length).toBeLessThanOrEqual(500);
    expect(sanitizeDetail("   ")).toBeNull();
  });
});
