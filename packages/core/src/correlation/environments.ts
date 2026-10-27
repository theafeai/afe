/**
 * Environment state: "what is live where, and how did it get there".
 *
 * A placement is an event after which something new is live in an
 * environment target (a successful ArgoCD sync, a Vercel deployment that got
 * the production domains, a promotion, a rollback, a successful GitHub
 * deployment). For each placement the running content is attributed to app
 * commits, with a confidence:
 *
 * - If the placement names images (ArgoCD `status.summary.images`), the app
 *   commit comes from the artifact that produced the image (digest > tag),
 *   never from the config repository revision. A GitOps sync of config
 *   commit C runs whatever images C (or a parameter override) points at.
 * - Otherwise (Vercel, GitHub deployments) the event's own commit is the
 *   content, certain.
 * - Otherwise (no Git metadata, e.g. `vercel deploy` from a laptop) only a
 *   `time_proximity` guess remains, weak.
 *
 * Artifacts (AFE-20): build events with the same digests are one artifact.
 * `artifact.published` and a later `artifact.provenance_resolved` of the same
 * digest therefore form one build candidate whose commit is known even when
 * only the second event carries it. Digest matches are not time-bound
 * (content addressed); tag matches only count artifacts that existed when
 * the placement happened.
 *
 * Service and environment of a target are not decided here: the server
 * resolves them with the tenant's mapping (AFE-19). `service` below is only
 * a display fallback.
 */
import {
  actorName,
  byTime,
  sortedByTime,
  commitPrefixFromTag,
  confidenceRank,
  digestsOf,
  hintsOf,
  imageTagKey,
  isBuildEvent,
  maxConfidence,
  minConfidence,
  parseImageRef,
  repositoriesOf,
  ShaPrefixIndex,
  type Confidence,
  type CorrelationEvent,
  type Link,
} from "./model.ts";

export interface BuildCandidate {
  /** The artifact event that carries the commit (or the first event of the artifact). */
  eventId: string;
  commitSha?: string;
  repository?: string;
  confidence: Confidence;
}

export interface ImageAttribution {
  /** As deployed: "name:tag" and/or digest. */
  ref?: string;
  digest?: string;
  /** Builds that may have produced it; more than one commit means the tag is ambiguous. */
  builds: BuildCandidate[];
  /** Older candidate artifacts left out (mutable tags with many builds). */
  buildsOmitted?: number;
}

export interface CommitAttribution {
  repository?: string;
  commitSha: string;
  confidence: Confidence;
  /** Human-readable: how the commit was attributed. */
  via: string;
}

/** How a placement happened. */
export type PlacementKind = "deploy" | "promotion" | "rollback" | "redeploy" | "manual";

/**
 * - attributed: the content traces to commit(s);
 * - ambiguous: an image traces to several commits (mutable tag);
 * - guess: no Git metadata, only a weak time-proximity guess;
 * - unknown: nothing traces to a commit (e.g. an image no observed build produced).
 */
export type AttributionStatus = "attributed" | "ambiguous" | "guess" | "unknown";

export interface Placement {
  eventId: string;
  at: string;
  /** Target key (`EnvironmentState.key`). */
  environmentKey: string;
  source: string;
  action: string;
  kind: PlacementKind;
  /** trigger.type of the placing event (auto_sync, manual, cli, rollback, promotion...). */
  how: string;
  actor?: string;
  deploymentIds: string[];
  deploymentUrls: string[];
  /** ArgoCD: the config (GitOps) repository revision that was synced. */
  configRevision?: { repository?: string; commitSha: string };
  images: ImageAttribution[];
  /** App commits the live content is attributed to; empty when unknown. */
  commits: CommitAttribution[];
  attribution: { status: AttributionStatus; confidence: Confidence | null };
  notes: string[];
  /** Events the attribution relies on besides the placement itself (builds, same-deployment events). */
  evidenceEventIds: string[];
}

