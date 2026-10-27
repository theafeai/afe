/**
 * Production behaviour of `@afe/core/correlation` added in AFE-20: bounded
 * linking of hot keys, artifacts with late provenance, conflicts, gaps,
 * single-commit journeys with "continues as", and containment enrichment.
 */
import { describe, expect, it } from "vitest";
import {
  applyContainment,
  buildCorrelationGraph,
  buildJourney,
  buildLinks,
  containmentCandidates,
  GapIndex,
  gapsFromEvents,
  isCorrelationRelevant,
  placementKind,
  ShaPrefixIndex,
  type CorrelationEvent,
} from "../src/correlation/index.ts";
import type { Correlation } from "../src/index.ts";

const sha = (c: string) => c.repeat(40);
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const APP = "github.com/acme/app";
const DEPLOY = "github.com/acme/deploy";

let seq = 0;
function ev(
  partial: Partial<CorrelationEvent> & { action: string; correlation: Correlation },
): CorrelationEvent {
  seq++;
  return {
    id: partial.id ?? `e${String(seq).padStart(4, "0")}`,
    source: partial.source ?? "github",
    actor: { type: "system" },
    target: partial.target ?? { type: "other", id: "x" },
    trigger: partial.trigger ?? { type: "unknown" },
    outcome: partial.outcome ?? "succeeded",
    occurredAt: partial.occurredAt ?? new Date(Date.UTC(2026, 9, 20, 10, 0, seq)).toISOString(),
    data: partial.data ?? {},
    ...partial,
  } as CorrelationEvent;
}

const argoSync = (
  app: string,
  env: string,
  c: Correlation,
  extra: Partial<CorrelationEvent> = {},
) =>
  ev({
    source: "argocd",
    action: "argocd.sync.succeeded",
    target: { type: "application", id: `argocd/${app}`, application: app, environment: env },
    trigger: { type: "auto_sync" },
    correlation: c,
    ...extra,
  });

describe("hot keys are linked in linear size", () => {
  it("chains a large bucket and links every member to the first", () => {
    const events = Array.from({ length: 200 }, () =>
      ev({
        action: "argocd.health.changed",
        correlation: { commitShas: [sha("c")], repositories: [DEPLOY] },
      }),
    );
    const { links } = buildLinks(events, { pairwiseLimit: 24 });
    expect(links.length).toBe(199 + 198); // chain + first
    // Every member is reachable forward from the first.
    const adj = new Map<string, string[]>();
    for (const l of links) adj.set(l.from, [...(adj.get(l.from) ?? []), l.to]);
    const seen = new Set([events[0]!.id]);
    const q = [events[0]!.id];
    while (q.length)
      for (const n of adj.get(q.shift()!) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          q.push(n);
        }
    expect(seen.size).toBe(200);
    expect(links.every((l) => l.evidence[0]!.kind === "same_commit_same_repo")).toBe(true);
  });

  it("links a busy mutable tag to the recent builds only, and reports the moved tag once", () => {
    const events: CorrelationEvent[] = [];
    for (let i = 0; i < 30; i++) {
      const d = `sha256:${String(i).padStart(64, "0")}`;
      events.push(
        ev({
          action: "artifact.published",
          correlation: {
            imageRefs: [`r/w:latest@${d}`],
            imageDigests: [d],
            commitShas: [sha(String(i % 10))],
            repositories: [APP],
          },
        }),
      );
      events.push(argoSync("w", "staging", { imageRefs: ["r/w:latest"] }));
    }
    const { links, conflicts } = buildLinks(events, { pairwiseLimit: 24, maxTagBuilds: 5 });
    const last = events.at(-1)!;
    const toLast = links.filter(
      (l) => l.to === last.id && l.evidence.some((e) => e.key === "image:r/w:latest"),
    );
    expect(toLast).toHaveLength(5);
    expect(toLast.every((l) => l.confidence === "weak")).toBe(true);
    expect(conflicts.filter((c) => c.kind === "tag_digest_mismatch").length).toBe(29);
  });
});

