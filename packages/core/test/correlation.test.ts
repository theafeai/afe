import { describe, expect, it } from "vitest";
import {
  buildJourneys,
  buildLinks,
  commitPrefixFromTag,
  deriveEnvironmentStates,
  parseImageRef,
  type CorrelationEvent,
  type Link,
} from "../src/correlation/index.ts";
import type { Correlation } from "../src/index.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const CFG = "c".repeat(40);
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
    id: partial.id ?? `e${seq}`,
    source: partial.source ?? "github",
    actor: { type: "system" },
    target: partial.target ?? { type: "other", id: "x" },
    trigger: partial.trigger ?? { type: "unknown" },
    outcome: partial.outcome ?? "succeeded",
    occurredAt: partial.occurredAt ?? `2026-10-20T10:${String(seq).padStart(2, "0")}:00.000Z`,
    data: partial.data ?? {},
    ...partial,
  } as CorrelationEvent;
}

function linkBetween(links: Link[], a: string, b: string): Link | undefined {
  return links.find((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a));
}

describe("helpers", () => {
  it("parses image references", () => {
    expect(parseImageRef("ghcr.io/acme/api:1.2")).toEqual({ name: "ghcr.io/acme/api", tag: "1.2" });
    expect(parseImageRef(`localhost:5000/api:dev@${D1}`)).toEqual({
      name: "localhost:5000/api",
      tag: "dev",
      digest: D1,
    });
    expect(parseImageRef("localhost:5000/api")).toEqual({ name: "localhost:5000/api" });
  });
  it("reads commit prefixes from tags", () => {
    expect(commitPrefixFromTag("sha-4f2c9b8")).toBe("4f2c9b8");
    expect(commitPrefixFromTag(A)).toBe(A);
    expect(commitPrefixFromTag("1.4")).toBeUndefined();
  });
});

