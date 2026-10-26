/**
 * Per-change journeys: one commit (as pushed to a repository) and every
 * event it led to, with the confidence of the weakest link on the way, plus
 * the environments where the commit's content went live.
 */
import type { EnvironmentState, Placement } from "./environments.ts";
import {
  byTime,
  confidenceRank,
  isBuildEvent,
  isChangeEvent,
  isDeployEvent,
  minConfidence,
  repositoriesOf,
  type Confidence,
  type CorrelationEvent,
  type Evidence,
  type Link,
} from "./model.ts";

/** Coarse column for a journey diagram. */
export type Stage = "change" | "ci" | "artifact" | "config" | "deploy" | "runtime" | "other";

export interface JourneyStep {
  eventId: string;
  stage: Stage;
  /** Weakest link on the best path from the commit (`certain` for the commit's own events). */
  confidence: Confidence;
  /** Event this step was reached from (absent for the commit's own events). */
  reachedFrom?: string;
  /** Evidence of the link it was reached through. */
  via: Evidence[];
}

export interface JourneyEnvironment {
  environmentKey: string;
  placementEventId: string;
  at: string;
  confidence: Confidence;
  /** Still live at the end of the data. */
  current: boolean;
}

export interface Journey {
  /** "<repository>@<sha>". */
  id: string;
  repository: string;
  commitSha: string;
  ref?: string;
  startedAt: string;
  rootEventId: string;
  steps: JourneyStep[];
  environments: JourneyEnvironment[];
  /** Reached through links but excluded, e.g. a sync of the right config revision running a different image. */
  excluded: { eventId: string; reason: string }[];
  /** Other commits of the same repository at the boundary (e.g. the merge commit of a PR head). */
  relatedJourneys: string[];
}

export function stageOf(e: CorrelationEvent, rootRepository: string): Stage {
  if (isChangeEvent(e) || e.action === "pull_request.merged") {
    return repositoriesOf(e).includes(rootRepository) ? "change" : "config";
  }
  if (e.action === "argocd.application.updated") return "config";
  if (isBuildEvent(e) && e.action === "artifact.published") return "artifact";
  if (e.action.startsWith("workflow_")) return "ci";
  if (isDeployEvent(e)) return "deploy";
  if (e.action === "argocd.health.changed") return "runtime";
  return "other";
}

export function buildJourneys(
  events: CorrelationEvent[],
  links: Link[],
  environments: EnvironmentState[],
): Journey[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const adjacency = new Map<string, Link[]>();
  for (const l of links) {
    for (const id of [l.from, l.to]) {
      const list = adjacency.get(id);
      if (list) list.push(l);
      else adjacency.set(id, [l]);
    }
  }
  const placements = new Map<string, Placement>();
  const currentPlacement = new Set<string>();
  for (const s of environments) {
    for (const p of s.history) placements.set(p.eventId, p);
    currentPlacement.add(s.current.eventId);
  }

  // Roots: head commit of each push, per repository.
  const roots = new Map<string, CorrelationEvent>();
  for (const e of [...events].sort(byTime)) {
    if (!isChangeEvent(e)) continue;
    const repo = repositoriesOf(e)[0];
    const sha =
      typeof e.data?.headCommit === "string" ? e.data.headCommit : e.correlation.commitShas?.[0];
    if (!repo || !sha) continue;
    const id = `${repo}@${sha}`;
    if (!roots.has(id)) roots.set(id, e);
  }

  return [...roots.entries()].map(([id, root]) => {
    const repository = repositoriesOf(root)[0]!;
    const commitSha = id.slice(repository.length + 1);
    const steps = new Map<string, JourneyStep>();
    const excluded = new Map<string, string>();
    const related = new Set<string>();

    // Seeds: every event carrying this commit in this repository.
    const queue: string[] = [];
    for (const e of events) {
      if (e.correlation.commitShas?.includes(commitSha) && repositoriesOf(e).includes(repository)) {
        steps.set(e.id, {
          eventId: e.id,
          stage: stageOf(e, repository),
          confidence: "certain",
          via: [],
        });
        queue.push(e.id);
      }
    }

    // Best-path search forward in time; confidence is the weakest link. Weak
    // steps are shown but not expanded (a guess must not lead to more guesses).
    while (queue.length > 0) {
      const curId = queue.shift()!;
      const cur = steps.get(curId)!;
      if (cur.confidence === "weak") continue;
      for (const l of adjacency.get(curId) ?? []) {
        if (l.from !== curId) continue; // forward in time only
        const next = byId.get(l.to)!;
        if (belongsToOtherChange(next, repository, commitSha)) {
          for (const sha of next.correlation.commitShas ?? []) {
            if (sha !== commitSha) related.add(`${repository}@${sha}`);
          }
          continue;
        }
        const placement = placements.get(next.id);
        if (
          placement &&
          (placement.images.length > 0 || placement.commits.length > 0) &&
          !placementMatch(placement, commitSha)
        ) {
          excluded.set(
            next.id,
            placement.commits.length === 0
              ? "deployed images do not trace to this commit (e.g. image overridden outside Git)"
              : "the deployed content traces to a different commit",
          );
          continue;
        }
        const confidence = minConfidence(cur.confidence, l.confidence);
        const existing = steps.get(next.id);
        if (existing && confidenceRank(existing.confidence) >= confidenceRank(confidence)) continue;
        steps.set(next.id, {
          eventId: next.id,
          stage: stageOf(next, repository),
          confidence,
          reachedFrom: curId,
          via: l.evidence,
        });
        queue.push(next.id);
      }
    }

    const environmentsReached: JourneyEnvironment[] = [];
    for (const s of environments) {
      for (const p of s.history) {
        const step = steps.get(p.eventId);
        const unattributed = p.images.length === 0 && p.commits.length === 0;
        const confidence =
          placementMatch(p, commitSha) ?? (unattributed ? step?.confidence : undefined);
        if (!confidence) continue;
        environmentsReached.push({
          environmentKey: s.key,
          placementEventId: p.eventId,
          at: p.at,
          confidence,
          current: s.current.eventId === p.eventId,
        });
      }
    }

    const journey: Journey = {
      id,
      repository,
      commitSha,
      startedAt: root.occurredAt,
      rootEventId: root.id,
      steps: [...steps.values()].sort((a, b) => byTime(byId.get(a.eventId)!, byId.get(b.eventId)!)),
      environments: environmentsReached.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
      excluded: [...excluded].map(([eventId, reason]) => ({ eventId, reason })),
      relatedJourneys: [...related].sort(),
    };
    if (root.target.ref) journey.ref = root.target.ref;
    return journey;
  });
}

/**
 * How sure we are that a placement put this commit live: as an app commit
 * (attributed through images or the deployment's own commit) or as the
 * synced config revision (a GitOps repository commit).
 */
function placementMatch(p: Placement, sha: string): Confidence | undefined {
  const attr = p.commits.find((c) => c.commitSha === sha);
  if (attr) return attr.confidence;
  if (p.configRevision?.commitSha === sha) return "certain";
  return undefined;
}

/** An event of the same repository that carries commits, none of them ours: a different change. */
function belongsToOtherChange(e: CorrelationEvent, repository: string, sha: string): boolean {
  const shas = e.correlation.commitShas ?? [];
  return shas.length > 0 && !shas.includes(sha) && repositoriesOf(e).includes(repository);
}
