/**
 * The setup view for locally managed users. Pure: builds the merged setup
 * in memory, so it runs without Postgres (the route is covered in scoped-views.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  mergeSetup,
  type InferredFactRecord,
  type InferredField,
  type SetupOverrideRecord,
} from "@afe/core/setup";
import type { LoadedMapping } from "../src/mapping/service.ts";
import { scopedSetupView } from "../src/setup/routes.ts";

const AT = "2026-11-23T10:00:00.000Z";

function fact(
  env: string,
  field: InferredField,
  value: unknown,
  reason: string,
): InferredFactRecord {
  return {
    subject: `environment:${env}`,
    field,
    value: value as never,
    confidence: "certain",
    reason,
    evidence: [{ rule: `${field}.test`, source: "github", detail: reason, count: 12 }],
    firstInferredAt: AT,
    computedAt: AT,
  };
}

const inferred: InferredFactRecord[] = [
  fact("production", "name", "production", "GitHub reports this name"),
  fact("production", "order", 20, "production is the last stop changes reach"),
  fact("production", "productionLike", true, "GitHub marks production as production"),
  fact("production", "gating", "approval", "production needs approval and only deploys main"),
  fact(
    "production",
    "cadence",
    { medianSeconds: 7200, p90Seconds: 9000, deployments: 12 },
    "12 deployments to production",
  ),
  fact(
    "production",
    "sources",
    [{ field: "github.environment", match: "exact", pattern: "production" }],
    "Events with these values belong here",
  ),
  fact("secret-qa", "name", "Secret QA", "GitHub reports this name"),
  fact("secret-qa", "order", 10, "Changes reach other environments after Secret QA"),
  fact("secret-qa", "productionLike", false, "The name Secret QA reads as other"),
];

const override: SetupOverrideRecord = {
  subject: "environment:production",
  field: "gating",
  value: "on_demand",
  setBy: { id: "token:admin", name: "Priya" },
  setAt: AT,
  keptInferred: null,
};

const loaded = {
  setup: mergeSetup({ adminEnvironments: [], inferred, overrides: [override] }),
} as unknown as LoadedMapping;

describe("scopedSetupView (managed users)", () => {
  it("lists only environments the user's events are placed in", () => {
    expect(loaded.setup.environments.map((e) => e.id).sort()).toEqual(["production", "secret-qa"]);
    const view = scopedSetupView(loaded, new Set(["production"]), false);
    expect(view.environments.map((e) => e.id)).toEqual(["production"]);
    expect(JSON.stringify(view)).not.toContain("Secret QA");
    expect(JSON.stringify(view)).not.toContain("secret-qa");
    expect(scopedSetupView(loaded, new Set(), false).environments).toEqual([]);
  });

  it("keeps values and provenance but drops reasons, evidence, cadence, sources and notices", () => {
    const view = scopedSetupView(loaded, new Set(["production"]), false);
    const prod = view.environments[0]!;
    expect(prod.productionLike).toEqual({
      value: true,
      origin: "inferred",
      confidence: "certain",
      inferred: null,
    });
    expect(prod.gating).toMatchObject({ value: "on_demand", origin: "admin", via: "override" });
    expect(prod).not.toHaveProperty("cadence");
    expect(prod).not.toHaveProperty("sources");
    expect(prod).not.toHaveProperty("firstInferredAt");
    const text = JSON.stringify(view);
    for (const leaked of [
      "evidence",
      "reason",
      "deployments",
      "only deploys main",
      "github.environment",
    ])
      expect(text).not.toContain(leaked);
    expect(loaded.setup.noticed.length).toBeGreaterThan(0);
    expect(view).toMatchObject({ readOnly: true, revision: 0, noticed: [], fields: [] });
  });

  it("shows who set an override only to admins", () => {
    const viewer = scopedSetupView(loaded, new Set(["production"]), false);
    expect(JSON.stringify(viewer)).not.toContain("Priya");
    expect(viewer.environments[0]!.gating).not.toHaveProperty("setBy");
    expect(viewer.environments[0]!.gating).not.toHaveProperty("setAt");
    const admin = scopedSetupView(loaded, new Set(["production"]), true);
    expect(admin.environments[0]!.gating).toMatchObject({
      setBy: { name: "Priya" },
      setAt: AT,
    });
  });

  it("never lists environments the admin excluded", () => {
    const excluded = {
      setup: mergeSetup({
        adminEnvironments: [],
        inferred,
        overrides: [{ ...override, field: "included", value: false }],
      }),
    } as unknown as LoadedMapping;
    expect(scopedSetupView(excluded, new Set(["production"]), false).environments).toEqual([]);
  });
});
