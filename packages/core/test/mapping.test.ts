import { describe, expect, it } from "vitest";
import {
  BUILTIN_RULES,
  compileGlob,
  compileMapping,
  compileSafeRegex,
  DEFAULT_ENVIRONMENTS,
  isMappingField,
  observationsOf,
  resolvePlacement,
  ruleInputSchema,
  SafeRegexError,
  slugify,
  type MappableEvent,
  type MappingConfig,
  type MappingRule,
} from "../src/mapping/index.ts";

const environments = [...DEFAULT_ENVIRONMENTS];

function rule(
  id: string,
  o: Partial<MappingRule> & Pick<MappingRule, "field" | "pattern" | "targetId">,
): MappingRule {
  return {
    id,
    kind: "environment",
    match: "exact",
    caseSensitive: false,
    priority: 10,
    enabled: true,
    ...o,
  };
}

function config(rules: MappingRule[] = [], extra: Partial<MappingConfig> = {}): MappingConfig {
  return {
    services: [
      { id: "web", name: "Web" },
      { id: "api", name: "API" },
    ],
    environments,
    rules,
    ...extra,
  };
}

const gh = (environment: string, repository = "acme/web"): MappableEvent => ({
  source: "github",
  target: { type: "environment", id: `${repository}:${environment}`, environment, repository },
});
const vercel = (target: string, project = "prj_web", name = "web"): MappableEvent => ({
  source: "vercel",
  target: { type: "deployment", id: "dpl_1", name, project, environment: target },
});
const argo = (
  o: Partial<MappableEvent["target"]> = {},
  labels?: Record<string, string>,
): MappableEvent => ({
  source: "argocd",
  target: {
    type: "application",
    id: "argocd/web-prod",
    name: "web-prod",
    application: "web-prod",
    project: "payments",
    cluster: "https://kubernetes.default.svc",
    namespace: "web",
    ...o,
  },
  ...(labels ? { labels } : {}),
});

