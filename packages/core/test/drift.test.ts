/**
 * Drift detection (AFE-26) over the AFE-15/AFE-20 scenarios (synthetic
 * dataset: manual ArgoCD override, Vercel rollback and CLI deploy, mutable
 * tag) and focused event sequences in the connectors' real shapes.
 */
import { describe, expect, it } from "vitest";
import { C, loadSyntheticEvents } from "../../../docs/research/prototypes/synthetic-dataset.ts";
import { buildCorrelationGraph, type CorrelationEvent } from "../src/correlation/index.ts";
import {
  DEFAULT_DRIFT_SEVERITY,
  detectDrift,
  driftFindingOpened,
  driftFindingResolved,
  isMutableTag,
  overrideChange,
  parseDriftTypeList,
  severityOf,
  type DetectedFinding,
} from "../src/drift/index.ts";
import { parseEventInput, type Correlation } from "../src/index.ts";

const detect = (events: CorrelationEvent[]) => {
  const g = buildCorrelationGraph(events);
  return detectDrift({ environments: g.environments, conflicts: g.conflicts, events: g.events });
};
const of = (fs: DetectedFinding[], type: string, target?: string) =>
  fs.filter((f) => f.type === type && (!target || f.target.key === target));

describe("synthetic dataset (AFE-15 scenarios)", () => {
  const events = loadSyntheticEvents();
  const findings = detect(events);

  it("(c) manual ArgoCD image override: open manual_override, no duplicate unknown_image", () => {
    const [f, ...rest] = of(findings, "manual_override");
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      status: "open",
      target: { key: "argocd:argocd/shop-api-production", source: "argocd" },
      title: "Manual image override on shop-api-production",
    });
    expect(f!.explanation).toContain("ghcr.io/acme/shop-api:hotfix-1022");
    expect(f!.evidence.map((e) => e.role)).toEqual(["override", "placement"]);
    expect(of(findings, "unknown_image", "argocd:argocd/shop-api-production")).toEqual([]);
  });

  it("(c) Vercel CLI deploy without Git: open untracked_deploy with the weak guess", () => {
    const [f] = of(findings, "untracked_deploy", "vercel:web:production");
    expect(f).toMatchObject({ status: "open", details: { how: "cli" } });
    expect(f!.explanation).toContain("only guess");
    expect(f!.evidence.map((e) => e.role).sort()).toEqual(["placement", "related"]);
  });

  it("(d) mutable tag rebuilt: ambiguous_attribution opens at the restart, not before", () => {
    const [f, ...rest] = of(findings, "ambiguous_attribution", "argocd:argocd/worker-production");
    expect(rest).toEqual([]);
    expect(f!.status).toBe("open");
    const prod = buildCorrelationGraph(events).environments.find(
      (s) => s.key === "argocd:argocd/worker-production",
    )!;
    expect(f!.openingEventId).toBe(prod.current.eventId);
    expect(f!.explanation).toContain(C.W.slice(0, 12));
    expect(f!.explanation).toContain(C.W2.slice(0, 12));
    expect(f!.evidence.some((e) => e.role === "conflict")).toBe(true);
  });

  it("(b) Vercel rollback: out_of_band_change resolved by the next promotion", () => {
    const [f] = of(findings, "out_of_band_change", "vercel:web:production");
    expect(f).toMatchObject({ status: "resolved" });
    expect(f!.resolvedByEventId).toBeTruthy();
    expect(f!.evidence.map((e) => e.role)).toEqual(["git_deploy", "placement", "resolution"]);
  });

  it("is deterministic: same keys and content on every evaluation, no duplicate keys", () => {
    const again = detect([...events].reverse());
    expect(again).toEqual(findings);
    expect(new Set(findings.map((f) => f.key)).size).toBe(findings.length);
  });

  it("can be limited to some types", () => {
    const g = buildCorrelationGraph(events);
    const only = detectDrift(
      { environments: g.environments, conflicts: g.conflicts, events: g.events },
      { types: ["untracked_deploy"] },
    );
    expect(new Set(only.map((f) => f.type))).toEqual(new Set(["untracked_deploy"]));
  });
});

// ---------------------------------------------------------------------------
// Focused sequences
// ---------------------------------------------------------------------------

const sha = (c: string) => c.repeat(40);
const dg = (c: string) => `sha256:${c.repeat(64)}`;
let n = 0;
function ev(
  partial: Partial<CorrelationEvent> & { action: string; correlation: Correlation },
  minute: number,
): CorrelationEvent {
  n++;
  return {
    id: `e${String(n).padStart(4, "0")}`,
    source: "github",
    actor: { type: "user", login: "alice" },
    target: { type: "other", id: "x" },
    trigger: { type: "unknown" },
    outcome: "succeeded",
    occurredAt: new Date(Date.UTC(2026, 9, 20, 10, minute)).toISOString(),
    data: {},
    ...partial,
  } as CorrelationEvent;
}
const APP_TARGET = {
  type: "application" as const,
  id: "argocd/api-prod",
  application: "api-prod",
  environment: "production",
};
const build = (commit: string, digest: string, minute: number, tag = "ghcr.io/acme/api:v1") =>
  ev(
    {
      action: "artifact.published",
      trigger: { type: "push" },
      correlation: {
        repositories: ["github.com/acme/api"],
        commitShas: [commit],
        imageRefs: [tag],
        imageDigests: [digest],
      },
    },
    minute,
  );
