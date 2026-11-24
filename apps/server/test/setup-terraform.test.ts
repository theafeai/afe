/**
 * AFE-116: Terraform runs and applies feed setup inference. The events are
 * built by the connector's own mapper (`terraformEvent`), stored, and read
 * back by the `setup.infer` job's query, so a narrowed action filter fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Connection } from "@afe/core";
import { terraformEvent, type TerraformReport } from "@afe/connector-terraform";
import { ingestEvent, listInferredSetup } from "@afe/db";
import { createTestPool } from "@afe/db/testing";
import { inferTenantSetup } from "../src/setup/inference.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function connection(externalId: string, config: Record<string, string>): Connection {
  return {
    tenantId: "default",
    id: "00000000-0000-4000-8000-000000000000",
    source: "terraform",
    externalId,
    name: externalId,
    status: "active",
    statusReason: null,
    config,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
  } as Connection;
}

function report(
  operation: TerraformReport["operation"],
  phase: TerraformReport["phase"],
  run: number,
  min: number,
): TerraformReport {
  return {
    version: 1,
    runId: `00000000-0000-4000-8000-${String(run).padStart(12, "0")}`,
    operation,
    phase,
    sentAt: at(min),
    occurredAt: at(min),
    ...(phase === "completed" ? { exitCode: 0 } : {}),
    trigger: "push",
  };
}

describe("setup inference from Terraform (AFE-116)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await createTestPool();
    const live = connection("tf-live", { workspace: "network", environment: "eu-live" });
    const ws = connection("tf-uat", { workspace: "uat" });
    const store = async (c: Connection, r: TerraformReport) => {
      const { connectionId: _unused, ...event } = terraformEvent(c, r, new Date(r.occurredAt));
      await ingestEvent(pool, "default", event);
    };
    let run = 0;
    for (let i = 0; i < 3; i++) {
      run++;
      await store(live, report("apply", "started", run, i * 60));
      await store(live, report("apply", "completed", run, i * 60 + 3));
    }
    run++;
    await store(ws, report("plan", "started", run, 10));
    await store(ws, report("plan", "completed", run, 11));
  });
  afterAll(async () => {
    await pool.end();
  });

  it("infers the environments Terraform reports, by environment or workspace", async () => {
    const result = await inferTenantSetup(pool, "default");
    expect(result.events).toBe(8);
    expect(result.environments).toBe(2);
    const facts = await listInferredSetup(pool, "default");
    const value = (env: string, field: string) =>
      facts.find((f) => f.subject === `environment:${env}` && f.field === field)?.value;
    expect(value("eu-live", "name")).toBe("eu-live");
    expect(value("eu-live", "sources")).toEqual([
      { field: "terraform.environment", match: "exact", pattern: "eu-live" },
    ]);
    expect(value("eu-live", "cadence")).toMatchObject({ deployments: 3, medianSeconds: 3600 });
    expect(value("eu-live", "gating")).toBe("automatic");
    expect(value("uat", "sources")).toEqual([
      { field: "terraform.workspace", match: "exact", pattern: "uat" },
    ]);
    // A plan shows the environment; it is not a deployment.
    expect(value("uat", "cadence")).toBeUndefined();
  });
});
