/**
 * Cross-tool correlation (AFE-15 prototype, productionised in AFE-20): shared
 * types and helpers.
 *
 * Works on canonical events (stored `CanonicalEvent`s or anything with the
 * same fields) and is pure: no I/O, no clock. The server's correlation
 * service (apps/server/src/correlation) loads a tenant's events for the
 * retention window and runs this code on read. See docs/correlation.md and
 * docs/research/0001-cross-tool-flow.md.
 */
import type { CanonicalEvent, JsonObject, JsonValue } from "../event.ts";

/** The fields of a canonical event that correlation reads. `CanonicalEvent` satisfies it. */
export type CorrelationEvent = Pick<
  CanonicalEvent,
  | "id"
  | "source"
  | "action"
  | "actor"
  | "target"
  | "trigger"
  | "outcome"
  | "occurredAt"
  | "correlation"
  | "data"
> & {
  /** The connection that observed the event; used to match observation gaps. */
  connectionId?: string | null;
};

/**
 * How sure a link or attribution is, weakest first.
 * - certain: the sources share an exact, immutable identifier for the same
 *   object (same deployment id, same run id, same commit SHA in the same repo).
 * - strong: content-addressed match that could only be wrong in odd setups
 *   (same image digest, same commit SHA seen via a fork/mirror, same deployment URL).
 * - probable: a convention or mutable name links them (image tag, a commit
 *   message that mentions a SHA, a tag that encodes a commit).
 * - weak: a guess from time and place (same repository/environment, nearby
 *   in time), or a mutable tag that several builds produced.
 */
export const CONFIDENCE_LEVELS = ["weak", "probable", "strong", "certain"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export function confidenceRank(c: Confidence): number {
  return CONFIDENCE_LEVELS.indexOf(c);
}
export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return confidenceRank(a) <= confidenceRank(b) ? a : b;
}
export function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return confidenceRank(a) >= confidenceRank(b) ? a : b;
}

/** Typed reasons two events are linked. Each kind has a fixed base confidence. */
export const EVIDENCE_CONFIDENCE = {
  /** Both carry the same source-qualified deployment id (`correlation.deploymentIds`). */
  same_deployment: "certain",
  /** Both carry the same source-qualified CI run id (`correlation.runIds`). */
  same_run: "certain",
  /** Same full commit SHA and an overlapping repository key. */
  same_commit_same_repo: "certain",
  /** Same full commit SHA but no common repository (fork, mirror, or repo unknown). */
  same_commit: "strong",
  /** Same image digest (`correlation.imageDigests` or a digest-pinned `imageRefs` entry). */
  same_image_digest: "strong",
  /** Same deployment URL host (`correlation.deploymentUrls`; e.g. GitHub deployment_status.target_url = Vercel url). */
  same_deployment_url: "strong",
  /** Same image reference (name:tag) and only one build produced that tag. */
  same_image_tag: "probable",
  /** An image tag is (a prefix of) a commit SHA another event carries. */
  image_tag_names_commit: "probable",
  /** A commit message / PR body mentions another event's commit SHA or image digest. */
  reference: "probable",
  /** Same image tag, but several builds produced it (mutable tag): ambiguous. */
  same_mutable_image_tag: "weak",
  /** No identifier at all: nearest earlier push to the same repository within a window. */
  time_proximity: "weak",
} as const satisfies Record<string, Confidence>;
export type EvidenceKind = keyof typeof EVIDENCE_CONFIDENCE;
export const EVIDENCE_KINDS = Object.keys(EVIDENCE_CONFIDENCE) as EvidenceKind[];

export interface Evidence {
  kind: EvidenceKind;
  confidence: Confidence;
  /** The shared value, e.g. "commit:<sha>", "digest:sha256:..", "image:ghcr.io/a/b:tag". */
  key: string;
  detail?: string;
}

/** A link between two events, directed from the earlier (`from`) to the later (`to`). */
export interface Link {
  from: string;
  to: string;
  /** Highest confidence of its evidence. */
  confidence: Confidence;
  evidence: Evidence[];
}

