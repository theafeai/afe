import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  anchorFileName,
  buildFakeTimeStampResponse,
  createEd25519ExportSigner,
  generateExportSigningKey,
  hashEvent,
  parseTimeStampRequest,
  type CanonicalEvent,
  type CanonicalEventInputLike,
} from "@afe/core";
import { ingestEvent, listEvents, verifyTenantChain } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import {
  buildAfe,
  createAnchorModule,
  createEventsApiModule,
  InlineJobQueue,
  intervalToCron,
  loadAnchorConfig,
  loadConfig,
  ANCHOR_JOBS,
} from "../src/index.ts";
import { runVerifyExport } from "../src/verify-export-cli.ts";
import { trustedTestAuth } from "./helpers/auth.ts";

function ev(n: number): CanonicalEventInputLike {
  return {
    source: "github",
    sourceEventId: `e:${n}`,
    action: "deployment.created",
    actor: { type: "user", id: "1", login: "octocat" },
    target: { type: "environment", id: "acme/api:production", environment: "production" },
    trigger: { type: "manual" },
    outcome: "succeeded",
    occurredAt: new Date(Date.UTC(2026, 9, 1, 10, n)),
    observedAt: new Date(Date.UTC(2026, 9, 1, 10, n, 30)),
    observation: { method: "webhook" },
    correlation: {},
  };
}

/** The attack: a superuser disables triggers and rewrites the whole chain consistently. */
async function rewriteChain(pool: pg.Pool, tenantId: string, login: string) {
  const { events } = await listEvents(pool, tenantId, { limit: 1000 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    let prev = "0".repeat(64);
    let last: CanonicalEvent | null = null;
    for (const e of events) {
      const changed: CanonicalEvent = { ...e, actor: { ...e.actor, login }, prevHash: prev };
      changed.hash = hashEvent(changed);
      await client.query("UPDATE events SET actor = $2, prev_hash = $3, hash = $4 WHERE id = $1", [
        e.id,
        JSON.stringify(changed.actor),
        changed.prevHash,
        changed.hash,
      ]);
      prev = changed.hash;
      last = changed;
    }
    await client.query("UPDATE event_chain_heads SET hash = $2 WHERE tenant_id = $1", [
      tenantId,
      last!.hash,
    ]);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

describe("chain anchoring", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let dir: string;
  let tsa: Server;
  let tsaCalls = 0;
  const queue = new InlineJobQueue();
  const key = generateExportSigningKey();
  const file = () => path.join(dir, anchorFileName("default"));

  beforeAll(async () => {
    pool = await createTestPool();
    dir = await mkdtemp(path.join(tmpdir(), "afe-anchor-srv-"));
    tsa = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        tsaCalls += 1;
        const { digest, nonce } = parseTimeStampRequest(Buffer.concat(chunks));
        res
          .writeHead(200, { "content-type": "application/timestamp-reply" })
          .end(buildFakeTimeStampResponse({ digest, nonce }));
      });
    });
    await new Promise<void>((r) => tsa.listen(0, "127.0.0.1", r));
    const tsaUrl = `http://127.0.0.1:${(tsa.address() as AddressInfo).port}/tsr`;

    for (let i = 1; i <= 3; i++) await ingestEvent(pool, "default", ev(i));
    const built = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      jobs: queue,
      config: loadConfig({
        DATABASE_URL: "unused",
        AFE_ALLOW_PRIVATE_NETWORK_TARGETS: "true",
        AFE_ALLOW_INSECURE_HTTP_TARGETS: "true",
      }),
      connectors: [
        createEventsApiModule({ signer: createEd25519ExportSigner(key.privateKey) }),
        createAnchorModule({
          env: {
            AFE_ANCHOR_DIR: dir,
            AFE_ANCHOR_TSA_URL: tsaUrl,
            AFE_EXPORT_SIGNING_KEY: key.privateKey,
          },
        }),
      ],
    });
    app = built.app;
    queue.register(built.jobDefinitions);
    expect(built.jobDefinitions.find((j) => j.name === ANCHOR_JOBS.PUBLISH)?.schedule).toBe(
      "0 * * * *",
    );
  });
  afterAll(async () => {
    await app.close();
    tsa.close();
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  const get = (url: string) => app.inject({ method: "GET", url });
  const runJob = async () => {
    await queue.send(ANCHOR_JOBS.PUBLISH, {});
    await queue.drain();
  };
  const lines = async () => (await readFile(file(), "utf8")).trim().split("\n");

  it("anchors the head on schedule, only when it moved", async () => {
    await runJob();
    expect(await lines()).toHaveLength(1);
    const first = JSON.parse((await lines())[0]!);
    expect(first.checkpoint).toMatchObject({ tenantId: "default", seq: 3 });
    expect(first.timestamp.kind).toBe("rfc3161"); // TSA token stored in the file line
    await runJob();
    expect(await lines()).toHaveLength(1);
    expect(tsaCalls).toBe(1);
    await ingestEvent(pool, "default", ev(4));
    await runJob();
    expect(await lines()).toHaveLength(2);

    const listed = (await get("/api/audit/anchors")).json();
    expect(listed.configured).toBe(true);
    expect(listed.anchors).toEqual(["rfc3161", "file"]);
    expect(listed.receipts).toHaveLength(4); // 2 checkpoints x (TSA + file)
  });

  it("reports anchor status in /api/audit/verify", async () => {
    const res = (await get("/api/audit/verify")).json();
    expect(res.ok).toBe(true);
    expect(res.anchors).toMatchObject({ ok: true, externalSourceChecked: true, configured: true });
    expect(res.anchors.latest).toMatchObject({
      seq: 4,
      status: "match",
      signature: "valid_trusted",
      timestamp: "imprint_ok",
      stale: false,
    });
    expect(res.anchors.latest.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(res.anchors.lastRun.lastError).toBeNull();
  });

  it("embeds the latest receipt in exports, which verify against the anchor file", async () => {
    await ingestEvent(pool, "default", ev(5));
    const body = (await get("/api/export?format=json")).body;
    const manifest = JSON.parse(body.trim().split("\n").at(-1)!).manifest;
    expect(manifest.anchors.map((a: { checkpoint: { seq: number } }) => a.checkpoint.seq)).toEqual([
      5, 5,
    ]); // anchored at export time
    expect(await lines()).toHaveLength(3);

    let out = "";
    const files: Record<string, string> = {
      "export.jsonl": body,
      "anchors.jsonl": await readFile(file(), "utf8"),
      "empty.jsonl": "",
    };
    const io = {
      readFile: async (p: string) => new TextEncoder().encode(files[p]!),
      out: (t: string) => void (out += t),
    };
    expect(
      await runVerifyExport(
        [
          "export.jsonl",
          "--anchors",
          "anchors.jsonl",
          "--public-key",
          key.publicKey,
          "--require-anchor",
        ],
        io,
      ),
    ).toBe(0);
    expect(out).toMatch(/anchored: {15}yes/);
    expect(out).toMatch(/anchors: 5 of 5 confirmed/);
    files["export.jsonl"] = body.replace(
      /,"anchors":\[.*\],"canonicalization"/,
      ',"canonicalization"',
    );
    out = "";
    // Missing anchors: nothing to confirm (and the edited manifest no longer verifies).
    expect(
      await runVerifyExport(["export.jsonl", "--anchors", "empty.jsonl", "--require-anchor"], io),
    ).toBe(1);
    expect(out).toMatch(/anchor_missing/);
  });

  it("detects a consistent rewrite of the whole chain that plain verification misses", async () => {
    const before = await readFile(file(), "utf8");
    await rewriteChain(pool, "default", "mallory");

    // Plain chain verification passes: the rewrite is internally consistent.
    expect((await verifyTenantChain(pool, "default")).ok).toBe(true);

    const res = (await get("/api/audit/verify")).json();
    expect(res.verification.ok).toBe(true);
    expect(res.anchors.ok).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.anchors.errors.map((e: { code: string }) => e.code)).toContain("anchor_mismatch");

    // The job refuses to anchor the rewritten chain; the anchor file is untouched.
    await ingestEvent(pool, "default", ev(6));
    await runJob();
    expect(await readFile(file(), "utf8")).toBe(before);
    const verify = (await get("/api/audit/verify")).json();
    expect(verify.anchors.lastRun.lastError).toMatch(/no longer matches the live chain/);

    // An export of the rewritten chain fails against the anchor file.
    const body = (await get("/api/export?format=json")).body;
    let out = "";
    const io = {
      readFile: async (p: string) => new TextEncoder().encode(p === "x.jsonl" ? body : before),
      out: (t: string) => void (out += t),
    };
    expect(await runVerifyExport(["x.jsonl", "--anchors", "a.jsonl"], io)).toBe(1);
    expect(out).toMatch(/anchor_mismatch/);

    // Auditor-supplied receipts via the API.
    const supplied = await app.inject({
      method: "POST",
      url: "/api/audit/anchors/verify",
      payload: { text: before },
    });
    expect(supplied.json().ok).toBe(false);
  });
});

