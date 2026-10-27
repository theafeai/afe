/**
 * Pure helpers of the journey page (AFE-25): diagram layout, the
 * "many deploys" switch and the "Where it went" summary. Kept free of React
 * so they are easy to test.
 */
import {
  CONFIDENCE_ORDER,
  type Confidence,
  type ContainmentCheck,
  type EnvironmentStateLite,
  type EnvironmentVia,
  type Journey,
  type JourneyEdge,
  type JourneyStep,
  type Stage,
} from "../api/journeys.ts";

export const STAGE_LABEL: Record<Stage, string> = {
  change: "Change",
  ci: "CI",
  artifact: "Artifact",
  config: "Config",
  deploy: "Deploy",
  runtime: "Runtime",
  other: "Other",
};

export const CONFIDENCE_HELP: Record<Confidence, string> = {
  certain: "same deployment, run or commit in the same repository",
  strong: "same image digest, same commit across repositories or same deployment URL",
  probable: "image tag with one producer, a tag naming the commit, or a reference",
  weak: "mutable tag or time proximity only; not followed further",
};

export const EVIDENCE_LABEL: Record<string, string> = {
  same_deployment: "same deployment",
  same_run: "same CI run",
  same_commit_same_repo: "same commit, same repository",
  same_commit: "same commit (other repository)",
  same_image_digest: "same image digest",
  same_deployment_url: "same deployment URL",
  same_image_tag: "same image tag (one build)",
  image_tag_names_commit: "image tag names the commit",
  reference: "referenced by commit message or PR",
  same_mutable_image_tag: "same mutable image tag (several builds)",
  time_proximity: "close in time (no identifier)",
};

export const VIA_LABEL: Record<EnvironmentVia, string> = {
  attribution: "content attributed to this commit",
  config_revision: "synced this commit as GitOps config revision",
  reached: "reached through links, content not attributed to this commit",
  containment: "the live commit includes this commit",
};

export const RELATION_LABEL = {
  merged_as: "Merged as",
  included_in: "Pushed together with head",
  later_commit: "Continues as later commit",
} as const;