/**
 * Identifiers that contradict each other. Reported, never linked.
 * - `tag_digest_mismatch`: the same name:tag was seen with different digests
 *   (a moved tag, or a deployment running something other than the build).
 *   Reported once per tag and pair of digests.
 * - `digest_commit_mismatch`: builds of the same digest claim different
 *   commits (e.g. an OCI label and an attestation disagree).
 */
export const CONFLICT_KINDS = ["tag_digest_mismatch", "digest_commit_mismatch"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export interface Conflict {
  kind: ConflictKind;
  /** Two representative events, earlier first. */
  events: [string, string];
  key: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

const DEPLOY_ACTIONS = new Set([
  "deployment.created",
  "deployment.status_updated",
  "deployment.promoted",
  "deployment.rolled_back",
  "argocd.sync.started",
  "argocd.sync.succeeded",
  "argocd.sync.failed",
  "argocd.sync.terminated",
]);

/** Event that deploys something somewhere (as opposed to a change, build or config edit). */
export function isDeployEvent(e: CorrelationEvent): boolean {
  return DEPLOY_ACTIONS.has(e.action);
}

/** Change events start a journey: a push or merge of commits. */
export function isChangeEvent(e: CorrelationEvent): boolean {
  return e.action === "ref.pushed" || e.action === "ref.created";
}

/** Artifact events (AFE-21): an image was published, or its provenance was found later. */
export function isArtifactEvent(e: CorrelationEvent): boolean {
  return e.action === "artifact.published" || e.action === "artifact.provenance_resolved";
}

/**
 * Event that produced an image (an artifact): `artifact.published` (GitHub
 * `registry_package`, with build provenance or OCI labels),
 * `artifact.provenance_resolved` (the same artifact's provenance, found
 * later), and CI run/job events carrying images.
 */
export function isBuildEvent(e: CorrelationEvent): boolean {
  if (isDeployEvent(e) || isChangeEvent(e)) return false;
  if (!(e.correlation.imageRefs?.length || e.correlation.imageDigests?.length)) return false;
  return (
    isArtifactEvent(e) ||
    e.action.startsWith("workflow_run.") ||
    e.action.startsWith("workflow_job.")
  );
}

/** Observation gap events (source `afe`), see `observationGapOpened` in `@afe/core`. */
export function isGapEvent(e: Pick<CorrelationEvent, "action">): boolean {
  return e.action === "observation_gap.opened" || e.action === "observation_gap.closed";
}

/**
 * Whether an event takes part in correlation: it carries a correlation key
 * (or a legacy hint), or it is an observation gap.
 */
export function isCorrelationRelevant(e: CorrelationEvent): boolean {
  if (isGapEvent(e)) return true;
  for (const v of Object.values(e.correlation)) if (Array.isArray(v) && v.length > 0) return true;
  const h = hintsOf(e);
  return h.upstreamCommitShas.length > 0 || h.deploymentUrls.length > 0;
}

// ---------------------------------------------------------------------------
// Hints: cross-tool reference keys (new correlation keys + legacy data hints)
// ---------------------------------------------------------------------------

/**
 * Reference keys used for cross-tool links. AFE-18 added `upstreamCommitShas`
 * and `deploymentUrls` to `correlation`; events recorded before that carried
 * them in `data.correlationHints` (`mentionedCommitShas`, `deploymentUrls`).
 * Stored events are immutable, so both are read: the correlation keys first,
 * then the legacy hints, merged and de-duplicated.
 */
export interface CorrelationHints {
  /** Full commit SHAs a change refers to in another repository (`correlation.upstreamCommitShas`). */
  upstreamCommitShas: string[];
  /**
   * Image digests written by a config change. No correlation key of its own
   * (a config change carries them in `imageDigests`); read from legacy hints.
   */
  mentionedImageDigests: string[];
  /** Deployment URL hosts, lower case (`correlation.deploymentUrls`). */
  deploymentUrls: string[];
}

export function hintsOf(e: Pick<CorrelationEvent, "correlation" | "data">): CorrelationHints {
  const h = asObject(e.data?.correlationHints);
  return {
    upstreamCommitShas: merge(e.correlation.upstreamCommitShas, strings(h?.mentionedCommitShas)),
    mentionedImageDigests: merge(strings(h?.mentionedImageDigests)),
    deploymentUrls: merge(e.correlation.deploymentUrls, strings(h?.deploymentUrls)),
  };
}

function merge(...lists: (readonly string[] | undefined)[]): string[] {
  const out = new Set<string>();
  for (const l of lists) for (const s of l ?? []) out.add(s.toLowerCase());
  return [...out];
}

function asObject(v: JsonValue | undefined): JsonObject | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}
function strings(v: JsonValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageRef {
  /** registry/repository, e.g. "ghcr.io/acme/shop-api". */
  name: string;
  tag?: string;
  digest?: string;
}

/** Parses "registry/repo:tag", "registry/repo@sha256:..", or "registry/repo:tag@sha256:..". */
export function parseImageRef(ref: string): ImageRef {
  let rest = ref.trim();
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1).toLowerCase();
    rest = rest.slice(0, at);
  }
  const slash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  let tag: string | undefined;
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { name: rest.toLowerCase(), ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) };
}