export interface EnvironmentState {
  /** Target key, e.g. `argocd:argocd/shop-api-production`, `vercel:web:production`. */
  key: string;
  source: string;
  /** The tool's environment name, lower case, e.g. "staging", "production", "preview". */
  environment: string;
  /** Display label: ArgoCD application, Vercel project, GitHub repository. */
  label: string;
  /** Display fallback for the service: image name, Vercel project or repo. The mapping decides. */
  service: string;
  current: Placement;
  /** Oldest first, including `current` as the last entry. */
  history: Placement[];
}

export interface EnvironmentOptions {
  /** Candidate artifacts kept per image for mutable tags (most recent first; default 5). */
  maxBuildCandidates?: number;
}

interface PlacementSlot {
  key: string;
  source: string;
  environment: string;
  label: string;
}

/** Whether an event is a placement, and into which environment target. */
export function placementSlot(e: CorrelationEvent): PlacementSlot | undefined {
  const env = (e.target.environment ?? e.correlation.environments?.[0] ?? "unknown").toLowerCase();
  if (e.source === "argocd") {
    if (e.action !== "argocd.sync.succeeded") return undefined;
    return {
      key: `argocd:${e.target.id}`,
      source: "argocd",
      environment: env,
      label: e.target.application ?? e.target.id,
    };
  }
  const live =
    (e.action === "deployment.status_updated" &&
      e.outcome === "succeeded" &&
      e.data?.aliasAssigned !== false) ||
    e.action === "deployment.promoted" ||
    e.action === "deployment.rolled_back";
  if (!live) return undefined;
  const owner = e.target.project ?? e.target.repository ?? e.target.id;
  // Preview environments are per branch: one target per ref.
  const isPreview = env.startsWith("preview");
  const key = `${e.source}:${owner}:${env}${isPreview && e.target.ref ? `:${e.target.ref}` : ""}`;
  return {
    key,
    source: e.source,
    environment: env,
    label:
      isPreview && e.target.ref ? `${owner} (${e.target.ref.replace("refs/heads/", "")})` : owner,
  };
}

export function placementKind(e: CorrelationEvent): PlacementKind {
  const t = e.trigger.type;
  if (e.action === "deployment.rolled_back" || t === "rollback") return "rollback";
  if (e.action === "deployment.promoted" || t === "promotion") return "promotion";
  if (t === "redeploy" || t === "rerun") return "redeploy";
  if (t === "manual" || t === "cli") return "manual";
  return "deploy";
}

/** Build events with the same digests: one artifact. */
interface Artifact {
  id: string;
  firstAt: string;
  events: CorrelationEvent[];
  digests: string[];
  /** sha → [repository, event id carrying it]. */
  commits: Map<string, { repository?: string; eventId: string }>;
}

