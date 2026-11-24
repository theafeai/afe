import { describe, expect, it } from "vitest";
import { compileMapping, compileSafeRegex, observationsOf } from "../src/mapping/index.ts";
import type { MappingConfig } from "../src/mapping/index.ts";
import {
  familyOf,
  inferSetup,
  mergeSetup,
  setupChangesSchema,
  type InferenceEvent,
  type InferredFact,
  type InferredFactRecord,
  type SetupOverrideRecord,
} from "../src/setup/index.ts";

const T0 = Date.UTC(2026, 9, 1, 8, 0);
let n = 0;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function gh(o: {
  env: string;
  min: number;
  sha: string;
  action?: string;
  outcome?: string;
  runEvent?: string;
  production?: boolean;
  transient?: boolean;
  ref?: string;
}): InferenceEvent {
  n++;
  return {
    id: `e${n}`,
    source: "github",
    action: o.action ?? "deployment.status_updated",
    outcome: o.outcome ?? "succeeded",
    occurredAt: at(o.min),
    trigger: { type: "upstream", sourceValue: o.runEvent ?? "push" },
    target: {
      type: "deployment",
      id: `acme/web/deployments/${n}`,
      repository: "acme/web",
      environment: o.env,
    },
    actor: { type: "user", id: "1", login: "octocat" },
    correlation: {
      environments: [o.env],
      commitShas: [o.sha],
      deploymentIds: [`github:${o.env}:${o.sha}`],
      repositories: ["github.com/acme/web"],
    },
    data: {
      deployment: {
        sha: o.sha,
        ref: o.ref ?? "main",
        productionEnvironment: o.production ?? false,
        transientEnvironment: o.transient ?? false,
      },
      run: { event: o.runEvent ?? "push" },
    },
  } as InferenceEvent;
}

function review(env: string, min: number): InferenceEvent {
  n++;
  return {
    id: `e${n}`,
    source: "github",
    action: "deployment.review_requested",
    outcome: "none",
    occurredAt: at(min),
    trigger: { type: "manual", sourceValue: "deployment_review.requested" },
    target: { type: "workflow_run", id: `acme/web/actions/runs/${n}`, environment: env },
    correlation: { environments: [env] },
    data: { environments: [env] },
  };
}

/** Acme-like history: staging on push, production by dispatch behind reviewers, PR previews. */
function acme(): InferenceEvent[] {
  const events: InferenceEvent[] = [];
  for (let i = 0; i < 6; i++) {
    const sha = `c${i}`;
    const base = i * 120;
    events.push(gh({ env: "staging", min: base, sha }));
    events.push(review("production", base + 20));
    events.push(
      gh({
        env: "production",
        min: base + 30,
        sha,
        runEvent: "workflow_dispatch",
        production: true,
      }),
    );
  }
  for (let i = 1; i <= 3; i++) {
    events.push(
      gh({ env: `pr-${i}`, min: 900 + i, sha: `p${i}`, runEvent: "pull_request", transient: true }),
    );
  }
  return events;
}

const emptyMapping = (extra: Partial<MappingConfig> = {}) =>
  compileMapping({
    services: [],
    environments: [],
    rules: [],
    builtinDefaultEnabled: false,
    ...extra,
  });

const factOf = (facts: InferredFact[], env: string, field: string) =>
  facts.find((f) => f.subject === `environment:${env}` && f.field === field);

const records = (facts: InferredFact[], when = at(500)): InferredFactRecord[] =>
  facts.map((f) => ({ ...f, firstInferredAt: when, computedAt: when }));