describe("buildLinks", () => {
  it("grades evidence: same commit+repo certain, other repo strong, digest strong, tag probable", () => {
    const push = ev({
      action: "ref.pushed",
      correlation: { commitShas: [A], repositories: [APP] },
    });
    const run = ev({
      action: "workflow_run.completed",
      correlation: { commitShas: [A], repositories: [APP], runIds: ["github:1"] },
    });
    const mirror = ev({
      action: "ref.pushed",
      correlation: { commitShas: [A], repositories: ["gitlab.com/acme/app"] },
    });
    const build = ev({
      action: "artifact.published",
      correlation: {
        commitShas: [A],
        repositories: [APP],
        imageRefs: ["r/app:v1"],
        imageDigests: [D1],
      },
    });
    const pinned = ev({
      source: "argocd",
      action: "argocd.sync.succeeded",
      correlation: {
        commitShas: [CFG],
        repositories: [DEPLOY],
        imageRefs: ["r/app:v1"],
        imageDigests: [D1],
      },
    });
    const byTag = ev({
      source: "argocd",
      action: "argocd.sync.succeeded",
      correlation: { commitShas: [CFG], repositories: [DEPLOY], imageRefs: ["r/app:v1"] },
    });
    const { links } = buildLinks([push, run, mirror, build, pinned, byTag]);
    expect(linkBetween(links, push.id, run.id)?.confidence).toBe("certain");
    expect(linkBetween(links, push.id, mirror.id)?.confidence).toBe("strong");
    expect(linkBetween(links, build.id, pinned.id)?.confidence).toBe("strong");
    const tagLink = linkBetween(links, build.id, byTag.id)!;
    expect(tagLink.confidence).toBe("probable");
    expect(tagLink.evidence.map((e) => e.kind)).toEqual(["same_image_tag"]);
    expect(tagLink.from).toBe(build.id); // earlier -> later
  });

  it("treats a tag produced by several builds as weak and reports digest conflicts", () => {
    const b1 = ev({
      action: "artifact.published",
      correlation: {
        commitShas: [A],
        repositories: [APP],
        imageRefs: ["r/w:1.4"],
        imageDigests: [D1],
      },
    });
    const early = ev({
      source: "argocd",
      action: "argocd.sync.succeeded",
      correlation: { imageRefs: ["r/w:1.4"] },
    });
    const b2 = ev({
      action: "artifact.published",
      correlation: {
        commitShas: [B],
        repositories: [APP],
        imageRefs: ["r/w:1.4"],
        imageDigests: [D2],
      },
    });
    const late = ev({
      source: "argocd",
      action: "argocd.sync.succeeded",
      correlation: { imageRefs: ["r/w:1.4"] },
    });
    const { links, conflicts } = buildLinks([b1, early, b2, late]);
    expect(linkBetween(links, b1.id, early.id)?.confidence).toBe("probable"); // only one build existed then
    expect(linkBetween(links, b1.id, late.id)?.evidence[0]?.kind).toBe("same_mutable_image_tag");
    expect(linkBetween(links, b2.id, late.id)?.confidence).toBe("weak");
    expect(linkBetween(links, b1.id, b2.id)).toBeUndefined();
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "tag_digest_mismatch", events: [b1.id, b2.id] }),
    ]);
  });

  it("links references, deployment ids, tags naming commits, and guesses for orphans", () => {
    const push = ev({
      action: "ref.pushed",
      correlation: { commitShas: [A], repositories: [APP] },
      data: { headCommit: A },
    });
    const bump = ev({
      action: "ref.pushed",
      correlation: { commitShas: [CFG], repositories: [DEPLOY] },
      data: { correlationHints: { mentionedCommitShas: [A] } },
    });
    const sync = ev({
      source: "argocd",
      action: "argocd.sync.succeeded",
      correlation: {
        commitShas: [CFG],
        repositories: [DEPLOY],
        imageRefs: [`r/app:sha-${A.slice(0, 7)}`],
      },
    });
    const created = ev({
      source: "vercel",
      action: "deployment.created",
      correlation: { repositories: [APP], deploymentIds: ["vercel:dpl_1"] },
    });
    const ready = ev({
      source: "vercel",
      action: "deployment.status_updated",
      correlation: { repositories: [APP], deploymentIds: ["vercel:dpl_1"] },
    });
    const { links } = buildLinks([push, bump, sync, created, ready]);
    expect(linkBetween(links, push.id, bump.id)?.evidence[0]?.kind).toBe("reference");
    expect(linkBetween(links, bump.id, sync.id)?.confidence).toBe("certain");
    expect(linkBetween(links, push.id, sync.id)?.evidence.map((e) => e.kind)).toEqual([
      "image_tag_names_commit",
    ]);
    expect(linkBetween(links, created.id, ready.id)?.confidence).toBe("certain");
    const guess = linkBetween(links, push.id, ready.id)!;
    expect(guess.confidence).toBe("weak");
    expect(guess.evidence[0]?.kind).toBe("time_proximity");
  });

  it("does not guess outside the proximity window", () => {
    const push = ev({
      action: "ref.pushed",
      occurredAt: "2026-10-20T00:00:00.000Z",
      correlation: { commitShas: [A], repositories: [APP] },
    });
    const dpl = ev({
      source: "vercel",
      action: "deployment.status_updated",
      occurredAt: "2026-10-21T00:00:00.000Z",
      correlation: { repositories: [APP] },
    });
    expect(buildLinks([push, dpl], { proximityWindowMs: 60_000 }).links).toEqual([]);
  });
});