export function deriveEnvironmentStates(
  events: CorrelationEvent[],
  links: Link[],
  options: EnvironmentOptions = {},
): EnvironmentState[] {
  const maxCandidates = options.maxBuildCandidates ?? 5;
  const byId = new Map(events.map((e) => [e.id, e]));
  const sorted = sortedByTime(events);

  // Artifacts, indexed by digest and by tag (tag lists in time order).
  const artifacts = new Map<string, Artifact>();
  for (const e of sorted) {
    if (!isBuildEvent(e)) continue;
    const digests = digestsOf(e).sort();
    const key = digests.length > 0 ? `d:${digests.join(",")}` : `e:${e.id}`;
    let a = artifacts.get(key);
    if (!a) {
      a = { id: e.id, firstAt: e.occurredAt, events: [], digests, commits: new Map() };
      artifacts.set(key, a);
    }
    a.events.push(e);
    const repo = repositoriesOf(e)[0];
    for (const sha of e.correlation.commitShas ?? [])
      if (!a.commits.has(sha)) a.commits.set(sha, { ...(repo ? { repository: repo } : {}), eventId: e.id });
  }
  const byDigest = new Map<string, Artifact[]>();
  const byTag = new Map<string, Artifact[]>();
  const push = (m: Map<string, Artifact[]>, k: string, a: Artifact) => {
    const list = m.get(k);
    if (!list) m.set(k, [a]);
    else if (!list.includes(a)) list.push(a);
  };
  for (const a of artifacts.values()) {
    for (const d of a.digests) push(byDigest, d, a);
    for (const e of a.events)
      for (const r of e.correlation.imageRefs ?? []) {
        const t = imageTagKey(r);
        if (t) push(byTag, t, a);
      }
  }
  for (const list of byTag.values()) list.sort((x, y) => (x.firstAt < y.firstAt ? -1 : 1));

  const slots = new Map<string, PlacementSlot>();
  for (const e of sorted) {
    const slot = placementSlot(e);
    if (slot) slots.set(e.id, slot);
  }
  // Links are only needed for placements without images or commits of their own.
  const linksOf = new Map<string, Link[]>();
  for (const l of links) {
    for (const id of [l.from, l.to]) {
      if (!slots.has(id)) continue;
      const list = linksOf.get(id);
      if (list) list.push(l);
      else linksOf.set(id, [l]);
    }
  }
  const shaSet = new Set<string>();
  for (const e of sorted) for (const s of e.correlation.commitShas ?? []) shaSet.add(s);
  const shas = new ShaPrefixIndex(shaSet);

  const states = new Map<string, EnvironmentState>();
  for (const e of sorted) {
    const slot = slots.get(e.id);
    if (!slot) continue;
    const placement = attribute(e, slot);
    const state = states.get(slot.key);
    if (state) {
      state.history.push(placement);
      state.current = placement;
    } else {
      const firstImage = placement.images[0]?.ref ?? placement.images[0]?.digest;
      states.set(slot.key, {
        ...slot,
        service: firstImage
          ? parseImageRef(firstImage).name
          : (e.target.project ?? e.target.repository ?? slot.label),
        current: placement,
        history: [placement],
      });
    }
  }
  return [...states.values()];

  function attribute(e: CorrelationEvent, slot: PlacementSlot): Placement {
    const notes: string[] = [];
    const evidence = new Set<string>();
    const placement: Placement = {
      eventId: e.id,
      at: e.occurredAt,
      environmentKey: slot.key,
      source: e.source,
      action: e.action,
      kind: placementKind(e),
      how: e.trigger.type,
      deploymentIds: e.correlation.deploymentIds ?? [],
      deploymentUrls: hintsOf(e).deploymentUrls,
      images: [],
      commits: [],
      attribution: { status: "unknown", confidence: null },
      notes,
      evidenceEventIds: [],
    };
    const actor = actorName(e);
    if (actor) placement.actor = actor;
    const finish = (status?: AttributionStatus) => {
      placement.evidenceEventIds = [...evidence];
      placement.attribution = summarise(placement, status);
      return placement;
    };

    const refs = e.correlation.imageRefs ?? [];
    const looseDigests = (e.correlation.imageDigests ?? []).filter(
      (d) => !refs.some((r) => parseImageRef(r).digest === d),
    );
    if (e.source === "argocd") {
      const sha = e.correlation.commitShas?.[0];
      if (sha) {
        const repository = repositoriesOf(e)[0];
        placement.configRevision = repository ? { repository, commitSha: sha } : { commitSha: sha };
      }
    }

    if (refs.length > 0 || looseDigests.length > 0) {
      // Content is defined by images. With one image name per event the
      // event-level digest list belongs to that image (`imageRefs` and
      // `imageDigests` are not paired unless the ref is digest-pinned).
      const singleDigest = refs.length <= 1 ? (e.correlation.imageDigests ?? []) : [];
      for (const ref of refs) {
        const p = parseImageRef(ref);
        const digests = p.digest ? [p.digest] : singleDigest;
        placement.images.push(attributeImage(imageTagKey(ref) ?? p.name, digests, e.occurredAt));
      }
      for (const d of looseDigests) {
        if (refs.length <= 1 && placement.images.length > 0) continue;
        placement.images.push(attributeImage(undefined, [d], e.occurredAt));
      }
      for (const img of placement.images) {
        for (const b of img.builds) evidence.add(b.eventId);
        for (const c of commitsFromImage(img)) addCommit(placement, c);
        if (img.builds.length === 0) {
          const label = img.ref ?? img.digest ?? "image";
          const tag = img.ref ? parseImageRef(img.ref).tag : undefined;
          const prefix = tag ? commitPrefixFromTag(tag) : undefined;
          const sha = prefix ? shas.unique(prefix) : undefined;
          if (sha) {
            addCommit(placement, {
              commitSha: sha,
              confidence: "probable",
              via: `tag of ${label} names the commit; no build observed`,
            });
          } else {
            notes.push(`${label} was not produced by any observed build`);
          }
        }
      }
      if (placement.commits.length === 0 && placement.configRevision) {
        notes.push(
          "config revision is known but the running image does not trace to an app commit",
        );
      }
      return finish();
    }

    // No images: the event's own commit is the content (Vercel, GitHub deployments).
    const direct = e.correlation.commitShas ?? [];
    const repos = repositoriesOf(e);
    for (const sha of direct) {
      addCommit(placement, {
        commitSha: sha,
        ...(repos[0] ? { repository: repos[0] } : {}),
        confidence: "certain",
        via: "commit on the deployment",
      });
    }
    if (direct.length > 0) return finish();

    // Same deployment observed elsewhere with its commit (e.g. a rollback event that only names the dpl id).
    for (const l of linksOf.get(e.id) ?? []) {
      if (!l.evidence.some((ev) => ev.kind === "same_deployment")) continue;
      const other = byId.get(l.from === e.id ? l.to : l.from)!;
      for (const sha of other.correlation.commitShas ?? []) {
        const repo = repositoriesOf(other)[0];
        evidence.add(other.id);
        addCommit(placement, {
          commitSha: sha,
          ...(repo ? { repository: repo } : {}),
          confidence: "certain",
          via: "same deployment id as an event with the commit",
        });
      }
    }
    if (placement.commits.length > 0) return finish();

    notes.push("no Git metadata on this deployment");
    for (const l of linksOf.get(e.id) ?? []) {
      const ev = l.evidence.find((x) => x.kind === "time_proximity");
      if (!ev) continue;
      const other = byId.get(l.from === e.id ? l.to : l.from)!;
      const sha = typeof other.data?.headCommit === "string" ? other.data.headCommit : undefined;
      const head = sha ?? other.correlation.commitShas?.[0];
      if (!head) continue;
      const repo = repositoriesOf(other)[0];
      evidence.add(other.id);
      addCommit(placement, {
        commitSha: head,
        ...(repo ? { repository: repo } : {}),
        confidence: "weak",
        via: `guess: ${ev.detail ?? "nearby push"}`,
      });
    }
    return finish(placement.commits.length > 0 ? "guess" : "unknown");
  }

  function attributeImage(
    tagKey: string | undefined,
    digests: string[],
    at: string,
  ): ImageAttribution {
    const img: ImageAttribution = { builds: [] };
    if (tagKey && tagKey.includes(":")) img.ref = tagKey;
    if (digests[0]) img.digest = digests[0];
    const viaDigest = new Set<Artifact>();
    for (const d of digests) for (const a of byDigest.get(d) ?? []) viaDigest.add(a);
    if (viaDigest.size > 0) {
      img.builds = [...viaDigest].flatMap((a) => candidates(a, "strong"));
      return img;
    }
    if (!img.ref) return img;
    // If the deployment knows its digest and no build matches it, the tag
    // match is contradicted: report no build.
    if (digests.length > 0) return img;
    const before = (byTag.get(img.ref) ?? []).filter((a) => a.firstAt <= at);
    const distinct = new Set(before.map((a) => a.digests.join(",")));
    const confidence: Confidence = before.length > 1 && distinct.size > 1 ? "weak" : "probable";
    const kept = before.slice(-maxCandidates);
    if (before.length > kept.length) img.buildsOmitted = before.length - kept.length;
    img.builds = kept.flatMap((a) => candidates(a, confidence));
    return img;
  }

  function candidates(a: Artifact, confidence: Confidence): BuildCandidate[] {
    if (a.commits.size === 0) return [{ eventId: a.id, confidence }];
    return [...a.commits].map(([commitSha, c]) => ({
      eventId: c.eventId,
      commitSha,
      ...(c.repository ? { repository: c.repository } : {}),
      confidence,
    }));
  }
}