const sync = (ref: string, digest: string | null, minute: number, trigger = "auto_sync") =>
  ev(
    {
      source: "argocd",
      action: "argocd.sync.succeeded",
      target: APP_TARGET,
      trigger: { type: trigger as "auto_sync" },
      correlation: {
        repositories: ["github.com/acme/deploy"],
        commitShas: [sha("d")],
        imageRefs: [ref],
        ...(digest ? { imageDigests: [digest] } : {}),
      },
    },
    minute,
  );
const appUpdated = (
  change: Record<string, unknown>,
  minute: number,
  refs: string[] = [],
  trigger = "manual",
) =>
  ev(
    {
      source: "argocd",
      action: "argocd.application.updated",
      target: APP_TARGET,
      trigger: { type: trigger as "manual" },
      outcome: "succeeded",
      correlation: { repositories: ["github.com/acme/deploy"], imageRefs: refs },
      data: { change: change as never },
    },
    minute,
  );

describe("manual_override (connector shape)", () => {
  const hotfix = "ghcr.io/acme/api:hotfix";
  const field = `source.kustomize.images=${hotfix}`;

  it("opens on the override, keeps the syncs as evidence, resolves after removal + sync", () => {
    const events = [
      build(sha("a"), dg("1"), 0),
      sync("ghcr.io/acme/api:v1", dg("1"), 1),
      appUpdated({ fields: ["source.kustomize"], imageOverrides: [field] }, 2, [hotfix]),
      sync(hotfix, dg("9"), 3, "manual"),
      sync(hotfix, dg("9"), 4, "manual"),
      appUpdated({ fields: ["source.kustomize"], removedImageOverrides: [field] }, 5),
      sync("ghcr.io/acme/api:v1", dg("1"), 6),
    ];
    const fs = detect(events);
    const [f, ...rest] = of(fs, "manual_override");
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      status: "resolved",
      openingEventId: events[2]!.id,
      resolvedByEventId: events[6]!.id,
      firstSeenAt: events[2]!.occurredAt,
      lastSeenAt: events[5]!.occurredAt,
      details: { overrideFields: [field], imageRefs: [hotfix], syncs: 2 },
    });
    expect(f!.evidence.map((e) => [e.role, e.eventId])).toEqual([
      ["override", events[2]!.id],
      ["placement", events[3]!.id],
      ["placement", events[4]!.id],
      ["override", events[5]!.id],
      ["resolution", events[6]!.id],
    ]);
    // The unknown hotfix image is explained by the override: no unknown_image.
    expect(of(fs, "unknown_image")).toEqual([]);
  });

  it("stays open while the override is set; removal without a sync is noted", () => {
    const events = [
      appUpdated({ imageOverrides: [field] }, 1, [hotfix]),
      sync(hotfix, dg("9"), 2, "manual"),
      appUpdated({ removedImageOverrides: [field] }, 3),
    ];
    const [f] = of(detect(events), "manual_override");
    expect(f!.status).toBe("open");
    expect(f!.explanation).toContain("removed but no sync has replaced it yet");
  });

  it("ignores changes made by a parent app-of-apps (they come from Git)", () => {
    const events = [appUpdated({ imageOverrides: [field] }, 1, [hotfix], "upstream")];
    expect(of(detect(events), "manual_override")).toEqual([]);
  });

  it("reads override changes from every known shape", () => {
    const base = { ...appUpdated({}, 0), data: {} } as CorrelationEvent;
    expect(overrideChange({ ...base, data: { change: "spec.source.kustomize.images" } })).toEqual({
      added: ["spec.source.kustomize.images"],
      removed: [],
    });
    expect(overrideChange({ ...base, data: { change: "spec.syncPolicy" } }).added).toEqual([]);
    expect(
      overrideChange({ ...base, data: { change: { fields: ["source.helm.parameters"] } } }).added,
    ).toEqual(["source.helm.parameters"]);
    expect(
      overrideChange({
        ...base,
        action: "argocd.application.created",
        data: { spec: { imageOverrides: [field] } },
      }).added,
    ).toEqual([field]);
  });
});