/** "name:tag" without digest, used as the tag-match key. */
export function imageTagKey(ref: string): string | undefined {
  const p = parseImageRef(ref);
  return p.tag ? `${p.name}:${p.tag}` : undefined;
}

/**
 * Commit SHA prefix encoded in an image tag, for common conventions:
 * the full or short SHA ("4f2c9b8"), or docker/metadata-action "sha-4f2c9b8".
 */
export function commitPrefixFromTag(tag: string): string | undefined {
  const m = /^(?:sha-)?([0-9a-f]{7,64})$/i.exec(tag);
  return m?.[1]?.toLowerCase();
}

export function repositoriesOf(e: Pick<CorrelationEvent, "correlation">): string[] {
  return e.correlation.repositories ?? [];
}

/** Every digest an event carries: `imageDigests` plus the digests of pinned `imageRefs`. */
export function digestsOf(e: Pick<CorrelationEvent, "correlation">): string[] {
  const out = new Set<string>(e.correlation.imageDigests ?? []);
  for (const r of e.correlation.imageRefs ?? []) {
    const d = parseImageRef(r).digest;
    if (d) out.add(d);
  }
  return [...out];
}

/** Display name of whoever caused an event. */
export function actorName(e: Pick<CorrelationEvent, "actor">): string | undefined {
  return e.actor.login ?? e.actor.name ?? e.actor.id ?? undefined;
}

export function byTime(a: CorrelationEvent, b: CorrelationEvent): number {
  return a.occurredAt < b.occurredAt
    ? -1
    : a.occurredAt > b.occurredAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;
}

/**
 * Sorted set of full commit SHAs with prefix lookup (binary search), for
 * image tags that name a commit by a short SHA.
 */
export class ShaPrefixIndex {
  readonly #shas: string[];
  constructor(shas: Iterable<string>) {
    this.#shas = [...new Set(shas)].sort();
  }
  get size(): number {
    return this.#shas.length;
  }
  /** The one SHA starting with `prefix`; undefined when there is none or several. */
  unique(prefix: string): string | undefined {
    const list = this.#shas;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    const first = list[lo];
    if (!first?.startsWith(prefix)) return undefined;
    return list[lo + 1]?.startsWith(prefix) ? undefined : first;
  }
}

/** Events in time order; returns the input itself when it is already sorted. */
export function sortedByTime<T extends CorrelationEvent>(events: readonly T[]): readonly T[] {
  for (let i = 1; i < events.length; i++) {
    if (byTime(events[i - 1]!, events[i]!) > 0) return [...events].sort(byTime);
  }
  return events;
}