describe("inferSetup (D-0012 rules)", () => {
  const facts = inferSetup(acme(), { mapping: emptyMapping(), adminEnvironmentIds: [] });

  it("names environments after what the tools report, PR previews as one family", () => {
    const subjects = [...new Set(facts.map((f) => f.subject))].sort();
    expect(subjects).toEqual([
      "environment:previews",
      "environment:production",
      "environment:staging",
    ]);
    expect(factOf(facts, "staging", "name")).toMatchObject({
      value: "staging",
      confidence: "certain",
    });
    expect(factOf(facts, "previews", "name")).toMatchObject({
      value: "Previews",
      confidence: "strong",
    });
    expect(factOf(facts, "previews", "sources")!.value).toEqual([
      { field: "github.environment", match: "regex", pattern: "^pr[\\-_ #\\/]*\\d+$" },
    ]);
  });

  it("orders by the way changes move: staging before production (strong)", () => {
    const s = factOf(facts, "staging", "order")!;
    const p = factOf(facts, "production", "order")!;
    expect(s.value).toBeLessThan(p.value as number);
    expect(p.confidence).toBe("strong");
    expect(p.evidence[0]!.detail).toBe("After staging for 6 of 6 changes");
    expect(factOf(facts, "previews", "order")!.confidence).toBe("weak");
  });

  it("production-like: tool-declared, short-lived, then by name", () => {
    expect(factOf(facts, "production", "productionLike")).toMatchObject({
      value: true,
      confidence: "certain",
    });
    expect(factOf(facts, "previews", "productionLike")).toMatchObject({
      value: false,
      confidence: "strong",
    });
    expect(factOf(facts, "staging", "productionLike")).toMatchObject({
      value: false,
      confidence: "probable",
    });
  });

  it("process: approval behind reviewers, automatic on push, one environment per PR", () => {
    expect(factOf(facts, "production", "gating")).toMatchObject({
      value: "approval",
      confidence: "certain",
    });
    expect(factOf(facts, "staging", "gating")).toMatchObject({
      value: "automatic",
      confidence: "strong",
    });
    expect(factOf(facts, "previews", "gating")).toMatchObject({ value: "per_change" });
    expect(factOf(facts, "production", "batching")).toMatchObject({ value: "each_change" });
    expect(factOf(facts, "staging", "cadence")!.value).toMatchObject({
      medianSeconds: 7200,
      deployments: 6,
    });
  });

  it("detects batches: production ships several staged changes at once", () => {
    const events: InferenceEvent[] = [];
    for (let i = 0; i < 18; i++) events.push(gh({ env: "stg", min: i * 10, sha: `b${i}` }));
    for (let k = 0; k < 6; k++) {
      // Every third staged change goes to production, carrying the two before it.
      events.push(gh({ env: "prd", min: k * 30 + 25, sha: `b${k * 3 + 2}` }));
    }
    const f = inferSetup(events, { mapping: emptyMapping(), adminEnvironmentIds: [] });
    expect(factOf(f, "prd", "batching")).toMatchObject({ value: "batches", confidence: "strong" });
  });

  it("is deterministic and independent of input order", () => {
    const shuffled = [...acme()].reverse();
    const strip = (fs: InferredFact[]) =>
      JSON.stringify(fs.map((f) => [f.subject, f.field, f.value]));
    expect(strip(inferSetup(shuffled, { mapping: emptyMapping(), adminEnvironmentIds: [] }))).toBe(
      strip(facts),
    );
  });

  it("keeps repository names, logins and commits out of evidence", () => {
    const text = JSON.stringify(facts);
    expect(text).not.toContain("acme/web");
    expect(text).not.toContain("octocat");
    expect(text).not.toMatch(/"c\d"/);
  });

  it("attributes names the admin mapping places to the admin environment", () => {
    const mapping = compileMapping({
      services: [],
      environments: [{ id: "live", name: "Live", order: 10, kind: "production" }],
      rules: [
        {
          id: "r1",
          kind: "environment",
          field: "github.environment",
          match: "exact",
          pattern: "production",
          caseSensitive: false,
          priority: 10,
          targetId: "live",
          enabled: true,
        },
      ],
      builtinDefaultEnabled: false,
    });
    const f = inferSetup(acme(), { mapping, adminEnvironmentIds: ["live"] });
    expect(f.some((x) => x.subject === "environment:production")).toBe(false);
    expect(factOf(f, "live", "gating")!.value).toBe("approval");
    // The admin names it; Afe infers no name and needs no source for it.
    expect(factOf(f, "live", "name")).toBeUndefined();
    expect(factOf(f, "live", "sources")).toBeUndefined();
  });

  it("families compile in the safe regex syntax and only match their names", () => {
    const fam = familyOf("pr-42", false)!;
    const re = compileSafeRegex(fam.pattern, { ignoreCase: true });
    expect(["pr-1", "PR 7", "pr#3", "pr/9"].every((v) => re.test(v))).toBe(true);
    expect(["prod", "pr-x", "preview-2"].some((v) => re.test(v))).toBe(false);
    expect(familyOf("prod-2", false)).toBeNull();
    expect(familyOf("hotfix-7", true)).toMatchObject({ id: "hotfix-previews" });
    const branch = familyOf("preview/feature.x", false)!;
    expect(compileSafeRegex(branch.pattern, { ignoreCase: true }).test("preview/other")).toBe(true);
  });
});