describe("untracked_deploy, unknown_image, out_of_band_change", () => {
  const vercel = (minute: number, commit: string | null, trigger: string) =>
    ev(
      {
        source: "vercel",
        action: "deployment.status_updated",
        target: {
          type: "deployment",
          id: `dpl_${minute}`,
          project: "web",
          environment: "production",
        },
        trigger: { type: trigger as "push" },
        correlation: {
          deploymentIds: [`vercel:dpl_${minute}`],
          ...(commit ? { commitShas: [commit], repositories: ["github.com/acme/web"] } : {}),
        },
      },
      minute,
    );

  it("one untracked_deploy per episode of CLI deploys, resolved by the next Git deploy", () => {
    const events = [
      vercel(0, sha("1"), "push"),
      vercel(1, null, "cli"),
      vercel(2, null, "cli"),
      vercel(3, sha("2"), "push"),
      vercel(4, null, "cli"),
    ];
    const fs = of(detect(events), "untracked_deploy");
    expect(fs.map((f) => [f.status, f.openingEventId, f.resolvedByEventId])).toEqual([
      ["resolved", events[1]!.id, events[3]!.id],
      ["open", events[4]!.id, null],
    ]);
    expect(fs[0]!.evidence.filter((e) => e.role === "placement")).toHaveLength(2);
    expect(fs[0]!.lastSeenAt).toBe(events[2]!.occurredAt);
  });

  it("unknown_image for an image no build produced (mutable tag flagged), resolved by a built image", () => {
    const events = [
      sync("ghcr.io/acme/api:latest", null, 1),
      build(sha("a"), dg("1"), 2),
      sync("ghcr.io/acme/api:v1", dg("1"), 3),
    ];
    const [f] = of(detect(events), "unknown_image");
    expect(f).toMatchObject({
      status: "resolved",
      resolvedByEventId: events[2]!.id,
      details: { unknownImages: [{ ref: "ghcr.io/acme/api:latest", mutableTag: true }] },
    });
    expect(f!.explanation).toContain("mutable");
  });

  it("out_of_band_change for a manual sync to other Git content; same content is not drift", () => {
    const events = [
      build(sha("a"), dg("1"), 0),
      build(sha("b"), dg("2"), 1, "ghcr.io/acme/api:v2"),
      sync("ghcr.io/acme/api:v2", dg("2"), 2),
      sync("ghcr.io/acme/api:v2", dg("2"), 3, "manual"),
      sync("ghcr.io/acme/api:v1", dg("1"), 4, "manual"),
    ];
    const fs = detect(events);
    const [f, ...rest] = of(fs, "out_of_band_change");
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ status: "open", openingEventId: events[4]!.id });
    expect(f!.evidence.find((e) => e.role === "git_deploy")?.eventId).toBe(events[2]!.id);
  });
});

describe("settings and events", () => {
  it("parses AFE_DRIFT_ALERTS", () => {
    expect(parseDriftTypeList(undefined)).toEqual([]);
    expect(parseDriftTypeList(" manual_override, untracked_deploy ")).toEqual([
      "manual_override",
      "untracked_deploy",
    ]);
    expect(parseDriftTypeList("all")).toHaveLength(5);
    expect(() => parseDriftTypeList("manual_overide")).toThrow(/unknown drift finding type/);
  });

  it("severity: tenant override, built-in default, else medium", () => {
    expect(severityOf("manual_override")).toBe(DEFAULT_DRIFT_SEVERITY.manual_override);
    expect(severityOf("manual_override", { manual_override: "critical" })).toBe("critical");
    expect(severityOf("custom_type")).toBe("medium");
  });

  it("isMutableTag", () => {
    expect(isMutableTag("latest")).toBe(true);
    expect(isMutableTag("v1.2.3")).toBe(false);
    expect(isMutableTag(undefined)).toBe(false);
  });

  it("drift.finding.* events are valid canonical events with deterministic keys", () => {
    const data = {
      id: "00000000-0000-8000-8000-000000000001",
      type: "manual_override",
      severity: "high" as const,
      title: "Manual image override on api-prod",
      explanation: "x",
      targetKey: "argocd:argocd/api-prod",
      targetLabel: "api-prod",
      targetSource: "argocd",
      toolEnvironment: "production",
      service: "api",
      environment: "production",
      firstSeenAt: "2026-10-20T10:00:00.000Z",
      resolvedAt: "2026-10-21T10:00:00.000Z",
      openingEventId: "e1",
      resolvedByEventId: "e2",
      evidenceEventIds: ["e1", "e2"],
    };
    const opened = parseEventInput(driftFindingOpened(data));
    const resolved = parseEventInput(driftFindingResolved(data));
    expect(opened.action).toBe("drift.finding.opened");
    expect(opened.occurredAt).toBe(data.firstSeenAt);
    expect(resolved.occurredAt).toBe(data.resolvedAt);
    expect(opened.sourceEventId).toBe(`drift_finding:${data.id}:opened`);
    expect(resolved.sourceEventId).toBe(`drift_finding:${data.id}:resolved`);
  });
});