export function evidenceText(e: { kind: string; key: string; detail?: string }): string {
  return `${EVIDENCE_LABEL[e.kind] ?? e.kind.replace(/_/g, " ")}: ${e.key}${e.detail ? ` (${e.detail})` : ""}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function weakest(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER.indexOf(a) >= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

// --- Layout ------------------------------------------------------------------

export const CARD_W = 208;
export const CARD_H = 92;
export const GAP_X = 64;
export const GAP_Y = 14;
export const HEAD_H = 30;

export interface CardBox {
  step: JourneyStep;
  column: number;
  x: number;
  y: number;
}

export interface EdgePath {
  edge: JourneyEdge;
  d: string;
  /** Label anchor. */
  lx: number;
  ly: number;
  /** A conflict between two steps (not a link). */
  conflict?: { kind: string; key: string; detail: string };
}

export interface Layout {
  columns: { stage: Stage; x: number; count: number }[];
  cards: Map<string, CardBox>;
  edges: EdgePath[];
  width: number;
  height: number;
}

const byTime = (a: JourneyStep, b: JourneyStep) =>
  a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : a.eventId < b.eventId ? -1 : 1;

function path(a: CardBox, b: CardBox): { d: string; lx: number; ly: number } {
  if (a.column === b.column) {
    // Same column: a loop on the right side.
    const x = a.x + CARD_W;
    const y1 = a.y + CARD_H / 2;
    const y2 = b.y + CARD_H / 2;
    const bulge = x + Math.min(GAP_X - 8, 24 + Math.abs(y2 - y1) / 8);
    return {
      d: `M ${x} ${y1} C ${bulge} ${y1}, ${bulge} ${y2}, ${x} ${y2}`,
      lx: bulge - 4,
      ly: (y1 + y2) / 2,
    };
  }
  const forward = a.column < b.column;
  const x1 = forward ? a.x + CARD_W : a.x;
  const x2 = forward ? b.x : b.x + CARD_W;
  const y1 = a.y + CARD_H / 2;
  const y2 = b.y + CARD_H / 2;
  const dx = Math.max(24, Math.abs(x2 - x1) / 2);
  const c1 = forward ? x1 + dx : x1 - dx;
  const c2 = forward ? x2 - dx : x2 + dx;
  return {
    d: `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`,
    lx: (x1 + x2) / 2,
    ly: (y1 + y2) / 2,
  };
}

/** Stage columns (flow order), cards in time order per column, edge paths. */
export function layoutJourney(j: Journey): Layout {
  const byId = new Map(j.steps.map((s) => [s.eventId, s]));
  const cards = new Map<string, CardBox>();
  const columns: Layout["columns"] = [];
  let maxRows = 0;
  j.stages.forEach((st, column) => {
    const x = column * (CARD_W + GAP_X);
    const steps = st.steps.flatMap((id) => byId.get(id) ?? []).sort(byTime);
    steps.forEach((step, row) => {
      cards.set(step.eventId, { step, column, x, y: HEAD_H + row * (CARD_H + GAP_Y) });
    });
    maxRows = Math.max(maxRows, steps.length);
    columns.push({ stage: st.stage, x, count: steps.length });
  });
  const edges: EdgePath[] = [];
  for (const edge of j.edges) {
    const a = cards.get(edge.from);
    const b = cards.get(edge.to);
    if (!a || !b) continue;
    edges.push({ edge, ...path(a, b) });
  }
  for (const c of j.conflicts) {
    const a = cards.get(c.events[0]);
    const b = cards.get(c.events[1]);
    if (!a || !b) continue;
    edges.push({
      edge: { from: c.events[0], to: c.events[1], confidence: "weak", evidence: [] },
      ...path(a, b),
      conflict: { kind: c.kind, key: c.key, detail: c.detail },
    });
  }
  return {
    columns,
    cards,
    edges,
    width: Math.max(0, columns.length * (CARD_W + GAP_X) - GAP_X + 32),
    height: HEAD_H + maxRows * (CARD_H + GAP_Y),
  };
}

/**
 * Research 0001: the stage diagram stops being readable for long-lived
 * commits deployed many times (e.g. a worker image redeployed for weeks);
 * a list of placements reads better there.
 */
export const MANY_PLACEMENTS = 8;
export const TALL_COLUMN = 10;

export function prefersPlacementList(j: Journey): boolean {
  const tallest = Math.max(0, ...j.stages.map((s) => s.steps.length));
  return j.environments.length > MANY_PLACEMENTS || tallest > TALL_COLUMN;
}

// --- Where it went -------------------------------------------------------------

export type WhereStatus = "live" | "was_live" | "not_yet" | "unknown";

export const WHERE_LABEL: Record<WhereStatus, string> = {
  live: "Live now",
  was_live: "Was live",
  not_yet: "Not yet",
  unknown: "Unknown",
};

export interface WhereRow {
  key: string;
  service: string;
  serviceName: string;
  environment: string;
  environmentName: string;
  /** Target label(s) for unmapped or multi-target cells. */
  targets: string[];
  status: WhereStatus;
  confidence: Confidence | null;
  via: EnvironmentVia | null;
  /** When it went live (live / was live). */
  at: string | null;
  placementEventId: string | null;
  /** Later commit through which it is live, or that is live instead. */
  liveCommit: string | null;
  detail: string;
  order: number;
}

const UNMAPPED = "_unmapped";
const rank = (c: Confidence) => CONFIDENCE_ORDER.indexOf(c);

/**
 * One row per environment (service × environment from the mapping; unmapped
 * targets one row each): live now / was live / not yet / unknown, from the
 * journey's placements, its containment checks (when requested) and, for
 * environments of the same services the commit never reached, the
 * environment state.
 */
export function whereItWent(j: Journey, state: EnvironmentStateLite | null = null): WhereRow[] {
  const serviceName = new Map(state?.services.map((s) => [s.id, s.name]) ?? []);
  const envInfo = new Map(state?.environments.map((e) => [e.id, e]) ?? []);
  const nameOf = (id: string, names: Map<string, string>) =>
    id === UNMAPPED ? "Unmapped" : (names.get(id) ?? id.replace(/[-_]/g, " "));
  const cellKey = (service: string, environment: string, targetKey: string) =>
    service === UNMAPPED || environment === UNMAPPED
      ? `${UNMAPPED}:${targetKey}`
      : `${service}/${environment}`;

  const checks = j.containment ?? [];
  const checkByPlacement = new Map(checks.map((c) => [c.placementEventId, c]));
  const targetCell = new Map<string, string>();
  for (const e of j.environments)
    targetCell.set(e.environmentKey, cellKey(e.service, e.environment, e.environmentKey));
  for (const c of state?.cells ?? [])
    for (const t of c.targets)
      if (!targetCell.has(t.key)) targetCell.set(t.key, cellKey(c.service, c.environment, t.key));
  const checksOfCell = (key: string): ContainmentCheck[] =>
    checks.filter((c) => targetCell.get(c.environmentKey) === key);

  const groups = new Map<string, Journey["environments"]>();
  for (const e of j.environments) {
    const key = cellKey(e.service, e.environment, e.environmentKey);
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const rows: WhereRow[] = [];
  for (const [key, entries] of groups) {
    const first = entries[0]!;
    const base = {
      key,
      service: first.service,
      serviceName: nameOf(first.service, serviceName),
      environment: first.environment,
      environmentName:
        first.environment === UNMAPPED
          ? first.target.label
          : nameOf(first.environment, new Map([...envInfo].map(([k, v]) => [k, v.name]))),
      targets: [...new Set(entries.map((e) => e.target.label))],
      order: envInfo.get(first.environment)?.order ?? 1e6,
    };
    const best = (list: typeof entries) =>
      [...list].sort(
        (a, b) => rank(a.confidence) - rank(b.confidence) || (a.at < b.at ? 1 : -1),
      )[0];
    const direct = best(
      entries.filter((e) => e.current && (e.via === "attribution" || e.via === "config_revision")),
    );
    const contained = best(entries.filter((e) => e.current && e.via === "containment"));
    const reached = best(entries.filter((e) => e.current && e.via === "reached"));
    const lastPast = [...entries]
      .filter((e) => e.via !== "containment")
      .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    if (direct) {
      rows.push({
        ...base,
        status: "live",
        confidence: direct.confidence,
        via: direct.via,
        at: direct.at,
        placementEventId: direct.placementEventId,
        liveCommit: null,
        detail: VIA_LABEL[direct.via],
      });
    } else if (contained) {
      const check = checkByPlacement.get(contained.placementEventId);
      const live = check?.liveCommitSha ?? null;
      rows.push({
        ...base,
        status: "live",
        confidence: contained.confidence,
        via: "containment",
        at: contained.at,
        placementEventId: contained.placementEventId,
        liveCommit: live,
        detail: live
          ? `Contained via later commit ${shortSha(live)}: ${check?.reason ?? "the live commit includes this commit"}`
          : (contained.detail ?? VIA_LABEL.containment),
      });
    } else if (reached) {
      rows.push({
        ...base,
        status: "unknown",
        confidence: reached.confidence,
        via: "reached",
        at: reached.at,
        placementEventId: reached.placementEventId,
        liveCommit: null,
        detail: `Possibly live: ${VIA_LABEL.reached}.`,
      });
    } else {
      const cellChecks = checksOfCell(key);
      const not = cellChecks.find((c) => c.contained === false);
      const unknown = cellChecks.find((c) => c.contained === "unknown");
      const past = lastPast ?? entries[0]!;
      rows.push({
        ...base,
        status: "was_live",
        confidence: past.confidence,
        via: past.via,
        at: past.at,
        placementEventId: past.placementEventId,
        liveCommit: not?.liveCommitSha ?? unknown?.liveCommitSha ?? null,
        detail: not
          ? `Replaced; the live commit ${shortSha(not.liveCommitSha)} does not include it (${not.reason}).`
          : unknown
            ? `Replaced by a later deployment; whether commit ${shortSha(unknown.liveCommitSha)} includes it is unknown (${unknown.reason}).`
            : j.containment === null
              ? "Replaced by a later deployment. Check containment to see whether what is live now includes this commit."
              : "Replaced by a later deployment that could not be compared with this commit.",
      });
    }
  }

  // Environments of the same services this commit has not been seen in.
  const services = new Set([...groups.values()].map((g) => g[0]!.service));
  services.delete(UNMAPPED);
  for (const cell of state?.cells ?? []) {
    if (!services.has(cell.service) || cell.environment === UNMAPPED) continue;
    const key = `${cell.service}/${cell.environment}`;
    if (groups.has(key)) continue;
    const cellChecks = checksOfCell(key);
    const not = cellChecks.find((c) => c.contained === false);
    const unknown = cellChecks.find((c) => c.contained === "unknown");
    const liveCommit =
      not?.liveCommitSha ?? unknown?.liveCommitSha ?? cell.live.commits[0]?.commitSha ?? null;
    let status: WhereStatus;
    let detail: string;
    if (not) {
      status = "not_yet";
      detail = `The live commit ${shortSha(not.liveCommitSha)} does not include it (${not.reason}).`;
    } else if (unknown) {
      status = "unknown";
      detail = `Could not compare with the live commit ${shortSha(unknown.liveCommitSha)} (${unknown.reason}).`;
    } else if (cell.since < j.startedAt) {
      status = "not_yet";
      detail = "What is live there was deployed before this commit was first seen.";
    } else {
      status = "unknown";
      detail = liveCommit
        ? `A later deployment (commit ${shortSha(liveCommit)}) is live; it may include this commit.${j.containment === null ? " Check containment to find out." : ""}`
        : "A later deployment is live and its content is not attributed to a commit.";
    }
    rows.push({
      key,
      service: cell.service,
      serviceName: nameOf(cell.service, serviceName),
      environment: cell.environment,
      environmentName: envInfo.get(cell.environment)?.name ?? cell.environment,
      targets: cell.targets.map((t) => t.label),
      status,
      confidence: null,
      via: null,
      at: null,
      placementEventId: null,
      liveCommit,
      detail,
      order: envInfo.get(cell.environment)?.order ?? 1e6,
    });
  }

  const statusOrder: WhereStatus[] = ["live", "was_live", "unknown", "not_yet"];
  return rows.sort(
    (a, b) =>
      a.serviceName.localeCompare(b.serviceName) ||
      a.order - b.order ||
      statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) ||
      a.environmentName.localeCompare(b.environmentName),
  );
}
