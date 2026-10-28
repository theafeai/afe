import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEventInput, buildStoredEvent, type Connection } from "@afe/core";
import { placementSlot, stageOf } from "@afe/core/correlation";
import { observationsOf } from "@afe/core/mapping";
import { reportSchema, terraformEvent } from "../src/index.ts";

const connection: Connection = {
  tenantId: "default",
  id: randomUUID(),
  source: "terraform",
  externalId: randomUUID(),
  name: "demo",
  status: "active",
  statusReason: null,
  config: { workspace: "demo", environment: "development", repository: "owner/repo" },
  createdAt: new Date(),
  updatedAt: new Date(),
};
const now = new Date();
describe("Terraform lifecycle mapping", () => {
  it.each([
    ["plan", 0, "succeeded"],
    ["plan", 2, "succeeded"],
    ["plan", 1, "failed"],
    ["apply", 0, "succeeded"],
    ["apply", 2, "failed"],
    ["apply", 1, "failed"],
    ["destroy", 0, "succeeded"],
    ["destroy", 1, "failed"],
    ["apply", 130, "cancelled"],
    ["destroy", 143, "cancelled"],
  ])("maps %s exit %i to %s", (operation, exitCode, outcome) => {
    const report = reportSchema.parse({
      version: 1,
      runId: randomUUID(),
      operation,
      exitCode,
      phase: "completed",
      sentAt: now.toISOString(),
      occurredAt: now.toISOString(),
    });
    const event = parseEventInput(terraformEvent(connection, report, now));
    expect(event.outcome).toBe(outcome);
    expect(event.actor.type).toBe("unknown");
    expect(event.observation.detail).toContain("Runner-reported");
    expect(event.data?.changesPresent).toBe(
      operation === "plan" && (exitCode === 0 || exitCode === 2) ? exitCode === 2 : null,
    );
    expect(event.rawPayload).toBeNull();
    expect(observationsOf(event)).toMatchObject({
      "terraform.workspace": ["demo"],
      "terraform.environment": ["development"],
    });
    const stored = buildStoredEvent({
      tenantId: "default",
      seq: 1,
      input: event,
      rawPayload: null,
    });
    expect(placementSlot(stored)).toBeUndefined();
    expect(stageOf(stored, "github.com/owner/repo")).toBe("config");
  });
  it("represents start without inventing a result and validates exit code semantics", () => {
    const body = {
      version: 1,
      runId: randomUUID(),
      operation: "plan",
      phase: "started",
      sentAt: now.toISOString(),
      occurredAt: now.toISOString(),
    };
    const event = parseEventInput(terraformEvent(connection, reportSchema.parse(body), now));
    expect(event.outcome).toBe("in_progress");
    expect(reportSchema.safeParse({ ...body, exitCode: 0 }).success).toBe(false);
    expect(reportSchema.safeParse({ ...body, phase: "completed" }).success).toBe(false);
  });
});