describe("artifacts", () => {
  it("attributes through artifact.provenance_resolved when the published event had no commit", () => {
    const published = ev({
      action: "artifact.published",
      correlation: {
        imageRefs: [`ghcr.io/acme/app:v1@${D1}`],
        imageDigests: [D1],
        repositories: [APP],
      },
    });
    const sync = argoSync("app-staging", "staging", {
      imageRefs: [`ghcr.io/acme/app:v1@${D1}`],
      commitShas: [sha("c")],
      repositories: [DEPLOY],
    });
    // Provenance found after the deployment: still the same artifact (digest).
    const provenance = ev({
      action: "artifact.provenance_resolved",
      correlation: {
        imageRefs: [`ghcr.io/acme/app:v1@${D1}`],
        imageDigests: [D1],
        commitShas: [sha("a")],
        runIds: ["github:9"],
        repositories: [APP],
      },
    });
    const g = buildCorrelationGraph([published, sync, provenance]);
    const p = g.environments[0]!.current;
    expect(p.commits).toEqual([
      expect.objectContaining({ commitSha: sha("a"), confidence: "strong" }),
    ]);
    expect(p.attribution).toEqual({ status: "attributed", confidence: "strong" });
    expect(p.evidenceEventIds).toEqual([provenance.id]);
    expect(p.configRevision).toEqual({ repository: DEPLOY, commitSha: sha("c") });
  });

  it("reports builds of one digest that claim different commits", () => {
    const a = ev({
      action: "artifact.published",
      correlation: { imageDigests: [D2], commitShas: [sha("a")] },
    });
    const b = ev({
      action: "artifact.provenance_resolved",
      correlation: { imageDigests: [D2], commitShas: [sha("b")] },
    });
    const { conflicts } = buildLinks([a, b]);
    expect(conflicts).toEqual([
      expect.objectContaining({
        kind: "digest_commit_mismatch",
        key: `digest:${D2}`,
        events: [a.id, b.id],
      }),
    ]);
  });
});

describe("placements", () => {
  it("classifies how a placement happened", () => {
    const k = (action: string, trigger: string) =>
      placementKind(ev({ action, trigger: { type: trigger as "manual" }, correlation: {} }));
    expect(k("deployment.rolled_back", "unknown")).toBe("rollback");
    expect(k("deployment.promoted", "unknown")).toBe("promotion");
    expect(k("deployment.status_updated", "redeploy")).toBe("redeploy");
    expect(k("argocd.sync.succeeded", "cli")).toBe("manual");
    expect(k("argocd.sync.succeeded", "auto_sync")).toBe("deploy");
  });

  it("only counts events with correlation keys or gaps", () => {
    expect(isCorrelationRelevant(ev({ action: "pull_request.opened", correlation: {} }))).toBe(
      false,
    );
    expect(
      isCorrelationRelevant(
        ev({
          action: "x.y",
          correlation: {},
          data: { correlationHints: { deploymentUrls: ["a.vercel.app"] } },
        }),
      ),
    ).toBe(true);
    expect(isCorrelationRelevant(ev({ action: "observation_gap.opened", correlation: {} }))).toBe(
      true,
    );
  });

  it("finds unique SHA prefixes", () => {
    const idx = new ShaPrefixIndex([sha("a"), `ab${"0".repeat(38)}`, sha("b")]);
    expect(idx.unique("bbbbbbb")).toBe(sha("b"));
    expect(idx.unique("a")).toBeUndefined(); // ambiguous
    expect(idx.unique("ccccccc")).toBeUndefined();
  });
});