/** A runner-reported Terraform CLI event, shaped like `terraformEvent` in @afe/connector-terraform. */
function tf(o: {
  operation: "plan" | "apply" | "destroy";
  phase?: "started" | "completed";
  min: number;
  run: string;
  workspace: string;
  environment?: string;
  sha?: string;
  outcome?: string;
  trigger?: string;
}): InferenceEvent {
  n++;
  const phase = o.phase ?? "completed";
  return {
    id: `e${n}`,
    source: "terraform",
    action: `terraform.${o.operation}.${phase}`,
    outcome: o.outcome ?? (phase === "started" ? "in_progress" : "succeeded"),
    occurredAt: at(o.min),
    trigger: { type: o.trigger ?? "push", sourceValue: "runner_report" },
    target: {
      type: "workflow_run",
      id: `tf-conn/${o.run}`,
      name: `${o.workspace}: ${o.operation}`,
      project: o.workspace,
      environment: o.environment,
    },
    actor: { type: "user", login: "octocat" },
    correlation: {
      commitShas: o.sha ? [o.sha] : undefined,
      runIds: [`terraform:tf-conn:${o.run}`],
      environments: o.environment ? [o.environment] : undefined,
    },
    data: { workspace: o.workspace, operation: o.operation, phase },
  } as InferenceEvent;
}