function commitsFromImage(img: ImageAttribution): CommitAttribution[] {
  const withCommit = img.builds.filter((b) => b.commitSha);
  const distinct = new Set(withCommit.map((b) => `${b.repository}@${b.commitSha}`));
  const artifacts = new Set(img.builds.map((b) => b.eventId)).size + (img.buildsOmitted ?? 0);
  const label = img.ref ?? img.digest ?? "image";
  return withCommit.map((b) => {
    let confidence = b.confidence;
    let via = `${label} built by ${b.eventId} (${b.confidence === "strong" ? "digest match" : "tag match"})`;
    if (distinct.size > 1) {
      confidence = "weak";
      via = `${label}: ambiguous, ${artifacts} builds from ${distinct.size}${img.buildsOmitted ? "+" : ""} commits share the tag`;
    } else if (artifacts > 1) {
      // Several builds, all from the same commit: the commit is still probable.
      confidence = maxConfidence(confidence, "probable");
      via = `${label}: ${artifacts} builds share the tag, all from this commit`;
    }
    return {
      commitSha: b.commitSha!,
      ...(b.repository ? { repository: b.repository } : {}),
      confidence,
      via,
    };
  });
}

function addCommit(p: Placement, c: CommitAttribution) {
  const existing = p.commits.find(
    (x) => x.commitSha === c.commitSha && x.repository === c.repository,
  );
  if (!existing) p.commits.push(c);
  else if (maxConfidence(existing.confidence, c.confidence) !== existing.confidence) {
    existing.confidence = c.confidence;
    existing.via = c.via;
  }
}

