/**
 * AFE-21: container package publications end to end: signed `registry_package`
 * delivery -> github.webhook job (inline attestation lookup) -> artifact.published,
 * and the github.artifact-provenance follow-up when the attestation is late.
 */
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createMemoryEventSink, type MemoryEventSink } from "@afe/core";
import { EnvKeyProvider, Secret, signHmac } from "@afe/core/security";
import { upsertConnection } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import type { GitHubAppConfig } from "@afe/connector-github";
import {
  fakeGitHub,
  installationFixture,
  json,
  testKeyPair,
} from "../../../packages/connector-github/test/fixtures.ts";
import {
  BUILD_RUN_ID,
  BUILD_SHA,
  DIGEST,
  attestationsResponse,
} from "../../../packages/connector-github/test/fixtures/attestations.ts";
import {
  loadWebhook,
  type WebhookFixture,
} from "../../../packages/connector-github/test/fixtures/webhooks.ts";
import { buildAfe, InlineJobQueue, type AfeApp } from "../src/index.ts";
import { createGitHubModule, GITHUB_JOBS } from "../src/connectors/github.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

const WEBHOOK_SECRET = "whsec-AFE21-TEST-SECRET";
const TOKEN = "ghs_AFE21_INSTALLATION_TOKEN";
const { privatePem } = testKeyPair();
const appConfig: GitHubAppConfig = {
  appId: "77",
  slug: "afe-test",
  privateKey: new Secret(privatePem),
  webhookSecret: new Secret(WEBHOOK_SECRET),
};
const keys = new EnvKeyProvider({ keys: { k1: randomBytes(32) } });
const ALL_PERMS = {
  actions: "read",
  deployments: "read",
  environments: "read",
  metadata: "read",
  packages: "read",
  attestations: "read",
};
const ATTESTATIONS_PATH = `/repos/acme/api/attestations/${DIGEST}`;