describe("inferSetup from Terraform runs (AFE-116)", () => {
  const opts = { mapping: emptyMapping(), adminEnvironmentIds: [] };

  it("names environments the way Terraform reports them: environment, else workspace", () => {
    const facts = inferSetup(
      [
        tf({ operation: "apply", min: 0, run: "r1", workspace: "infra", environment: "eu-live" }),
        tf({ operation: "apply", min: 5, run: "r2", workspace: "uat" }),
      ],
      opts,
    );
    expect(factOf(facts, "eu-live", "name")).toMatchObject({
      value: "eu-live",
      confidence: "certain",
      reason: "Terraform reports this name",
    });
    expect(factOf(facts, "eu-live", "sources")!.value).toEqual([
      { field: "terraform.environment", match: "exact", pattern: "eu-live" },
    ]);
    // No environment configured: the workspace is Terraform's own name for it.
    expect(factOf(facts, "uat", "sources")!.value).toEqual([
      { field: "terraform.workspace", match: "exact", pattern: "uat" },
    ]);
    // A workspace with a configured environment does not become an environment itself.
    expect(facts.some((f) => f.subject === "environment:infra")).toBe(false);
  });

  it("Terraform's `default` workspace is not an environment name", () => {
    const facts = inferSetup(
      [tf({ operation: "apply", min: 0, run: "r1", workspace: "default" })],
      opts,
    );
    expect(facts).toEqual([]);
  });

  it("applies are deployments: started and completed count once, with cadence and start", () => {
    const events: InferenceEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const run = `a${i}`;
      events.push(tf({ operation: "apply", phase: "started", min: i * 60, run, workspace: "ops" }));
      events.push(tf({ operation: "apply", min: i * 60 + 2, run, workspace: "ops" }));
    }
    const facts = inferSetup(events, opts);
    expect(factOf(facts, "ops", "cadence")!.value).toMatchObject({
      deployments: 4,
      medianSeconds: 3600,
    });
    expect(factOf(facts, "ops", "gating")).toMatchObject({
      value: "automatic",
      confidence: "probable",
      evidence: [expect.objectContaining({ detail: "4 of 4 deployments started by push" })],
    });
  });

  it("plans and destroys show the environment but are not deployments", () => {
    const facts = inferSetup(
      [
        tf({ operation: "plan", min: 0, run: "p1", workspace: "sbx", trigger: "pull_request" }),
        tf({ operation: "plan", min: 10, run: "p2", workspace: "sbx", trigger: "pull_request" }),
        tf({ operation: "plan", min: 20, run: "p3", workspace: "sbx", trigger: "pull_request" }),
        tf({ operation: "destroy", min: 30, run: "d1", workspace: "sbx", trigger: "cli" }),
      ],
      opts,
    );
    expect(factOf(facts, "sbx", "name")).toMatchObject({ value: "sbx" });
    expect(factOf(facts, "sbx", "gating")).toBeUndefined();
    expect(factOf(facts, "sbx", "cadence")).toBeUndefined();
  });

  it("orders Terraform applies with other tools by the commits they reach", () => {
    const events: InferenceEvent[] = [];
    for (let i = 0; i < 5; i++) {
      const sha = `t${i}`;
      events.push(gh({ env: "qa-sandbox", min: i * 100, sha }));
      events.push(
        tf({ operation: "apply", min: i * 100 + 30, run: `o${i}`, workspace: "edge", sha }),
      );
    }
    const facts = inferSetup(events, opts);
    expect(factOf(facts, "edge", "order")).toMatchObject({ confidence: "strong" });
    expect(factOf(facts, "edge", "order")!.value).toBeGreaterThan(
      factOf(facts, "qa-sandbox", "order")!.value as number,
    );
  });
});

