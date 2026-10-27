/**
 * Per-change journeys: one commit (in a repository) and every event it led
 * to, with the confidence of the weakest link on the way, plus the
 * environments where the commit's content went live.
 *
 * Rules (validated by the AFE-15 prototype):
 * - Forward in time only; a path's confidence is its weakest link.
 * - Weak steps are shown but not expanded (a guess must not lead to more guesses).
 * - Stop rule: an event of the same repository that carries other commits
 *   but not ours belongs to a different change; it is listed in
 *   `continuesAs`, not walked into.
 * - Exclusion rule: a placement whose content traces to something else (a
 *   sync of the right config revision running an overridden image) is listed
 *   in `excluded`, not followed.
 */
import { attributionTo, type EnvironmentState, type Placement } from "./environments.ts";
import { gapsFromEvents, type GapSpan } from "./gaps.ts";
import { buildLinks, type LinkOptions } from "./links.ts";
import { deriveEnvironmentStates, type EnvironmentOptions } from "./environments.ts";
import {
  byTime,
  sortedByTime,
  confidenceRank,
  isBuildEvent,
  isChangeEvent,
  isDeployEvent,
  minConfidence,
  repositoriesOf,
  type Confidence,
  type Conflict,
  type CorrelationEvent,
  type Evidence,
  type Link,
} from "./model.ts";

/** Column of a journey diagram, in flow order. */
export const STAGES = ["change", "ci", "artifact", "config", "deploy", "runtime", "other"] as const;
export type Stage = (typeof STAGES)[number];

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