describe("GitHub artifacts (AFE-21)", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  let jobs: InlineJobQueue;
  let sink: MemoryEventSink;
  let logLines: string[];
  let deliveries = 0;
  /** Responses of the attestations endpoint, consumed in order (last one repeats). */
  let attestationAnswers: (() => Response | Promise<Response>)[];
  let github: ReturnType<typeof fakeGitHub>;

  beforeAll(async () => {
    pool = await createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  async function start(permissions: Record<string, string> = ALL_PERMS) {
    jobs = new InlineJobQueue();
    sink = createMemoryEventSink();
    logLines = [];
    github = fakeGitHub({
      "POST /app/installations/4242/access_tokens": () =>
        json(201, {
          token: TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions,
        }),
      [`GET ${ATTESTATIONS_PATH}`]: () =>
        (attestationAnswers.length > 1 ? attestationAnswers.shift()! : attestationAnswers[0]!)(),
    });
    afe = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      jobs,
      sink,
      keys,
      logLevel: "debug",
      logStream: new Writable({
        write(chunk, _enc, cb) {
          logLines.push(String(chunk));
          cb();
        },
      }),
      connectors: [
        createGitHubModule({
          app: appConfig,
          http: { fetch: github.fetch, maxRetries: 0, sleep: async () => {} },
          artifacts: { lookupTimeoutMs: 2000, retryDelaysMs: [60_000, 300_000] },
        }),
      ],
    });
    jobs.register(afe.jobDefinitions);
    await upsertConnection(pool, "default", {
      source: "github",
      externalId: "4242",
      name: "acme",
      status: "active",
      config: {
        ...installationFixture({ permissions }),
        installationId: 4242,
        repositories: [{ id: 11, fullName: "acme/api" }],
      } as never,
    });
  }

  beforeEach(async () => {
    await pool.query("DELETE FROM connections; DELETE FROM webhook_deliveries");
    attestationAnswers = [() => json(200, attestationsResponse())];
  });

  afterEach(async () => {
    await afe.app.close();
    const logs = logLines.join("");
    expect(logs).not.toContain(WEBHOOK_SECRET);
    expect(logs).not.toContain(TOKEN);
  });

  function send(f: WebhookFixture, deliveryId = `d-${++deliveries}`) {
    const body = JSON.stringify(f.payload);
    return afe.app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": f.event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": signHmac("sha256", WEBHOOK_SECRET, body, "sha256="),
      },
      payload: body,
    });
  }

  /** Delivers and runs only the webhook job; follow-up jobs stay queued. */
  async function deliver(f: WebhookFixture, deliveryId?: string) {
    const res = await send(f, deliveryId);
    expect(res.statusCode).toBe(202);
    const webhookJobs = jobs.sent.filter((j) => j.name === "github.webhook");
    jobs.sent.splice(0, jobs.sent.length, ...jobs.sent.filter((j) => j.name !== "github.webhook"));
    const handler = afe.jobDefinitions.find((d) => d.name === "github.webhook")!;
    for (const j of webhookJobs) await handler.handler(j.data);
  }

  const followUps = () => jobs.sent.filter((j) => j.name === GITHUB_JOBS.ARTIFACT_PROVENANCE);
  const attestationCalls = () =>
    github.requests.filter((r) => new URL(r.url).pathname === ATTESTATIONS_PATH);

  it("published with attestation: one event with commit and run, no follow-up", async () => {
    await start();
    await deliver(loadWebhook("registry_package.published"));
    const events = sink.events("default");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "artifact.published",
      correlation: {
        imageRefs: [`ghcr.io/acme/api:v1.4.0@${DIGEST}`],
        imageDigests: [DIGEST],
        commitShas: [BUILD_SHA],
        runIds: [`github:${BUILD_RUN_ID}`],
      },
      data: { provenance: { source: "attestation", verification: "unverified" } },
    });
    expect(attestationCalls()).toHaveLength(1);
    expect(attestationCalls()[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Only fixed GitHub hosts are contacted.
    expect(new Set(github.requests.map((r) => new URL(r.url).host))).toEqual(
      new Set(["api.github.com"]),
    );
    expect(followUps()).toHaveLength(0);
  });

  it("attestation not there yet: ingests base facts, then a follow-up records provenance", async () => {
    await start();
    attestationAnswers = [
      () => json(404, { message: "Not Found" }),
      () => json(404, { message: "Not Found" }),
      () => json(200, attestationsResponse()),
    ];
    await deliver(loadWebhook("registry_package.published"));
    const [base] = sink.events("default");
    expect(base).toMatchObject({
      action: "artifact.published",
      data: {
        provenance: { source: "oci_labels" },
        provenanceLookup: { status: "not_found" },
      },
    });
    expect(base!.correlation.runIds).toBeUndefined();
    expect(followUps()).toHaveLength(1);
    expect(followUps()[0]!.options.startAfter).toBeInstanceOf(Date);
    expect(followUps()[0]!.data).toMatchObject({ attempt: 1, artifact: { digest: DIGEST } });

    await jobs.drain(); // attempt 1: 404 -> attempt 2 scheduled; attempt 2: found
    const events = sink.events("default");
    expect(events.map((e) => e.action)).toEqual([
      "artifact.published",
      "artifact.provenance_resolved",
    ]);
    expect(events[1]).toMatchObject({
      sourceEventId: expect.stringMatching(/^artifact_provenance:11:sha256%3A/),
      observation: { method: "poll" },
      correlation: {
        imageDigests: [DIGEST],
        commitShas: [BUILD_SHA],
        runIds: [`github:${BUILD_RUN_ID}`],
      },
    });
    expect(attestationCalls()).toHaveLength(3);
    // The stored artifact event was not changed.
    expect(sink.events("default")[0]).toEqual(base);
  });

  it("attestation fetch failure: base event ingested, bounded retries, then gives up", async () => {
    await start();
    attestationAnswers = [() => json(500, { message: "boom" })];
    await deliver(loadWebhook("registry_package.published"));
    expect(sink.events("default")).toHaveLength(1);
    expect(sink.events("default")[0]!.data).toMatchObject({
      provenanceLookup: { status: "failed", detail: "attestation lookup failed: 500" },
    });
    await jobs.drain();
    expect(sink.events("default")).toHaveLength(1);
    expect(attestationCalls()).toHaveLength(3); // inline + 2 follow-ups
    expect(logLines.join("")).toContain("no provenance found, giving up");
  });

  it("packages permission missing: delivery skipped", async () => {
    const { packages: _p, attestations: _a, ...base } = ALL_PERMS;
    await start(base);
    await deliver(loadWebhook("registry_package.published"));
    expect(sink.events("default")).toHaveLength(0);
    expect(github.requests).toHaveLength(0);
    expect(logLines.join("")).toContain("artifact capture disabled");
  });

  it("attestations permission missing: artifact recorded from labels, no lookup", async () => {
    const { attestations: _a, ...perms } = ALL_PERMS;
    await start(perms);
    await deliver(loadWebhook("registry_package.published"));
    expect(sink.events("default")[0]!.data).toMatchObject({
      provenance: { source: "oci_labels" },
      provenanceLookup: { status: "not_attempted", detail: "attestations permission not granted" },
    });
    expect(github.requests).toHaveLength(0);
    expect(followUps()).toHaveLength(0);
  });

  it("redelivery under a new delivery id is stored once", async () => {
    await start();
    const f = loadWebhook("registry_package.published");
    await deliver(f, "first");
    expect((await send(f, "first")).json()).toMatchObject({ duplicate: true });
    await deliver(f, "second");
    expect(sink.events("default")).toHaveLength(1);
    expect(sink.events("default")[0]!.observation.deliveryId).toBe("first");
  });
});
