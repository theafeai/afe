import { readFileSync } from "node:fs";

/**
 * Recorded-shape GitHub webhook deliveries (trimmed, real field names), one
 * per trigger Afe maps. Each file is `{ event, payload }`; `event` is the
 * X-GitHub-Event header. Shapes follow
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads.
 */
export interface WebhookFixture {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export function loadWebhook(name: string): WebhookFixture {
  const url = new URL(`./webhooks/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as WebhookFixture;
}

/** Deep copy with overrides applied by a mutator. */
export function variant(name: string, mutate: (f: WebhookFixture) => void): WebhookFixture {
  const f = loadWebhook(name);
  mutate(f);
  return f;
}