/** An edge of the journey diagram: how a step was reached. */
export interface JourneyEdge {
  from: string;
  to: string;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface JourneyEnvironment {
  environmentKey: string;
  placementEventId: string;
  at: string;
  confidence: Confidence;
  /** Still live (the target's current placement). */
  current: boolean;
  /**
   * - attribution: the placement's content is attributed to this commit;
   * - config_revision: this commit is the synced GitOps config revision;
   * - reached: an unattributed placement reached through links;
   * - containment: the live commit includes this commit (GitHub compare, AFE-22).
   */
  via: "attribution" | "config_revision" | "reached" | "containment";
  detail?: string;
}

/** "Continues as": another commit of the same repository that carries this change on. */
export interface JourneyContinuation {
  /** "<repository>@<sha>". */
  journeyId: string;
  repository: string;
  commitSha: string;
  /**
   * - merged_as: a merged pull request names both (head → merge commit);
   * - included_in: pushed together, the other commit is the push's head;
   * - later_commit: a later event of the repository carries it (journey boundary).
   */
  relation: "merged_as" | "included_in" | "later_commit";
  eventId: string;
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
  edges: JourneyEdge[];
  environments: JourneyEnvironment[];
  /** Reached through links but excluded, e.g. a sync of the right config revision running a different image. */
  excluded: { eventId: string; reason: string }[];
  continuesAs: JourneyContinuation[];
  /** `continuesAs` journey ids (prototype field). */
  relatedJourneys: string[];
  /** More steps than `maxSteps`: the walk stopped. */
  truncated: boolean;
}

export function stageOf(e: CorrelationEvent, rootRepository: string): Stage {
  if (isChangeEvent(e) || e.action === "pull_request.merged") {
    return repositoriesOf(e).includes(rootRepository) ? "change" : "config";
  }
  if (e.action === "argocd.application.updated") return "config";
  if (isBuildEvent(e) && e.action.startsWith("artifact.")) return "artifact";
  if (e.action.startsWith("artifact.")) return "artifact";
  if (e.action.startsWith("workflow_")) return "ci";
  if (isDeployEvent(e)) return "deploy";
  if (e.action === "argocd.health.changed") return "runtime";
  return "other";
}

/** Everything derived from one set of events, built once and queried many times. */
export interface CorrelationGraph {
  events: Map<string, CorrelationEvent>;
  links: Link[];
  conflicts: Conflict[];
  adjacency: Map<string, Link[]>;
  environments: EnvironmentState[];
  /** Placement event id → its target and placement. */
  placements: Map<string, { state: EnvironmentState; placement: Placement }>;
  /** Commit SHA → placements attributed to it or syncing it as config revision. */
  placementsByCommit: Map<string, Placement[]>;
  /** Commit SHA → event ids carrying it, in time order. */
  commitIndex: Map<string, string[]>;
  gaps: GapSpan[];
}

export interface GraphOptions extends LinkOptions, EnvironmentOptions {}

export function buildCorrelationGraph(
  events: CorrelationEvent[],
  options: GraphOptions = {},
): CorrelationGraph {
  const { links, conflicts } = buildLinks(events, options);
  return graphOf(events, links, conflicts, deriveEnvironmentStates(events, links, options));
}

function graphOf(
  events: CorrelationEvent[],
  links: Link[],
  conflicts: Conflict[],
  environments: EnvironmentState[],
): CorrelationGraph {
  const sorted = sortedByTime(events);
  const adjacency = new Map<string, Link[]>();
  for (const l of links) {
    for (const id of [l.from, l.to]) {
      const list = adjacency.get(id);
      if (list) list.push(l);
      else adjacency.set(id, [l]);
    }
  }
  const placements = new Map<string, { state: EnvironmentState; placement: Placement }>();
  const placementsByCommit = new Map<string, Placement[]>();
  const addTo = (sha: string, p: Placement) => {
    const list = placementsByCommit.get(sha);
    if (!list) placementsByCommit.set(sha, [p]);
    else if (!list.includes(p)) list.push(p);
  };
  for (const state of environments) {
    for (const p of state.history) {
      placements.set(p.eventId, { state, placement: p });
      for (const c of p.commits) addTo(c.commitSha, p);
      if (p.configRevision) addTo(p.configRevision.commitSha, p);
    }
  }
  const commitIndex = new Map<string, string[]>();
  for (const e of sorted) {
    for (const sha of new Set(e.correlation.commitShas ?? [])) {
      const list = commitIndex.get(sha);
      if (list) list.push(e.id);
      else commitIndex.set(sha, [e.id]);
    }
  }
  return {
    events: new Map(sorted.map((e) => [e.id, e])),
    links,
    conflicts,
    adjacency,
    environments,
    placements,
    placementsByCommit,
    commitIndex,
    gaps: gapsFromEvents(sorted),
  };
}

export interface JourneyOptions {
  /** Steps walked at most (default 500). */
  maxSteps?: number;
}

/**
 * The journey of `commitSha` in `repository` (a `repositoryKey`), or
 * undefined when no event carries that commit in that repository.
 */
export function buildJourney(
  graph: CorrelationGraph,
  repository: string,
  commitSha: string,
  options: JourneyOptions = {},
): Journey | undefined {
  const maxSteps = options.maxSteps ?? 500;
  const byId = graph.events;
  const seeds = (graph.commitIndex.get(commitSha) ?? [])
    .map((id) => byId.get(id)!)
    .filter((e) => repositoriesOf(e).includes(repository));
  if (seeds.length === 0) return undefined;

  const steps = new Map<string, JourneyStep>();
  const excluded = new Map<string, string>();
  const continues = new Map<string, JourneyContinuation>();
  let truncated = false;
  const continueAs = (sha: string, relation: JourneyContinuation["relation"], eventId: string) => {
    if (sha === commitSha) return;
    const prev = continues.get(sha);
    const order = ["later_commit", "included_in", "merged_as"];
    if (prev && order.indexOf(prev.relation) >= order.indexOf(relation)) return;
    continues.set(sha, {
      journeyId: `${repository}@${sha}`,
      repository,
      commitSha: sha,
      relation,
      eventId,
    });
  };

  // Seeds: every event carrying this commit in this repository.
  const queue: string[] = [];
  for (const e of seeds) {
    if (steps.size >= maxSteps) {
      truncated = true;
      break;
    }
    steps.set(e.id, { eventId: e.id, stage: stageOf(e, repository), confidence: "certain", via: [] });
    queue.push(e.id);
    const others = (e.correlation.commitShas ?? []).filter((s) => s !== commitSha);
    if (e.action === "pull_request.merged") for (const s of others) continueAs(s, "merged_as", e.id);
    else if (isChangeEvent(e) && typeof e.data?.headCommit === "string")
      continueAs(e.data.headCommit, "included_in", e.id);
  }
  const root =
    seeds.find((e) => isChangeEvent(e)) ??
    seeds.find((e) => e.action === "pull_request.merged") ??
    seeds[0]!;

  // Best-path search forward in time; confidence is the weakest link.
  while (queue.length > 0) {
    const curId = queue.shift()!;
    const cur = steps.get(curId)!;
    if (cur.confidence === "weak") continue;
    for (const l of graph.adjacency.get(curId) ?? []) {
      if (l.from !== curId) continue; // forward in time only
      const next = byId.get(l.to)!;
      if (belongsToOtherChange(next, repository, commitSha)) {
        for (const sha of next.correlation.commitShas ?? []) continueAs(sha, "later_commit", next.id);
        continue;
      }
      const placed = graph.placements.get(next.id)?.placement;
      if (
        placed &&
        (placed.images.length > 0 || placed.commits.length > 0) &&
        !placementMatch(placed, commitSha)
      ) {
        excluded.set(
          next.id,
          placed.commits.length === 0
            ? "deployed images do not trace to this commit (e.g. image overridden outside Git)"
            : "the deployed content traces to a different commit",
        );
        continue;
      }
      const confidence = minConfidence(cur.confidence, l.confidence);
      const existing = steps.get(next.id);
      if (existing && confidenceRank(existing.confidence) >= confidenceRank(confidence)) continue;
      if (!existing && steps.size >= maxSteps) {
        truncated = true;
        continue;
      }
      excluded.delete(next.id);
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

  // Environments: placements attributed to the commit (or syncing it as
  // config revision), plus unattributed placements reached through links.
  const environments: JourneyEnvironment[] = [];
  const seen = new Set<string>();
  const addEnv = (p: Placement, confidence: Confidence, via: JourneyEnvironment["via"]) => {
    if (seen.has(p.eventId)) return;
    seen.add(p.eventId);
    const state = graph.placements.get(p.eventId)!.state;
    environments.push({
      environmentKey: state.key,
      placementEventId: p.eventId,
      at: p.at,
      confidence,
      current: state.current.eventId === p.eventId,
      via,
    });
  };
  for (const p of graph.placementsByCommit.get(commitSha) ?? []) {
    const attr = attributionTo(p, commitSha);
    if (attr) addEnv(p, attr, "attribution");
    else if (p.configRevision?.commitSha === commitSha && configRepoMatches(p, repository))
      addEnv(p, "certain", "config_revision");
  }
  for (const s of steps.values()) {
    const p = graph.placements.get(s.eventId)?.placement;
    if (p && p.images.length === 0 && p.commits.length === 0) addEnv(p, s.confidence, "reached");
  }

  const stepList = [...steps.values()].sort((a, b) =>
    byTime(byId.get(a.eventId)!, byId.get(b.eventId)!),
  );
  const continuesAs = [...continues.values()].sort((a, b) =>
    a.commitSha < b.commitSha ? -1 : 1,
  );
  const journey: Journey = {
    id: `${repository}@${commitSha}`,
    repository,
    commitSha,
    startedAt: root.occurredAt,
    rootEventId: root.id,
    steps: stepList,
    edges: stepList
      .filter((s) => s.reachedFrom)
      .map((s) => ({
        from: s.reachedFrom!,
        to: s.eventId,
        confidence: s.confidence,
        evidence: s.via,
      })),
    environments: environments.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    excluded: [...excluded].map(([eventId, reason]) => ({ eventId, reason })),
    continuesAs,
    relatedJourneys: continuesAs.map((c) => c.journeyId),
    truncated,
  };
  if (root.target.ref) journey.ref = root.target.ref;
  return journey;
}

/**
 * Journeys for the head commit of every push (prototype API, used by the
 * research generator). Prefer `buildJourney` for one commit.
 */
export function buildJourneys(
  events: CorrelationEvent[],
  links: Link[],
  environments: EnvironmentState[],
): Journey[] {
  const graph = graphOf(events, links, [], environments);
  const roots = new Map<string, string>();
  for (const e of [...events].sort(byTime)) {
    if (!isChangeEvent(e)) continue;
    const repo = repositoriesOf(e)[0];
    const sha =
      typeof e.data?.headCommit === "string" ? e.data.headCommit : e.correlation.commitShas?.[0];
    if (!repo || !sha) continue;
    if (!roots.has(`${repo}@${sha}`)) roots.set(`${repo}@${sha}`, repo);
  }
  return [...roots].flatMap(([id, repo]) => buildJourney(graph, repo, id.slice(repo.length + 1)) ?? []);
}

/**
 * Commit containment results (AFE-22's GitHub compare) for live placements
 * of the journey's repository whose attributed commit is a different one.
 */
export interface ContainmentEvidence {
  placementEventId: string;
  /** The live commit the journey's commit was compared with. */
  liveCommitSha: string;
  contained: boolean | "unknown";
  reason: string;
}

/**
 * Adds environments where the journey's commit is included in what is live
 * (the live commit descends from it), with the live attribution's confidence.
 */
export function applyContainment(
  graph: CorrelationGraph,
  journey: Journey,
  results: readonly ContainmentEvidence[],
): Journey {
  const environments = [...journey.environments];
  for (const r of results) {
    if (r.contained !== true) continue;
    if (environments.some((e) => e.placementEventId === r.placementEventId)) continue;
    const found = graph.placements.get(r.placementEventId);
    if (!found) continue;
    const conf = attributionTo(found.placement, r.liveCommitSha) ?? "weak";
    environments.push({
      environmentKey: found.state.key,
      placementEventId: r.placementEventId,
      at: found.placement.at,
      confidence: conf,
      current: found.state.current.eventId === r.placementEventId,
      via: "containment",
      detail: `included in live commit ${r.liveCommitSha.slice(0, 12)}: ${r.reason}`,
    });
  }
  environments.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { ...journey, environments };
}

/** Current placements of `repository` whose live app commit is not `commitSha` (containment candidates). */
export function containmentCandidates(
  graph: CorrelationGraph,
  journey: Journey,
): { placementEventId: string; liveCommitSha: string }[] {
  const out: { placementEventId: string; liveCommitSha: string }[] = [];
  const reached = new Set(journey.environments.map((e) => e.placementEventId));
  for (const state of graph.environments) {
    const p = state.current;
    if (reached.has(p.eventId) || p.at < journey.startedAt) continue;
    const live = p.commits.filter(
      (c) => c.repository === journey.repository && c.confidence !== "weak",
    );
    if (live.length !== 1 || live[0]!.commitSha === journey.commitSha) continue;
    out.push({ placementEventId: p.eventId, liveCommitSha: live[0]!.commitSha });
  }
  return out;
}

function configRepoMatches(p: Placement, repository: string): boolean {
  return !p.configRevision?.repository || p.configRevision.repository === repository;
}

/**
 * How sure we are that a placement put this commit live: as an app commit
 * (attributed through images or the deployment's own commit) or as the
 * synced config revision (a GitOps repository commit).
 */
function placementMatch(p: Placement, sha: string): Confidence | undefined {
  const attr = attributionTo(p, sha);
  if (attr) return attr;
  if (p.configRevision?.commitSha === sha) return "certain";
  return undefined;
}

/** An event of the same repository that carries commits, none of them ours: a different change. */
function belongsToOtherChange(e: CorrelationEvent, repository: string, sha: string): boolean {
  const shas = e.correlation.commitShas ?? [];
  return shas.length > 0 && !shas.includes(sha) && repositoriesOf(e).includes(repository);
}