describe("safe regex", () => {
  it("matches like RegExp for the supported syntax", () => {
    const cases: [string, string, boolean, boolean?][] = [
      ["^prod(uction)?\\b", "Production – web", true, true],
      ["^prod(uction)?\\b", "production", true, true],
      ["^prod(uction)?\\b", "productions", false, true],
      ["^prod(uction)?\\b", "prod-eu", true],
      ["^(stag|stg)\\b", "staging", false],
      ["eu-(west|east)-\\d{1,2}$", "cluster-eu-west-1", true],
      ["^[a-c]+[^x]?$", "abcabc", true],
      ["^[a-c]+[^x]?$", "abcx", false],
      ["a.c", "a\nc", false],
      ["\\.svc$", "kubernetes.default.svc", true],
      ["^(?:a|b){2,3}$", "abab", false],
      ["^(?:a|b){2,3}$", "aba", true],
      ["x*", "", true],
      ["\\Bend", "theend", true],
      ["\\Bend", "the end", false],
      ["^\\w+\\s\\S$", "abc d", true],
      ["[\\d-]+", "--", true],
    ];
    for (const [p, input, expected, ignoreCase] of cases) {
      const r = compileSafeRegex(p, { ignoreCase: ignoreCase ?? false });
      expect(r.test(input), `${p} on ${input}`).toBe(expected);
      expect(new RegExp(p, ignoreCase ? "i" : "").test(input), `RegExp ${p}`).toBe(expected);
    }
  });

  it("rejects unsupported and oversized constructs", () => {
    for (const p of [
      "(a)\\1",
      "(?=a)",
      "(?<!a)b",
      "(?<name>a)",
      "\\p{L}",
      "a**",
      "a{1000}",
      "(a{100}){100}",
      "*a",
      "[a",
      "(a",
      "a)",
      "x{2,1}",
      "a{",
      "^*",
      "a".repeat(257),
    ]) {
      expect(() => compileSafeRegex(p), p).toThrow(SafeRegexError);
    }
  });

  it("runs patterns that are catastrophic for backtracking engines in linear time", () => {
    const evil = ["^(a+)+$", "^(a|a)*$", "^(a*)*b$", "a*a*a*a*a*a*a*a*a*a*b", "^(\\w+\\s?)*$"];
    const input = "a".repeat(1000) + "!";
    const started = performance.now();
    for (const p of evil) expect(compileSafeRegex(p).test(input), p).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("glob", () => {
  it("matches * and ? over the whole value", () => {
    const g = compileGlob("Production*", { ignoreCase: true });
    expect(g.test("production – web")).toBe(true);
    expect(g.test("pre-production")).toBe(false);
    expect(compileGlob("*-prod").test("web-prod")).toBe(true);
    expect(compileGlob("web-?").test("web-1")).toBe(true);
    expect(compileGlob("web-?").test("web-12")).toBe(false);
    expect(compileGlob("a*b*c", { ignoreCase: false }).test("aXbYc")).toBe(true);
    expect(compileGlob("a*b*c", { ignoreCase: false }).test("AXBYC")).toBe(false);
    expect(compileGlob("*.*").test("a.b")).toBe(true);
    expect(compileGlob("[x]").test("[x]")).toBe(true); // classes are literal
  });

  it("is not exponential on many stars", () => {
    const started = performance.now();
    expect(compileGlob("*a*a*a*a*a*a*a*a*a*a*b").test("a".repeat(1000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("observations", () => {
  it("reads each tool's raw names", () => {
    expect(observationsOf(gh("Production – web"))).toEqual({
      "github.environment": ["Production – web"],
      "github.repository": ["acme/web"],
    });
    expect(observationsOf(vercel("preview"))).toEqual({
      "vercel.project": ["prj_web", "web"],
      "vercel.target": ["preview"],
    });
    expect(
      observationsOf(argo({ environment: "prod" }, { team: "payments", "afe.dev/tier": "1" })),
    ).toMatchObject({
      "argocd.application": ["web-prod"],
      "argocd.project": ["payments"],
      "argocd.namespace": ["web"],
      "argocd.environment": ["prod"],
      "argocd.label:team": ["payments"],
      "argocd.label:afe.dev/tier": ["1"],
    });
  });

  it("validates fields", () => {
    expect(isMappingField("github.environment")).toBe(true);
    expect(isMappingField("argocd.label:app.kubernetes.io/part-of")).toBe(true);
    expect(isMappingField("argocd.label:")).toBe(false);
    expect(isMappingField("github.secret")).toBe(false);
  });
});

describe("resolvePlacement", () => {
  it("built-in defaults map common environment names, with confidence default/partial", () => {
    const m = compileMapping(config());
    expect(resolvePlacement(vercel("production"), m)).toMatchObject({
      serviceId: null,
      environmentId: "production",
      matchedRuleIds: ["builtin:vercel-target-production"],
      confidence: "partial",
    });
    expect(resolvePlacement(vercel("preview"), m).environmentId).toBe("preview");
    expect(resolvePlacement(gh("Production – web"), m).environmentId).toBe("production");
    expect(resolvePlacement(gh("prod"), m).environmentId).toBe("production");
    expect(resolvePlacement(gh("staging"), m).environmentId).toBe("staging");
    expect(resolvePlacement(gh("Preview – web"), m).environmentId).toBe("preview");
    expect(resolvePlacement(gh("github-pages"), m)).toMatchObject({
      environmentId: null,
      confidence: "unmapped",
      matchedRuleIds: [],
    });
    // ArgoCD: application suffix.
    expect(resolvePlacement(argo(), m).environmentId).toBe("production");
    expect(resolvePlacement(argo({ application: "web", name: "web" }), m).environmentId).toBeNull();
  });

  it("tenant rules win over built-ins, lower priority first, and set the service", () => {
    const m = compileMapping(
      config([
        rule("r-late", {
          field: "github.environment",
          match: "glob",
          pattern: "Production*",
          targetId: "staging",
          priority: 20,
        }),
        rule("r-early", {
          field: "github.environment",
          match: "regex",
          pattern: "^production – ",
          targetId: "production",
          priority: 10,
        }),
        rule("s-web", {
          kind: "service",
          field: "github.repository",
          pattern: "ACME/web",
          targetId: "web",
        }),
      ]),
    );
    expect(resolvePlacement(gh("Production – web"), m)).toEqual({
      serviceId: "web",
      environmentId: "production",
      matchedRuleIds: ["s-web", "r-early"],
      confidence: "configured",
      service: { ruleId: "s-web", builtIn: false, field: "github.repository", value: "acme/web" },
      environment: {
        ruleId: "r-early",
        builtIn: false,
        field: "github.environment",
        value: "Production – web",
      },
    });
    // A tenant rule overrides the built-in for "production" itself.
    expect(resolvePlacement(gh("Production"), m).environmentId).toBe("staging");
    expect(resolvePlacement(gh("production", "acme/api"), m).confidence).toBe("partial");
  });

  it("disabled built-ins and rules with a missing target never apply", () => {
    const m = compileMapping(
      config(
        [
          rule("off", {
            field: "vercel.target",
            pattern: "production",
            targetId: "staging",
            enabled: false,
          }),
          rule("ghost", { field: "vercel.target", pattern: "production", targetId: "nope" }),
        ],
        {
          builtinOverrides: {
            "builtin:vercel-target-production": false,
            "builtin:vercel-environment-production": false,
          },
        },
      ),
    );
    expect(resolvePlacement(vercel("production"), m).environmentId).toBeNull();
    expect(m.inactive.map((i) => i.ruleId)).toEqual(
      expect.arrayContaining(["off", "ghost", "builtin:vercel-target-production"]),
    );
    // Without environments, built-ins have no target: everything is unmapped (not guessed).
    const empty = compileMapping({ services: [], environments: [], rules: [] });
    expect(resolvePlacement(vercel("production"), empty).confidence).toBe("unmapped");
  });

  it("case sensitivity and label rules", () => {
    const m = compileMapping(
      config([
        rule("cs", {
          field: "argocd.project",
          pattern: "Payments",
          caseSensitive: true,
          targetId: "development",
        }),
        rule("lbl", {
          kind: "service",
          field: "argocd.label:app.kubernetes.io/part-of",
          pattern: "api",
          targetId: "api",
        }),
      ]),
    );
    expect(m.usesLabels).toBe(true);
    expect(resolvePlacement(argo({ project: "payments" }), m).environment?.ruleId).not.toBe("cs");
    expect(resolvePlacement(argo({ project: "Payments" }), m).environment?.ruleId).toBe("cs");
    expect(resolvePlacement(argo({}, { "app.kubernetes.io/part-of": "api" }), m).serviceId).toBe(
      "api",
    );
    expect(resolvePlacement(argo(), m).serviceId).toBeNull();
  });

  it("resolves thousands of events quickly and returns independent results", () => {
    const rules: MappingRule[] = [];
    for (let i = 0; i < 200; i++) {
      rules.push(
        rule(`r${i}`, {
          field: "argocd.application",
          match: "regex",
          pattern: `^app-${i}-(prod|stg)$`,
          targetId: "production",
          priority: i,
        }),
      );
    }
    const m = compileMapping(config(rules));
    const events = Array.from({ length: 5000 }, (_, i) =>
      argo({ application: `app-${i % 300}-prod`, name: `app-${i % 300}-prod` }),
    );
    const started = performance.now();
    const out = events.map((e) => resolvePlacement(e, m));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(out[5]!.environment?.ruleId).toBe("r5");
    expect(out[250]!.environment?.ruleId).toBe("builtin:argocd-application-production");
    out[5]!.matchedRuleIds.push("mutated");
    expect(resolvePlacement(events[5]!, m).matchedRuleIds).toEqual(["r5"]);
  });

  it("built-in rule ids are unique and target default environments", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of BUILTIN_RULES) {
      expect(DEFAULT_ENVIRONMENTS.some((e) => e.id === r.targetId)).toBe(true);
    }
  });
});

describe("validation", () => {
  it("rejects bad fields and unsafe patterns with a readable error", () => {
    const ok = ruleInputSchema.safeParse({
      kind: "environment",
      field: "github.environment",
      match: "regex",
      pattern: "^prod",
      targetId: "production",
    });
    expect(ok.success).toBe(true);
    const bad = ruleInputSchema.safeParse({
      kind: "environment",
      field: "github.environment",
      match: "regex",
      pattern: "(a)\\1",
      targetId: "production",
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toMatch(/backreferences/);
    expect(
      ruleInputSchema.safeParse({
        kind: "service",
        field: "x.y",
        match: "exact",
        pattern: "a",
        targetId: "web",
      }).success,
    ).toBe(false);
  });

  it("slugifies names", () => {
    expect(slugify("Payments API")).toBe("payments-api");
    expect(slugify("Prod – EU (west)")).toBe("prod-eu-west");
    expect(slugify("Ünïcode")).toBe("unicode");
    expect(slugify("–")).toBe("item");
  });
});
