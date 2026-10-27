/**
 * Cross-tool correlation prototype (AFE-15): shared types and helpers.
 *
 * This is research code that informs the first UI; it is not a production
 * API. It works on canonical events (stored `CanonicalEvent`s or anything with
 * the same fields) and is pure: no I/O, no clock. See
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
>;

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
  /** Same image digest (`correlation.imageDigests`). */
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

/** Tag and digest contradict each other (same name:tag, different digests). */
export interface Conflict {
  kind: "tag_digest_mismatch";
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

/**
 * Event that produced an image (an artifact). The prototype uses the proposed
 * `artifact.published` action (GitHub `registry_package` webhook or build
 * provenance attestation) and also accepts CI run/job events carrying images.
 */
export function isBuildEvent(e: CorrelationEvent): boolean {
  if (isDeployEvent(e) || isChangeEvent(e)) return false;
  if (!(e.correlation.imageRefs?.length || e.correlation.imageDigests?.length)) return false;
  return (
    e.action === "artifact.published" ||
    e.action.startsWith("workflow_run.") ||
    e.action.startsWith("workflow_job.")
  );
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
   * Image digests written by a config change. No correlation key yet (would be
   * part of `imageDigests` on the push event); read from legacy hints only.
   */
  mentionedImageDigests: string[];
  /** Deployment URL hosts, lower case (`correlation.deploymentUrls`). */
  deploymentUrls: string[];
}

export function hintsOf(e: CorrelationEvent): CorrelationHints {
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

export function repositoriesOf(e: CorrelationEvent): string[] {
  return e.correlation.repositories ?? [];
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