describe("anchor configuration", () => {
  it("converts intervals to cron schedules", () => {
    expect(intervalToCron("1h").schedule).toBe("0 * * * *");
    expect(intervalToCron("15m").schedule).toBe("*/15 * * * *");
    expect(intervalToCron("6h").schedule).toBe("0 */6 * * *");
    expect(intervalToCron("1d").schedule).toBe("0 0 * * *");
    expect(intervalToCron("5 4 * * *").schedule).toBe("5 4 * * *");
    expect(() => intervalToCron("90s")).toThrow(/AFE_ANCHOR_INTERVAL/);
    expect(loadAnchorConfig({}).dir).toBeNull();
    expect(
      loadAnchorConfig({ AFE_ANCHOR_SIGNING_KEY: "a", AFE_EXPORT_SIGNING_KEY: "b" }).signingKey,
    ).toBe("a");
  });

  it("requires a signing key when an anchor is configured, and is inactive by default", async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    await expect(
      buildAfe({
        authProvider: trustedTestAuth(),
        pool,
        logLevel: "silent",
        connectors: [createAnchorModule({ env: { AFE_ANCHOR_DIR: "/tmp/x" } })],
      }),
    ).rejects.toThrow(/signing key/);
    const { jobDefinitions, app } = await buildAfe({
      authProvider: trustedTestAuth(),
      pool,
      logLevel: "silent",
      connectors: [createAnchorModule({ env: {} })],
    });
    expect(jobDefinitions).toEqual([]);
    await app.close();
  });
});