describe("observation gaps", () => {
  const gapEvent = (action: string, at: string, gap: Record<string, unknown>) =>
    ev({
      source: "afe",
      action,
      occurredAt: at,
      correlation: {},
      data: { gap } as CorrelationEvent["data"],
    });
  const base = {
    gapId: "g1",
    connectionId: "c1",
    source: "argocd",
    startedAt: "2026-10-20T10:00:00.000Z",
    reason: "auth_failed",
  };

  it("merges opened/closed events and flags evidence inside and gaps after", () => {
    const gaps = gapsFromEvents([
      gapEvent("observation_gap.opened", base.startedAt, { ...base, endedAt: null }),
      gapEvent("observation_gap.closed", "2026-10-20T11:00:00.000Z", {
        ...base,
        endedAt: "2026-10-20T11:00:00.000Z",
      }),
    ]);
    expect(gaps).toEqual([{ ...base, endedAt: "2026-10-20T11:00:00.000Z" }]);
    const idx = new GapIndex(gaps, "2026-10-27T00:00:00.000Z");
    const inside = argoSync(
      "a",
      "prod",
      {},
      { occurredAt: "2026-10-20T10:30:00.000Z", connectionId: "c1" },
    );
    const before = argoSync(
      "a",
      "prod",
      {},
      { occurredAt: "2026-10-20T09:00:00.000Z", connectionId: "c1" },
    );
    const otherConn = argoSync(
      "a",
      "prod",
      {},
      { occurredAt: "2026-10-20T10:30:00.000Z", connectionId: "c2" },
    );
    expect(idx.flags(inside, [], false).map((f) => f.relation)).toEqual(["evidence_in_gap"]);
    // The gap is closed (and was backfilled), so it no longer makes the placement stale.
    expect(idx.flags(before, [], true)).toEqual([]);
    expect(idx.flags(otherConn, [], true)).toEqual([]);

    // While a gap is open, what is live may be stale.
    const open = new GapIndex([{ ...base, endedAt: null }], "2026-10-27T00:00:00.000Z");
    expect(open.flags(before, [], true).map((f) => f.relation)).toEqual(["after_placement"]);
    expect(open.flags(before, [], false)).toEqual([]);
    expect(open.flags(otherConn, [], true)).toEqual([]);
  });
});

describe("buildJourney", () => {
  it("returns undefined for an unknown commit and records how the change continues", () => {
    const push = ev({
      action: "ref.pushed",
      correlation: { commitShas: [sha("1"), sha("2")], repositories: [APP] },
      data: { headCommit: sha("2") },
    });
    const merged = ev({
      action: "pull_request.merged",
      correlation: { commitShas: [sha("2"), sha("3")], repositories: [APP] },
    });
    const g = buildCorrelationGraph([push, merged]);
    expect(buildJourney(g, APP, sha("9"))).toBeUndefined();
    const j1 = buildJourney(g, APP, sha("1"))!;
    expect(j1.continuesAs.map((c) => [c.commitSha, c.relation])).toEqual([
      [sha("2"), "included_in"],
      [sha("3"), "later_commit"],
    ]);
    const j2 = buildJourney(g, APP, sha("2"))!;
    expect(j2.continuesAs.map((c) => [c.commitSha, c.relation])).toEqual([[sha("3"), "merged_as"]]);
    expect(j2.rootEventId).toBe(push.id);
  });

  it("stops at maxSteps and marks the journey truncated", () => {
    const events = [
      ev({
        action: "ref.pushed",
        correlation: { commitShas: [sha("1")], repositories: [APP], runIds: ["github:1"] },
      }),
      ...Array.from({ length: 20 }, () =>
        ev({ action: "workflow_job.completed", correlation: { runIds: ["github:1"] } }),
      ),
    ];
    const j = buildJourney(buildCorrelationGraph(events), APP, sha("1"), { maxSteps: 5 })!;
    expect(j.steps).toHaveLength(5);
    expect(j.truncated).toBe(true);
  });

  it("adds environments where the live commit contains this one (containment hook)", () => {
    const pushA = ev({
      action: "ref.pushed",
      correlation: { commitShas: [sha("a")], repositories: [APP] },
      data: { headCommit: sha("a") },
    });
    const pushB = ev({
      action: "ref.pushed",
      correlation: { commitShas: [sha("b")], repositories: [APP] },
      data: { headCommit: sha("b") },
    });
    const deployB = ev({
      source: "vercel",
      action: "deployment.status_updated",
      target: { type: "project", id: "prj", project: "app", environment: "production" },
      correlation: { commitShas: [sha("b")], repositories: [APP], deploymentIds: ["vercel:dpl_b"] },
    });
    const g = buildCorrelationGraph([pushA, pushB, deployB]);
    const j = buildJourney(g, APP, sha("a"))!;
    expect(j.environments).toEqual([]);
    const candidates = containmentCandidates(g, j);
    expect(candidates).toEqual([{ placementEventId: deployB.id, liveCommitSha: sha("b") }]);
    const enriched = applyContainment(g, j, [
      { ...candidates[0]!, contained: true, reason: "ancestor" },
    ]);
    expect(enriched.environments).toEqual([
      expect.objectContaining({
        placementEventId: deployB.id,
        via: "containment",
        confidence: "certain",
        current: true,
      }),
    ]);
    expect(
      applyContainment(g, j, [{ ...candidates[0]!, contained: "unknown", reason: "x" }])
        .environments,
    ).toEqual([]);
  });
});
