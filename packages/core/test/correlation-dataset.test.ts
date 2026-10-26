/**
 * Runs the correlation prototype over the AFE-15 synthetic dataset
 * (docs/research/prototypes/synthetic-dataset.ts) and pins the findings the
 * research doc relies on.
 */
import { describe, expect, it } from "vitest";
import { C, DG, loadSyntheticEvents } from "../../../docs/research/prototypes/synthetic-dataset.ts";
import { buildJourneys, buildLinks, deriveEnvironmentStates } from "../src/correlation/index.ts";

const events = loadSyntheticEvents();
const { links, conflicts } = buildLinks(events);
const envs = deriveEnvironmentStates(events, links);
const journeys = buildJourneys(events, links, envs);
const env = (key: string) => envs.find((e) => e.key === key)!;
const journey = (sha: string) => journeys.find((j) => j.commitSha === sha)!;
const commits = (key: string) =>
  env(key).current.commits.map((c) => [c.commitSha, c.confidence] as const);

describe("synthetic dataset", () => {
  it("validates against the canonical event schema", () => {
    expect(events.length).toBeGreaterThan(60);
  });

  it("(a) GitOps: staging by tag (probable), production by digest (strong)", () => {
    expect(commits("argocd:argocd/shop-api-staging")).toEqual([[C.B, "probable"]]);
    const a = journey(C.A);
    expect(a.environments.map((e) => [e.environmentKey, e.confidence])).toEqual([
      ["argocd:argocd/shop-api-staging", "probable"],
      ["argocd:argocd/shop-api-production", "strong"],
    ]);
    expect(journey(C.D).environments).toEqual([]);
  });

  it("(c) manual image override: production traces to no commit, A's journey excludes it", () => {
    const prod = env("argocd:argocd/shop-api-production");
    expect(prod.current.how).toBe("manual");
    expect(prod.current.commits).toEqual([]);
    expect(prod.current.configRevision?.commitSha).toBe(C.C2);
    expect(journey(C.A).excluded.map((x) => x.eventId)).toContain(prod.current.eventId);
  });

  it("(d) mutable tag: production restart is ambiguous between two commits", () => {
    expect(commits("argocd:argocd/worker-production")).toEqual([
      [C.W, "weak"],
      [C.W2, "weak"],
    ]);
    expect(env("argocd:argocd/worker-production").history[0]!.commits).toEqual([
      expect.objectContaining({ commitSha: C.W, confidence: "probable" }),
    ]);
    expect(commits("argocd:argocd/worker-staging")).toEqual([[C.W2, "strong"]]);
    expect(conflicts.some((c) => c.key === "image:ghcr.io/acme/worker:1.4")).toBe(true);
    expect(env("argocd:argocd/worker-staging").current.images[0]?.digest).toBe(DG.DW2);
  });

  it("(b, c) Vercel: rollback, promote, redeploy, then a CLI deploy that is only a guess", () => {
    const prod = env("vercel:web:production");
    expect(prod.history.map((p) => p.how)).toEqual([
      "push",
      "push",
      "rollback",
      "promotion",
      "redeploy",
      "push",
      "cli",
    ]);
    expect(prod.history[2]!.commits[0]).toMatchObject({ commitSha: C.M1, confidence: "certain" });
    expect(commits("vercel:web:production")).toEqual([[C.M4, "weak"]]);
    expect(journey(C.P1).relatedJourneys).toEqual([`github.com/acme/web@${C.M1}`]);
  });
});
