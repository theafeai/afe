import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyProvider, signHmac } from "@afe/core/security";
import { getConnectionCredentialIds, getCredentialMetadata } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { buildAfe, InlineJobQueue, loadConfig, type AfeApp } from "../src/index.ts";
import {
  createTerraformModule,
  processTerraformReports,
  TERRAFORM_SWEEP,
} from "../src/connectors/terraform.ts";
import { healthModule } from "../src/health/index.ts";
import { tokenMapAuth } from "./helpers/auth.ts";

describe("Terraform reporter connection", () => {
  let pool: pg.Pool;
  let afe: AfeApp;
  const jobs = new InlineJobQueue();
  const logs: string[] = [];
  const clock = new Date();
  const module = createTerraformModule({ now: () => clock });
  let id: string, path: string, secret: string;
  const admin = { authorization: "Bearer owner" };
  const report = (extra: object = {}) => ({
    version: 1,
    runId: randomUUID(),
    operation: "apply",
    phase: "completed",
    exitCode: 0,
    occurredAt: clock.toISOString(),
    sentAt: clock.toISOString(),
    ...extra,
  });
  const send = (body: object, key = secret, target = path) => {
    const payload = JSON.stringify(body);
    return afe.app.inject({
      method: "POST",
      url: target,
      payload,
      headers: {
        "content-type": "application/json",
        "x-afe-signature": signHmac("sha256", key, payload, "sha256="),
      },
    });
  };
  const count = async () =>
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM events WHERE connection_id = $1 AND source = 'terraform'",
          [id],
        )
      ).rows[0].count,
    );
  const pending = async () =>
    Number(
      (await pool.query("SELECT count(*) FROM terraform_reports WHERE connection_id = $1", [id]))
        .rows[0].count,
    );

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ('other', 'Other') ON CONFLICT DO NOTHING",
    );
    afe = await buildAfe({
      pool,
      jobs,
      keys: new EnvKeyProvider({ keys: { default: randomBytes(32) } }),
      config: loadConfig({ DATABASE_URL: "unused" }),
      connectors: [module, healthModule],
      authProvider: tokenMapAuth({
        owner: { tenantId: "default", roles: ["admin"] },
        other: { tenantId: "other", roles: ["admin"] },
      }),
      logLevel: "debug",
      logStream: new Writable({
        write(chunk, _encoding, cb) {
          logs.push(String(chunk));
          cb();
        },
      }),
    });
  });
  beforeEach(async () => {
    const response = await afe.app.inject({
      method: "POST",
      url: "/api/connections/terraform",
      headers: admin,
      payload: {
        workspace: "afe-demo",
        environment: "development",
        repository: "theafeai/afe-demo",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    id = body.connection.id;
    path = body.reportPath;
    secret = body.secret;
    jobs.sent.length = 0;
  });
  afterAll(async () => {
    await afe.app.close();
    await pool.end();
  });

  it("encrypts the reporter key, returns it only at registration, and rejects secret-bearing config", async () => {
    const ids = await getConnectionCredentialIds(pool, "default", id);
    expect((await getCredentialMetadata(pool, "default", ids.reporter!))?.kind).toBe(
      "terraform_reporter",
    );
    const row = (
      await pool.query("SELECT config FROM connections WHERE tenant_id = $1 AND id = $2", [
        "default",
        id,
      ])
    ).rows[0];
    expect(JSON.stringify(row)).not.toContain(secret);
    const views = await afe.app.inject({ method: "GET", url: "/api/connections", headers: admin });
    expect(views.body).not.toContain(secret);
    const invalid = await afe.app.inject({
      method: "POST",
      url: "/api/connections/terraform",
      headers: admin,
      payload: { workspace: "test", state: "SECRET_STATE" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("stages signed reports, deduplicates redelivery and ingests correlated metadata without raw payloads", async () => {
    const body = report({
      commitSha: "a".repeat(40),
      repository: "theafeai/afe-demo",
      githubRunId: "123",
      actor: "tester",
    });
    expect((await send(body)).statusCode).toBe(202);
    expect((await send(body)).json()).toEqual({ status: "duplicate" });
    expect(await pending()).toBe(1);
    expect(await count()).toBe(0);
    expect(JSON.stringify(jobs.sent)).not.toContain(secret);
    await processTerraformReports(afe.context, "default", id);
    await processTerraformReports(afe.context, "default", id);
    expect(await pending()).toBe(0);
    expect(await count()).toBe(1);
    const row = (
      await pool.query(
        "SELECT action, outcome, correlation, raw_payload_id, data FROM events WHERE connection_id = $1 AND source = 'terraform'",
        [id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      action: "terraform.apply.completed",
      outcome: "succeeded",
      raw_payload_id: null,
      correlation: { commitShas: ["a".repeat(40)], runIds: expect.arrayContaining(["github:123"]) },
      data: { attribution: "runner_reported" },
    });
    const health = (
      await afe.app.inject({ url: `/api/connections/${id}/health`, headers: admin })
    ).json();
    expect(health.connection.health.lastSuccessAt).not.toBeNull();
    expect(logs.join("")).not.toContain(secret);
  });

  it.each(["missing", "invalid", "duplicated", "wrong-secret", "other-connection"])(
    "rejects %s signatures",
    async (mode) => {
      const payload = JSON.stringify(report());
      const signature = signHmac("sha256", secret, payload, "sha256=");
      const headers: Record<string, string | string[]> = { "content-type": "application/json" };
      if (mode === "invalid") headers["x-afe-signature"] = "invalid";
      if (mode === "duplicated") headers["x-afe-signature"] = [signature, signature];
      if (mode === "wrong-secret")
        headers["x-afe-signature"] = signHmac("sha256", "other", payload, "sha256=");
      if (mode === "other-connection") headers["x-afe-signature"] = signature;
      const response = await afe.app.inject({
        method: "POST",
        url: mode === "other-connection" ? path.replace(/v1\/[^/]+/, `v1/${randomUUID()}`) : path,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(401);
      expect(await pending()).toBe(0);
      expect(logs.join("")).not.toContain(signature);
    },
  );

  it("rejects stale signed reports, future event timestamps and mismatched repositories", async () => {
    expect(
      (await send(report({ sentAt: new Date(clock.getTime() - 301_000).toISOString() })))
        .statusCode,
    ).toBe(401);
    expect(
      (await send(report({ occurredAt: new Date(clock.getTime() + 301_000).toISOString() })))
        .statusCode,
    ).toBe(401);
    expect((await send(report({ repository: "other/repo", githubRunId: "123" }))).statusCode).toBe(
      400,
    );
    expect(await pending()).toBe(0);
  });

  it("rejects raw state, plan, diagnostic and output fields without persisting or logging their contents", async () => {
    for (const key of ["state", "plan", "outputs", "diagnostics", "resourceChanges", "tenantId"]) {
      const res = await send(report({ [key]: "SENSITIVE_VALUE_SHOULD_NEVER_BE_STORED" }));
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain("SENSITIVE_VALUE");
    }
    expect(await pending()).toBe(0);
    expect(logs.join("")).not.toContain("SENSITIVE_VALUE");
  });

  it("isolates tenant reads, rotation, disconnect and processing", async () => {
    await send(report());
    const other = (
      await afe.app.inject({
        method: "POST",
        url: "/api/connections/terraform",
        headers: { authorization: "Bearer other" },
        payload: { workspace: "another" },
      })
    ).json();
    expect((await send(report(), secret, other.reportPath)).statusCode).toBe(401);
    expect((await send(report(), other.secret, path)).statusCode).toBe(401);
    expect((await send(report(), other.secret, other.reportPath)).statusCode).toBe(202);
    for (const method of ["POST", "DELETE"] as const) {
      const res = await afe.app.inject({
        method,
        url: `/api/connections/terraform/${id}${method === "POST" ? "/rotate-secret" : ""}`,
        headers: { authorization: "Bearer other" },
      });
      expect(res.statusCode).toBe(404);
    }
    expect(
      (
        await afe.app.inject({
          url: `/api/connections/${id}/health`,
          headers: { authorization: "Bearer other" },
        })
      ).statusCode,
    ).toBe(404);
    await processTerraformReports(afe.context, "other", id);
    expect(await pending()).toBe(1);
    expect(await count()).toBe(0);
  });

  it("makes rotation immediate and disconnect revokes ingestion while retaining existing events", async () => {
    await send(report());
    await processTerraformReports(afe.context, "default", id);
    const rotated = await afe.app.inject({
      method: "POST",
      url: `/api/connections/terraform/${id}/rotate-secret`,
      headers: admin,
    });
    expect(rotated.statusCode).toBe(200);
    expect((await send(report())).statusCode).toBe(401);
    const newKey = rotated.json().secret;
    expect((await send(report(), newKey)).statusCode).toBe(202);
    expect(
      (
        await afe.app.inject({
          method: "DELETE",
          url: `/api/connections/terraform/${id}`,
          headers: admin,
        })
      ).statusCode,
    ).toBe(200);
    expect((await send(report(), newKey)).statusCode).toBe(401);
    await processTerraformReports(afe.context, "default", id);
    expect(await pending()).toBe(0);
    expect(await count()).toBe(1);
  });

  it("recovers a crash after event commit without duplicating the event", async () => {
    await send(report());
    const original = afe.context.sink;
    afe.context.sink = {
      async ingest(tenantId, input) {
        await original.ingest(tenantId, input);
        throw new Error("simulated crash");
      },
    };
    try {
      await expect(processTerraformReports(afe.context, "default", id)).rejects.toThrow(
        "simulated crash",
      );
    } finally {
      afe.context.sink = original;
    }
    expect(await pending()).toBe(1);
    expect(await count()).toBe(1);
    await processTerraformReports(afe.context, "default", id);
    expect(await pending()).toBe(0);
    expect(await count()).toBe(1);
  });

  it("accepts durably if enqueue fails and the sweep recovers the report", async () => {
    const original = afe.context.jobs;
    afe.context.jobs = {
      async send() {
        throw new Error("queue unavailable");
      },
    };
    try {
      expect((await send(report())).statusCode).toBe(202);
    } finally {
      afe.context.jobs = original;
    }
    expect(await pending()).toBe(1);
    jobs.sent.length = 0;
    await module.jobs!(afe.context)
      .find((j) => j.name === TERRAFORM_SWEEP)!
      .handler({});
    expect(jobs.sent.some((j) => (j.data as { connectionId?: string }).connectionId === id)).toBe(
      true,
    );
    await processTerraformReports(afe.context, "default", id);
    expect(await count()).toBe(1);
  });

  it("applies backpressure without poisoning replay recovery", async () => {
    await pool.query(
      `INSERT INTO terraform_reports (tenant_id, connection_id, report_key, body)
      SELECT 'default', $1::uuid, 'pending-' || i, '{}'::jsonb FROM generate_series(1, 1000) i`,
      [id],
    );
    const body = report();
    expect((await send(body)).statusCode).toBe(429);
    await pool.query("DELETE FROM terraform_reports WHERE tenant_id = $1 AND connection_id = $2", [
      "default",
      id,
    ]);
    expect((await send(body)).statusCode).toBe(202);
    await processTerraformReports(afe.context, "default", id);
    expect(await count()).toBe(1);
  });

  it("observes a report without any outbound provider or Terraform HTTP calls", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No outbound requests permitted"));
    try {
      expect((await send(report())).statusCode).toBe(202);
      await processTerraformReports(afe.context, "default", id);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