function summarise(
  p: Placement,
  forced?: AttributionStatus,
): { status: AttributionStatus; confidence: Confidence | null } {
  if (p.commits.length === 0) return { status: "unknown", confidence: null };
  if (forced === "guess") return { status: "guess", confidence: "weak" };
  const ambiguous = p.images.some(
    (img) => new Set(img.builds.filter((b) => b.commitSha).map((b) => b.commitSha)).size > 1,
  );
  if (ambiguous) return { status: "ambiguous", confidence: "weak" };
  const weakest = p.commits.reduce<Confidence>(
    (c, x) => minConfidence(c, x.confidence),
    "certain",
  );
  return { status: "attributed", confidence: weakest };
}

/** Same content (commits and image digests) as another placement. */
export function sameContent(a: Placement, b: Placement): boolean {
  const key = (p: Placement) =>
    [
      ...p.commits.map((c) => `c:${c.repository}@${c.commitSha}`),
      ...p.images.map((i) => `i:${i.digest ?? i.ref}`),
    ]
      .sort()
      .join("|");
  return key(a) === key(b) && key(a) !== "";
}

/** The highest confidence of a placement's attribution to `sha`, if any. */
export function attributionTo(p: Placement, sha: string): Confidence | undefined {
  let best: Confidence | undefined;
  for (const c of p.commits)
    if (c.commitSha === sha)
      best = best && confidenceRank(best) >= confidenceRank(c.confidence) ? best : c.confidence;
  return best;
}
