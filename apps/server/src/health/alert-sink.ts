/**
 * Open-source default `AlertSink` (ADR 0002): logs every alert and, if
 * AFE_ALERT_WEBHOOK_URL is set, POSTs it as JSON. The URL is validated with
 * the outbound URL policy (docs/security/rules.md R6) at startup and the
 * connection re-checks the resolved address (createSafeLookup).
 */
import http from "node:http";
import https from "node:https";
import type { AlertNotification, AlertSink } from "@afe/core";
import { createSafeLookup, validateOutboundUrl, type OutboundUrlPolicy } from "@afe/core/security";

export interface WebhookAlertSinkOptions {
  url: string;
  policy: OutboundUrlPolicy;
  /** Connect + response timeout. Default 10s. */
  timeoutMs?: number;
}

/**
 * Validates the URL (at creation and again before each request) and returns a
 * sink that POSTs alerts to it. Redirects (3xx) are not followed and count as
 * failures; any non-2xx response is a failure (retried by the caller).
 * Response bodies are discarded and never logged (R6.5).
 */
export async function createWebhookAlertSink(options: WebhookAlertSinkOptions): Promise<AlertSink> {
  const url = await validateOutboundUrl(options.url, options.policy);
  const lookup = createSafeLookup(options.policy);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const transport = url.protocol === "https:" ? https : http;
  return {
    async send(alert) {
      // Re-validate before every request: createSafeLookup is not invoked for
      // IP-literal hosts (Node skips DNS for them), and DNS may have changed.
      await validateOutboundUrl(url.href, options.policy);
      const body = Buffer.from(JSON.stringify({ type: "afe.alert", alert }));
      return new Promise<void>((resolve, reject) => {
        const req = transport.request(
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": body.length,
              "user-agent": "afe-alerts",
            },
            lookup: lookup as never,
            timeout: timeoutMs,
          },
          (res) => {
            res.resume();
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve();
            else reject(new Error(`alert webhook responded with HTTP ${status}`));
          },
        );
        req.on("timeout", () => req.destroy(new Error("alert webhook timed out")));
        req.on("error", (err) => reject(new Error(`alert webhook request failed: ${err.message}`)));
        req.end(body);
      });
    },
  };
}

/** Logs alerts at warn (opened) / info (resolved). */
/** The subset of the server logger alerts need. */
export interface AlertLogger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

export function createLogAlertSink(log: AlertLogger): AlertSink {
  return {
    async send(alert) {
      const fields = {
        alertId: alert.alertId,
        tenantId: alert.tenantId,
        connectionId: alert.connectionId,
        source: alert.source,
        kind: alert.kind,
        blindSince: alert.blindSince,
      };
      if (alert.status === "opened") log.warn(fields, `alert opened: ${alert.message}`);
      else log.info(fields, `alert resolved: ${alert.message}`);
    },
  };
}

/** Sends to every sink; fails if any sink fails (after trying all). */
export function combineAlertSinks(...sinks: AlertSink[]): AlertSink {
  return {
    async send(alert) {
      const results = await Promise.allSettled(sinks.map((s) => s.send(alert)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}

export async function createDefaultAlertSink(options: {
  log: AlertLogger;
  webhookUrl: string | null;
  policy: OutboundUrlPolicy;
}): Promise<AlertSink> {
  const logSink = createLogAlertSink(options.log);
  if (!options.webhookUrl) return logSink;
  const webhook = await createWebhookAlertSink({ url: options.webhookUrl, policy: options.policy });
  return combineAlertSinks(logSink, webhook);
}

export type { AlertNotification, AlertSink };
