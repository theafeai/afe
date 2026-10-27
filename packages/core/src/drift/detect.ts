/**
 * Drift detection (AFE-26) on top of the correlation output (AFE-20):
 * environment targets with their placement history (attribution status,
 * kinds, evidence), identifier conflicts, and the ArgoCD Application changes
 * of the window. Linking and attribution are not re-implemented here.
 *
 * Findings are episodes per target and type: a finding opens at the first
 * placement (or override) exhibiting the condition, stays one finding while
 * the following placements keep exhibiting it, and is resolved by the first
 * later placement that no longer does (typically a Git-traced deploy). The
 * key (`type|target|openingEventId`) is therefore stable across evaluations.
 */
import type { JsonObject, JsonValue } from "../event.ts";
import {
  actorName,
  imageTagKey,
  parseImageRef,
  sameContent,
  sortedByTime,
  type Conflict,
  type CorrelationEvent,
  type EnvironmentState,
  type ImageAttribution,
  type Placement,
} from "../correlation/index.ts";
import type { DetectedFinding, DriftEvidence, DriftFindingType } from "./model.ts";

/** What a detector reports for one placement that exhibits its finding type. */
export interface PlacementCheck {
  title: string;
  explanation: string;
  /** Extra evidence besides the placement itself. */
  evidence?: DriftEvidence[];
  details?: JsonObject;
}

export interface PlacementContext {
  state: EnvironmentState;
  /** Index of the placement in `state.history`. */
  index: number;
  /** The latest earlier placement of the target that was a Git-triggered, attributed deploy. */
  lastGitDeploy: Placement | undefined;
  /** An ArgoCD manual override was active on this target when the placement happened. */
  overrideActive: boolean;
  conflicts: readonly Conflict[];
  event(id: string): CorrelationEvent | undefined;
}

/** A placement-based detector. Built-ins below; more can be passed in options. */
export interface PlacementDetector {
  type: DriftFindingType;
  check(p: Placement, ctx: PlacementContext): PlacementCheck | null;
}

export interface DetectDriftInput {
  environments: readonly EnvironmentState[];
  conflicts?: readonly Conflict[];
  /** The window's events (ArgoCD Application changes are read from here). */
  events: Iterable<CorrelationEvent> | ReadonlyMap<string, CorrelationEvent>;
}