describe("environment state and journeys", () => {
  const push = ev({
    id: "push",
    action: "ref.pushed",
    target: { type: "ref", id: "app:main", ref: "refs/heads/main" },
    correlation: { commitShas: [A], repositories: [APP] },
    data: { headCommit: A },
  });
  const build = ev({
    id: "build",
    action: "artifact.published",
    correlation: {
      commitShas: [A],
      repositories: [APP],
      imageRefs: ["r/app:v1"],
      imageDigests: [D1],
    },
  });
  const bump = ev({
    id: "bump",
    action: "ref.pushed",
    correlation: { commitShas: [CFG], repositories: [DEPLOY] },
    data: { headCommit: CFG, correlationHints: { mentionedCommitShas: [A] } },
  });
  const sync = ev({
    id: "sync",
    source: "argocd",
    action: "argocd.sync.succeeded",
    target: {
      type: "application",
      id: "argocd/app-prod",
      application: "app-prod",
      environment: "production",
    },
    trigger: { type: "auto_sync" },
    correlation: {
      commitShas: [CFG],
      repositories: [DEPLOY],
      imageRefs: ["r/app:v1"],
      imageDigests: [D1],
    },
  });
  const override = ev({
    id: "override",
    source: "argocd",
    action: "argocd.sync.succeeded",
    target: {
      type: "application",
      id: "argocd/app-prod",
      application: "app-prod",
      environment: "production",
    },
    trigger: { type: "manual" },
    correlation: { commitShas: [CFG], repositories: [DEPLOY], imageRefs: ["r/app:hotfix"] },
  });
  const events = [push, build, bump, sync, override];
  const { links } = buildLinks(events);
  const envs = deriveEnvironmentStates(events, links);
  const journeys = buildJourneys(events, links, envs);

  it("attributes GitOps placements through images, not the config revision", () => {
    expect(envs).toHaveLength(1);
    const prod = envs[0]!;
    expect(prod.service).toBe("r/app");
    expect(prod.history[0]!.commits).toEqual([
      expect.objectContaining({ commitSha: A, confidence: "strong", repository: APP }),
    ]);
    expect(prod.history[0]!.configRevision).toEqual({ repository: DEPLOY, commitSha: CFG });
    expect(prod.current.eventId).toBe("override");
    expect(prod.current.commits).toEqual([]);
    expect(prod.current.notes.join(" ")).toMatch(/not produced by any observed build/);
  });

  it("builds a journey from commit to environment and excludes the overridden sync", () => {
    const j = journeys.find((x) => x.commitSha === A)!;
    expect(j.ref).toBe("refs/heads/main");
    expect(j.steps.map((s) => [s.eventId, s.stage, s.confidence])).toEqual([
      ["push", "change", "certain"],
      ["build", "artifact", "certain"],
      ["bump", "config", "probable"],
      ["sync", "deploy", "strong"],
    ]);
    expect(j.environments).toEqual([
      expect.objectContaining({ placementEventId: "sync", confidence: "strong", current: false }),
    ]);
    expect(j.excluded).toEqual([expect.objectContaining({ eventId: "override" })]);
  });

  it("gives the config commit its own journey with both syncs", () => {
    const j = journeys.find((x) => x.commitSha === CFG)!;
    expect(j.environments.map((e) => [e.placementEventId, e.confidence])).toEqual([
      ["sync", "certain"],
      ["override", "certain"],
    ]);
  });

  it("follows deployment ids for rollbacks and skips builds not assigned the domains", () => {
    const vc = (id: string, action: string, extra: Partial<CorrelationEvent>, corr: Correlation) =>
      ev({
        id,
        source: "vercel",
        action,
        target: { type: "deployment", id, project: "web", environment: "production" },
        correlation: { repositories: [APP], ...corr },
        ...extra,
      });
    const e1 = vc(
      "d1",
      "deployment.status_updated",
      {},
      { commitShas: [A], deploymentIds: ["vercel:d1"] },
    );
    const e2 = vc(
      "d2",
      "deployment.status_updated",
      { data: { aliasAssigned: false } },
      { commitShas: [B], deploymentIds: ["vercel:d2"] },
    );
    const rb = vc(
      "rb",
      "deployment.rolled_back",
      { trigger: { type: "rollback" } },
      { deploymentIds: ["vercel:d1"] },
    );
    const evs = [e1, e2, rb];
    const states = deriveEnvironmentStates(evs, buildLinks(evs).links);
    expect(states[0]!.history.map((p) => p.eventId)).toEqual(["d1", "rb"]);
    expect(states[0]!.current.commits).toEqual([
      expect.objectContaining({ commitSha: A, confidence: "certain" }),
    ]);
  });
});