describe("mergeSetup (overrides win, inference never overwrites)", () => {
  const facts = inferSetup(acme(), { mapping: emptyMapping(), adminEnvironmentIds: [] });
  const inferred = records(facts);
  const override = (
    env: string,
    field: SetupOverrideRecord["field"],
    value: unknown,
    keptInferred: unknown = null,
  ): SetupOverrideRecord => ({
    subject: `environment:${env}`,
    field,
    value,
    setBy: { id: "token:admin", name: "Priya" },
    setAt: at(1000),
    keptInferred,
  });

  it("without overrides, every value is inferred with its confidence and reason", () => {
    const m = mergeSetup({ adminEnvironments: [], inferred, overrides: [] });
    expect(m.environments.map((e) => e.id)).toEqual(["staging", "production", "previews"]);
    const prod = m.environments.find((e) => e.id === "production")!;
    expect(prod.productionLike).toMatchObject({
      value: true,
      origin: "inferred",
      confidence: "certain",
    });
    expect(prod.kind).toBe("production");
    expect(m.noticed).toEqual([]);
    expect(m.mappingEnvironments.find((e) => e.id === "production")!.productionLike).toBe(true);
  });

  it("an override wins, keeps Afe's guess beside it, and a disagreement is noticed", () => {
    const m = mergeSetup({
      adminEnvironments: [],
      inferred,
      overrides: [
        override("production", "gating", "automatic"),
        override("staging", "name", "Stage"),
      ],
    });
    const prod = m.environments.find((e) => e.id === "production")!;
    expect(prod.gating).toMatchObject({
      value: "automatic",
      origin: "admin",
      via: "override",
      setBy: { name: "Priya" },
      inferred: { value: "approval", confidence: "certain" },
    });
    expect(m.environments.find((e) => e.id === "staging")!.name.value).toBe("Stage");
    expect(m.noticed).toEqual([
      expect.objectContaining({
        id: "disagreement:production:gating",
        actions: ["keep", "use_inferred"],
      }),
    ]);
  });

  it("'keep' silences the disagreement only while inference says the same", () => {
    const kept = override("production", "gating", "automatic", "approval");
    expect(mergeSetup({ adminEnvironments: [], inferred, overrides: [kept] }).noticed).toEqual([]);
    const changed = inferred.map((f) =>
      f.subject === "environment:production" && f.field === "gating"
        ? { ...f, value: "on_demand" }
        : f,
    );
    expect(
      mergeSetup({ adminEnvironments: [], inferred: changed, overrides: [kept] }).noticed,
    ).toHaveLength(1);
  });

  it("'not an environment' removes it from the mapping and its rules", () => {
    const m = mergeSetup({
      adminEnvironments: [],
      inferred,
      overrides: [override("previews", "included", false)],
    });
    expect(m.environments.find((e) => e.id === "previews")!.included.value).toBe(false);
    expect(m.mappingEnvironments.map((e) => e.id)).not.toContain("previews");
    expect(m.inferredRules.some((r) => r.targetId === "previews")).toBe(false);
  });

  it("admin environments: their row is the admin's value; inference is only reported", () => {
    const m = mergeSetup({
      adminEnvironments: [
        {
          id: "production",
          name: "Prod",
          order: 5,
          kind: "staging",
          createdAt: at(-10),
          updatedAt: at(-10),
        },
      ],
      inferred,
      overrides: [],
    });
    const prod = m.environments.find((e) => e.id === "production")!;
    expect(prod.origin).toBe("admin");
    expect(prod.name).toMatchObject({ value: "Prod", origin: "admin", via: "mapping" });
    expect(prod.productionLike).toMatchObject({
      value: false,
      origin: "admin",
      inferred: { value: true },
    });
    expect(m.noticed.map((x) => x.id)).toEqual(
      expect.arrayContaining(["disagreement:production:productionLike"]),
    );
    // Environments Afe found after the admin set things up are noticed, not added silently.
    expect(m.noticed.map((x) => x.id)).toEqual(
      expect.arrayContaining(["new_environment:staging", "new_environment:previews"]),
    );
  });

  it("inferred rules place events; built-in rules stay off for new tenants", () => {
    const m = mergeSetup({ adminEnvironments: [], inferred, overrides: [] });
    const mapping = compileMapping({
      services: [],
      environments: m.mappingEnvironments,
      rules: [],
      inferredRules: m.inferredRules,
      builtinDefaultEnabled: false,
    });
    const place = (env: string) =>
      mapping.resolveObservations(
        "github",
        observationsOf({ source: "github", target: { environment: env } }),
      ).environmentId;
    expect(place("pr-77")).toBe("previews");
    expect(place("Staging")).toBe("staging");
    expect(place("prod-eu")).toBeNull();
    expect(
      mapping.inactive.find((i) => i.ruleId === "builtin:github-environment-production")!.reason,
    ).toBe("off by default: environments are inferred");
  });
});

describe("setup change validation", () => {
  it("checks each value against its field and one mode per change", () => {
    const ok = setupChangesSchema.safeParse({
      changes: [
        { environment: "production", field: "productionLike", value: true },
        { environment: "staging", field: "gating", clear: true },
        { environment: "previews", field: "batching", keep: true },
      ],
    });
    expect(ok.success).toBe(true);
    for (const changes of [
      [{ environment: "production", field: "gating", value: "sometimes" }],
      [{ environment: "production", field: "order", value: 1, clear: true }],
      [{ environment: "Bad Id", field: "name", value: "x" }],
      [{ environment: "production", field: "kind", value: "production" }],
      [
        { environment: "a", field: "name", value: "x" },
        { environment: "a", field: "name", value: "y" },
      ],
    ]) {
      expect(setupChangesSchema.safeParse({ changes }).success).toBe(false);
    }
  });
});