export interface DetectDriftOptions {
  /** Only these types (default: all). */
  types?: readonly string[];
  /** Additional placement detectors (custom finding types). */
  detectors?: readonly PlacementDetector[];
  /** Evidence entries kept per finding (default 20: the first ones and the latest ones). */
  maxEvidence?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MUTABLE_TAGS = new Set([
  "latest",
  "main",
  "master",
  "stable",
  "edge",
  "dev",
  "develop",
  "nightly",
  "prod",
  "production",
  "staging",
]);

/**
 * Whether an image tag is a moving name rather than one build: well-known
 * moving names (`latest`, branch names). Commit-like and version tags are
 * treated as immutable by convention (registries do not enforce it).
 */
export function isMutableTag(tag: string | undefined): boolean {
  if (!tag) return false;
  return MUTABLE_TAGS.has(tag.toLowerCase());
}

const imageLabel = (img: ImageAttribution) => img.ref ?? img.digest ?? "image";

/** Whether an image traces to a commit (a build with its commit, or a tag naming a commit). */
function imageTraces(img: ImageAttribution, p: Placement): boolean {
  if (img.builds.some((b) => b.commitSha)) return true;
  // The correlation core attributes "tag names the commit" without a build;
  // its `via` names the image.
  const label = imageLabel(img);
  return p.commits.some((c) => c.via.includes(label));
}

function short(sha: string) {
  return sha.slice(0, 12);
}

function describePlacement(p: Placement, e: CorrelationEvent | undefined): string {
  const who = p.actor ? ` by ${p.actor}` : "";
  const what = p.images.length
    ? p.images.map(imageLabel).join(", ")
    : p.commits.length
      ? p.commits.map((c) => short(c.commitSha)).join(", ")
      : (p.deploymentIds[0] ?? "unknown content");
  const label = e?.target.application ?? e?.target.project ?? e?.target.repository ?? "";
  return `${p.action} (${p.kind}, via ${p.how})${who}${label ? ` on ${label}` : ""}: ${what}`;
}

function eventSummaryText(e: CorrelationEvent): string {
  const who = actorName(e);
  return `${e.action} (${e.source}, via ${e.trigger.type})${who ? ` by ${who}` : ""}`;
}

function contentOf(p: Placement): JsonObject {
  return {
    images: p.images.map((i) => ({
      ref: i.ref ?? null,
      digest: i.digest ?? null,
      builds: i.builds.length + (i.buildsOmitted ?? 0),
    })),
    commits: p.commits.map((c) => ({
      repository: c.repository ?? null,
      commitSha: c.commitSha,
      confidence: c.confidence,
      via: c.via,
    })),
    attribution: { status: p.attribution.status, confidence: p.attribution.confidence },
    configRevision: p.configRevision
      ? { repository: p.configRevision.repository ?? null, commitSha: p.configRevision.commitSha }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Built-in placement detectors
// ---------------------------------------------------------------------------

/** Deploy without Git metadata whose content traces to no commit, or only to a weak guess. */
export const untrackedDeployDetector: PlacementDetector = {
  type: "untracked_deploy",
  check(p, ctx) {
    if (p.images.length > 0) return null;
    if (p.attribution.status !== "unknown" && p.attribution.status !== "guess") return null;
    const guess = p.commits[0];
    const evidence: DriftEvidence[] = [];
    for (const id of p.evidenceEventIds) {
      const e = ctx.event(id);
      if (e)
        evidence.push({
          eventId: id,
          role: "related",
          at: e.occurredAt,
          summary: `${eventSummaryText(e)}: nearby push used for the guess`,
        });
    }
    return {
      title: `Deploy without Git metadata to ${ctx.state.label}`,
      explanation:
        `Deployed via ${p.how}${p.actor ? ` by ${p.actor}` : ""} with no commit or Git metadata; ` +
        (guess
          ? `Afe can only guess it is ${short(guess.commitSha)} (${guess.via}).`
          : "the content does not trace to any commit."),
      evidence,
      details: {
        how: p.how,
        deploymentIds: p.deploymentIds,
        deploymentUrls: p.deploymentUrls,
        guessedCommits: p.commits.map((c) => ({
          repository: c.repository ?? null,
          commitSha: c.commitSha,
        })),
      },
    };
  },
};

/** An image runs that no observed build links to a commit. */
export const unknownImageDetector: PlacementDetector = {
  type: "unknown_image",
  check(p, ctx) {
    // A manual override explains the image; reported as manual_override.
    if (ctx.overrideActive) return null;
    const unknown = p.images.filter((img) => !imageTraces(img, p));
    if (unknown.length === 0) return null;
    const images = unknown.map((img) => {
      const tag = img.ref ? parseImageRef(img.ref).tag : undefined;
      return {
        ref: img.ref ?? null,
        digest: img.digest ?? null,
        mutableTag: isMutableTag(tag),
        builds: img.builds.length,
      };
    });
    const labels = unknown.map(imageLabel).join(", ");
    const mutable = images.some((i) => i.mutableTag);
    const withBuildNoCommit = unknown.some((i) => i.builds.length > 0);
    const evidence: DriftEvidence[] = [];
    for (const img of unknown)
      for (const b of img.builds) {
        const e = ctx.event(b.eventId);
        if (e)
          evidence.push({
            eventId: b.eventId,
            role: "build",
            at: e.occurredAt,
            summary: `${eventSummaryText(e)}: build of ${imageLabel(img)} without a commit`,
          });
      }
    return {
      title: `Unknown image running in ${ctx.state.label}`,
      explanation:
        `${labels} ${unknown.length > 1 ? "are" : "is"} running but ` +
        (withBuildNoCommit
          ? "the observed build has no provenance linking it to a commit"
          : "no observed build (artifact.published or CI run) produced it") +
        (mutable ? "; the tag is mutable, so it may point at any build" : "") +
        ".",
      evidence,
      details: { ...contentOf(p), unknownImages: images },
    };
  },
};

/** The image traces to several commits (mutable tag rebuilt), or its identifiers conflict. */
export const ambiguousAttributionDetector: PlacementDetector = {
  type: "ambiguous_attribution",
  check(p, ctx) {
    const reasons: string[] = [];
    const evidence: DriftEvidence[] = [];
    if (p.attribution.status === "ambiguous") {
      const amb = p.images.filter(
        (img) => new Set(img.builds.filter((b) => b.commitSha).map((b) => b.commitSha)).size > 1,
      );
      for (const img of amb) {
        const shas = [...new Set(img.builds.flatMap((b) => (b.commitSha ? [b.commitSha] : [])))];
        reasons.push(
          `${imageLabel(img)} was built from ${shas.length} different commits (${shas.map(short).join(", ")})`,
        );
        for (const b of img.builds) {
          const e = ctx.event(b.eventId);
          if (e)
            evidence.push({
              eventId: b.eventId,
              role: "build",
              at: e.occurredAt,
              summary: `${eventSummaryText(e)}: build of ${imageLabel(img)} from ${b.commitSha ? short(b.commitSha) : "unknown commit"}`,
            });
        }
      }
    }
    const conflictKeys = new Set<string>();
    for (const img of p.images) {
      if (img.ref && !img.digest) conflictKeys.add(`image:${img.ref}`);
      if (img.digest) conflictKeys.add(`digest:${img.digest}`);
    }
    for (const c of ctx.conflicts) {
      if (!conflictKeys.has(c.key)) continue;
      // The conflict exists once its later event happened.
      const later = ctx.event(c.events[1]);
      if (later && later.occurredAt > p.at) continue;
      reasons.push(`${c.key.replace(/^(image|digest):/, "")}: ${c.detail}`);
      for (const id of c.events) {
        const e = ctx.event(id);
        if (e)
          evidence.push({
            eventId: id,
            role: "conflict",
            at: e.occurredAt,
            summary: `${eventSummaryText(e)}: ${c.kind.replace(/_/g, " ")} (${c.key})`,
          });
      }
    }
    if (reasons.length === 0) return null;
    return {
      title: `Ambiguous content in ${ctx.state.label}`,
      explanation: `Afe cannot tell which commit is live: ${reasons.join("; ")}.`,
      evidence,
      details: { reasons, ...contentOf(p) },
    };
  },
};

/**
 * What is live (traceable to Git) differs from the latest Git-triggered
 * deploy of the target, after a manual sync/deploy or a rollback.
 */
export const outOfBandChangeDetector: PlacementDetector = {
  type: "out_of_band_change",
  check(p, ctx) {
    if (p.kind !== "manual" && p.kind !== "rollback") return null;
    if (p.attribution.status !== "attributed") return null;
    const git = ctx.lastGitDeploy;
    if (!git || sameContent(p, git)) return null;
    const live = p.commits.map((c) => short(c.commitSha)).join(", ") || "other content";
    const gitCommits = git.commits.map((c) => short(c.commitSha)).join(", ");
    const ge = ctx.event(git.eventId);
    return {
      title: `${ctx.state.label} differs from its latest Git deploy`,
      explanation:
        `${p.kind === "rollback" ? "Rolled back" : `Changed manually (via ${p.how})`}` +
        `${p.actor ? ` by ${p.actor}` : ""}: live is ${live}, the latest Git-triggered deploy ` +
        `(${git.at}) was ${gitCommits}.`,
      evidence: [
        {
          eventId: git.eventId,
          role: "git_deploy",
          at: git.at,
          summary: `latest Git-triggered deploy: ${describePlacement(git, ge)}`,
        },
      ],
      details: {
        live: contentOf(p),
        gitDeploy: { eventId: git.eventId, at: git.at, ...contentOf(git) },
      },
    };
  },
};

export const BUILTIN_PLACEMENT_DETECTORS: readonly PlacementDetector[] = [
  untrackedDeployDetector,
  unknownImageDetector,
  ambiguousAttributionDetector,
  outOfBandChangeDetector,
];

// ---------------------------------------------------------------------------
// ArgoCD manual overrides
// ---------------------------------------------------------------------------

function strings(v: JsonValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function obj(v: JsonValue | undefined): JsonObject | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

const OVERRIDE_FIELD = /kustomize\.images|helm\.(parameters|values|valuesobject)|\bimage/i;

/**
 * Image override fields an ArgoCD Application change adds and removes.
 * The connector records `data.change.imageOverrides` / `removedImageOverrides`
 * (`field=value` pairs) on `argocd.application.updated` and
 * `data.spec.imageOverrides` on `argocd.application.created`. Older or
 * simpler producers name only the changed field (`data.change` a string, or
 * `data.change.fields`); that counts as an override of that field.
 */
export function overrideChange(e: CorrelationEvent): { added: string[]; removed: string[] } {
  const data = e.data ?? {};
  if (e.action === "argocd.application.created") {
    return { added: strings(obj(data.spec)?.imageOverrides), removed: [] };
  }
  const change = data.change;
  if (typeof change === "string") {
    return { added: OVERRIDE_FIELD.test(change) ? [change] : [], removed: [] };
  }
  const c = obj(change);
  if (!c) return { added: [], removed: [] };
  const added = strings(c.imageOverrides);
  const removed = strings(c.removedImageOverrides);
  if (added.length === 0 && removed.length === 0 && !c.imageOverrides) {
    // Only field names: an image field changed but values are unknown.
    const fields = strings(c.fields).filter((f) => OVERRIDE_FIELD.test(f));
    return { added: fields, removed: [] };
  }
  return { added, removed };
}

interface OverrideEpisode {
  targetKey: string;
  label: string;
  toolEnvironment: string;
  opening: CorrelationEvent;
  events: CorrelationEvent[];
  active: Set<string>;
  /** Image refs the override points at. */
  refs: Set<string>;
  /** When all override fields were removed (pending a sync to take effect). */
  clearedAt: string | null;
  placements: Placement[];
  resolvedBy: Placement | null;
}

function argoTargetKey(e: CorrelationEvent) {
  return `argocd:${e.target.id}`;
}

function overrideEpisodes(
  events: readonly CorrelationEvent[],
  states: Map<string, EnvironmentState>,
): OverrideEpisode[] {
  const out: OverrideEpisode[] = [];
  const byTarget = new Map<string, CorrelationEvent[]>();
  for (const e of events) {
    if (e.source !== "argocd") continue;
    if (e.action !== "argocd.application.updated" && e.action !== "argocd.application.created")
      continue;
    const k = argoTargetKey(e);
    const list = byTarget.get(k);
    if (list) list.push(e);
    else byTarget.set(k, [e]);
  }
  for (const [key, changes] of byTarget) {
    const history = states.get(key)?.history ?? [];
    // Merge changes and placements in time order (changes first on ties: a
    // sync at the same instant runs the changed spec).
    type Step = { at: string; change?: CorrelationEvent; placement?: Placement };
    const steps: Step[] = [
      ...changes.map((c): Step => ({ at: c.occurredAt, change: c })),
      ...history.map((p): Step => ({ at: p.at, placement: p })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.change ? -1 : b.change ? 1 : 0));
    const active = new Set<string>();
    let ep: OverrideEpisode | null = null;
    for (const s of steps) {
      if (s.change) {
        const e = s.change;
        const { added, removed } = overrideChange(e);
        for (const r of removed) active.delete(r);
        // Changes made by a parent app-of-apps come from Git.
        const fromGit = e.trigger.type === "upstream";
        if (!fromGit) for (const a of added) active.add(a);
        else for (const a of added) active.delete(a);
        if (!fromGit && added.length > 0) {
          if (!ep) {
            ep = {
              targetKey: key,
              label: e.target.application ?? e.target.name ?? e.target.id,
              toolEnvironment: (
                e.target.environment ??
                e.correlation.environments?.[0] ??
                "unknown"
              ).toLowerCase(),
              opening: e,
              events: [],
              active,
              refs: new Set(),
              clearedAt: null,
              placements: [],
              resolvedBy: null,
            };
            out.push(ep);
          }
          ep.events.push(e);
          ep.clearedAt = null;
          for (const r of e.correlation.imageRefs ?? []) ep.refs.add(r);
        } else if (ep && removed.length > 0) {
          ep.events.push(e);
          if (active.size === 0) ep.clearedAt = e.occurredAt;
        }
        continue;
      }
      const p = s.placement!;
      if (!ep) continue;
      // A sync after the override was removed, or a sync whose content traces
      // to Git and is not the overridden image, ends the episode.
      const overridden = new Set<string>();
      for (const r of ep.refs) {
        const parsed = parseImageRef(r);
        overridden.add(imageTagKey(r) ?? parsed.name);
        if (parsed.digest) overridden.add(parsed.digest);
      }
      const tracesToGit =
        p.attribution.status === "attributed" &&
        !p.images.some((i) => overridden.has(i.ref ?? "") || overridden.has(i.digest ?? ""));
      if (ep.clearedAt !== null || tracesToGit) {
        ep.resolvedBy = p;
        ep = null;
        active.clear();
        continue;
      }
      ep.placements.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

class EvidenceList {
  readonly #head: DriftEvidence[] = [];
  #tail: DriftEvidence[] = [];
  readonly #seen = new Set<string>();
  omitted = 0;
  constructor(readonly max: number) {}
  add(e: DriftEvidence) {
    const k = `${e.eventId}|${e.role}`;
    if (this.#seen.has(k)) return;
    this.#seen.add(k);
    const headMax = Math.ceil(this.max / 2);
    if (this.#head.length < headMax) {
      this.#head.push(e);
      return;
    }
    this.#tail.push(e);
    if (this.#tail.length > this.max - headMax) {
      this.#tail = this.#tail.slice(1);
      this.omitted++;
    }
  }
  list(): DriftEvidence[] {
    return [...this.#head, ...this.#tail].sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : a.eventId < b.eventId ? -1 : 1,
    );
  }
}

function isGitDeploy(p: Placement): boolean {
  return p.kind === "deploy" && p.attribution.status === "attributed";
}

/**
 * Detects drift findings in the window. Deterministic: the same input gives
 * the same findings (keys, order, evidence).
 */
export function detectDrift(
  input: DetectDriftInput,
  options: DetectDriftOptions = {},
): DetectedFinding[] {
  const maxEvidence = Math.max(2, options.maxEvidence ?? 20);
  const wanted = (t: string) => !options.types || options.types.includes(t);
  const byId =
    input.events instanceof Map
      ? (input.events as ReadonlyMap<string, CorrelationEvent>)
      : new Map([...(input.events as Iterable<CorrelationEvent>)].map((e) => [e.id, e]));
  const event = (id: string) => byId.get(id);
  const conflicts = input.conflicts ?? [];
  const states = new Map(input.environments.map((s) => [s.key, s]));
  const findings: DetectedFinding[] = [];

  // --- manual overrides (ArgoCD Application changes) ----------------------
  const sorted = sortedByTime([...byId.values()]);
  const episodes = overrideEpisodes(sorted, states);
  /** Override spans per target, for suppressing unknown_image. */
  const overrideSpans = new Map<string, { from: string; to: string | null }[]>();
  for (const ep of episodes) {
    const spans = overrideSpans.get(ep.targetKey) ?? [];
    spans.push({ from: ep.opening.occurredAt, to: ep.resolvedBy?.at ?? null });
    overrideSpans.set(ep.targetKey, spans);
    if (!wanted("manual_override")) continue;
    const ev = new EvidenceList(maxEvidence);
    const fields = new Set<string>();
    for (const e of ep.events) {
      const { added, removed } = overrideChange(e);
      for (const a of added) fields.add(a);
      const who = actorName(e);
      ev.add({
        eventId: e.id,
        role: "override",
        at: e.occurredAt,
        summary:
          `${e.action} via ${e.trigger.type}${who ? ` by ${who}` : ""}` +
          (added.length ? `: set ${added.join(", ")}` : "") +
          (removed.length ? `${added.length ? ";" : ":"} removed ${removed.join(", ")}` : ""),
      });
    }
    for (const p of ep.placements)
      ev.add({
        eventId: p.eventId,
        role: "placement",
        at: p.at,
        summary: `${describePlacement(p, event(p.eventId))} while the override was set`,
      });
    if (ep.resolvedBy)
      ev.add({
        eventId: ep.resolvedBy.eventId,
        role: "resolution",
        at: ep.resolvedBy.at,
        summary: `${describePlacement(ep.resolvedBy, event(ep.resolvedBy.eventId))} after the override was removed or replaced by Git content`,
      });
    const last = [...ep.events, ...ep.placements.map((p) => event(p.eventId)!)]
      .filter(Boolean)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1))
      .at(-1)!;
    const who = actorName(ep.opening);
    const refs = [...ep.refs].sort();
    const synced = ep.placements.length;
    findings.push({
      key: `manual_override|${ep.targetKey}|${ep.opening.id}`,
      type: "manual_override",
      target: {
        key: ep.targetKey,
        source: "argocd",
        label: ep.label,
        toolEnvironment: ep.toolEnvironment,
      },
      status: ep.resolvedBy ? "resolved" : "open",
      openingEventId: ep.opening.id,
      latestEventId: last.id,
      firstSeenAt: ep.opening.occurredAt,
      lastSeenAt: last.occurredAt,
      resolvedAt: ep.resolvedBy?.at ?? null,
      resolvedByEventId: ep.resolvedBy?.eventId ?? null,
      title: `Manual image override on ${ep.label}`,
      explanation:
        `The ArgoCD Application's image/parameter overrides were changed outside Git ` +
        `(via ${ep.opening.trigger.type}${who ? ` by ${who}` : ""})` +
        (refs.length ? `, pointing at ${refs.join(", ")}` : "") +
        `. ${synced ? `${synced} sync${synced > 1 ? "s" : ""} ran the overridden content` : "No sync has run it yet"}` +
        `${ep.clearedAt && !ep.resolvedBy ? "; the override was removed but no sync has replaced it yet" : ""}.`,
      evidence: ev.list(),
      evidenceOmitted: ev.omitted,
      details: {
        overrideFields: [...fields].sort(),
        imageRefs: refs,
        syncs: synced,
        clearedAt: ep.clearedAt,
      },
    });
  }
  const overrideActiveAt = (key: string, at: string) =>
    (overrideSpans.get(key) ?? []).some((s) => s.from <= at && (s.to === null || at < s.to));

  // --- placement detectors -----------------------------------------------
  const detectors = [...BUILTIN_PLACEMENT_DETECTORS, ...(options.detectors ?? [])].filter((d) =>
    wanted(d.type),
  );
  for (const state of input.environments) {
    let lastGitDeploy: Placement | undefined;
    interface Episode {
      type: string;
      opening: Placement;
      latest: Placement;
      check: PlacementCheck;
      ev: EvidenceList;
      resolvedBy: Placement | null;
    }
    const open = new Map<string, Episode>();
    const all: Episode[] = [];
    state.history.forEach((p, index) => {
      const ctx: PlacementContext = {
        state,
        index,
        lastGitDeploy,
        overrideActive: overrideActiveAt(state.key, p.at),
        conflicts,
        event,
      };
      for (const d of detectors) {
        const r = d.check(p, ctx);
        const cur = open.get(d.type);
        if (r) {
          let ep = cur;
          if (!ep) {
            ep = {
              type: d.type,
              opening: p,
              latest: p,
              check: r,
              ev: new EvidenceList(maxEvidence),
              resolvedBy: null,
            };
            open.set(d.type, ep);
            all.push(ep);
          }
          ep.latest = p;
          ep.check = r;
          ep.ev.add({
            eventId: p.eventId,
            role: "placement",
            at: p.at,
            summary: describePlacement(p, event(p.eventId)),
          });
          for (const x of r.evidence ?? []) ep.ev.add(x);
        } else if (cur) {
          cur.resolvedBy = p;
          cur.ev.add({
            eventId: p.eventId,
            role: "resolution",
            at: p.at,
            summary: `replaced by ${describePlacement(p, event(p.eventId))}`,
          });
          open.delete(d.type);
        }
      }
      if (isGitDeploy(p)) lastGitDeploy = p;
    });
    for (const ep of all) {
      const e = event(ep.opening.eventId);
      findings.push({
        key: `${ep.type}|${state.key}|${ep.opening.eventId}`,
        type: ep.type,
        target: {
          key: state.key,
          source: state.source,
          label: state.label,
          toolEnvironment: state.environment,
        },
        status: ep.resolvedBy ? "resolved" : "open",
        openingEventId: ep.opening.eventId,
        latestEventId: ep.latest.eventId,
        firstSeenAt: ep.opening.at,
        lastSeenAt: ep.latest.at,
        resolvedAt: ep.resolvedBy?.at ?? null,
        resolvedByEventId: ep.resolvedBy?.eventId ?? null,
        title: ep.check.title,
        explanation: ep.check.explanation,
        evidence: ep.ev.list(),
        evidenceOmitted: ep.ev.omitted,
        details: {
          ...(ep.check.details ?? {}),
          ...(e ? { openedBy: { actor: actorName(e) ?? null, how: ep.opening.how } } : {}),
        },
      });
    }
  }

  findings.sort((a, b) =>
    a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : a.key < b.key ? -1 : 1,
  );
  return findings;
}
