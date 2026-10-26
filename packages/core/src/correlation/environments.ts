/**
 * Environment state: "what is live where, and how did it get there".
 *
 * A placement is an event after which something new is live in an
 * environment (a successful ArgoCD sync, a Vercel deployment that got the
 * production domains, a promotion, a rollback, a successful GitHub
 * deployment). For each placement we attribute the running content to app
 * commits, with a confidence:
 *
 * - If the placement names images (ArgoCD `status.summary.images`), the app
 *   commit comes from the build that produced the image (digest > tag), never
 *   from the config repository revision. A GitOps sync of config commit C runs
 *   whatever images C (or a parameter override) points at.
 * - Otherwise (Vercel, GitHub deployments) the event's own commit is the
 *   content, certain.
 * - Otherwise (no Git metadata, e.g. `vercel deploy` from a laptop) only a
 *   `time_proximity` guess remains, weak.
 */
import {
  byTime,
  commitPrefixFromTag,
  isBuildEvent,
  maxConfidence,
  parseImageRef,
  imageTagKey,
  repositoriesOf,
  type Confidence,
  type CorrelationEvent,
  type Link,
} from "./model.ts";

export interface BuildCandidate {
  eventId: string;
  commitSha?: string;
  repository?: string;
  confidence: Confidence;
}

export interface ImageAttribution {
  /** As deployed: "name:tag" and/or digest. */
  ref?: string;
  digest?: string;
  /** Builds that may have produced it; more than one means the tag is ambiguous. */
  builds: BuildCandidate[];
}

export interface CommitAttribution {
  repository?: string;
  commitSha: string;
  confidence: Confidence;
  /** Human-readable: how the commit was attributed. */
  via: string;
}

export interface Placement {
  eventId: string;
  at: string;
  environmentKey: string;
  /** trigger.type of the placing event (auto_sync, manual, cli, rollback, promotion...). */
  how: string;
  actor?: string;
  deploymentIds: string[];
  /** ArgoCD: the config (GitOps) repository revision that was synced. */
  configRevision?: { repository?: string; commitSha: string };
  images: ImageAttribution[];
  /** App commits the live content is attributed to; empty when unknown. */
  commits: CommitAttribution[];
  notes: string[];
}

export interface EnvironmentState {
  key: string;
  source: string;
  /** e.g. "staging", "production", "preview". */
  environment: string;
  /** Display label: ArgoCD application, Vercel project, GitHub repository. */
  label: string;
  /** Best guess at "the same service across environments": image name, Vercel project or repo. */
  service: string;
  current: Placement;
  /** Oldest first, including `current` as the last entry. */
  history: Placement[];
}

interface PlacementSlot {
  key: string;
  source: string;
  environment: string;
  label: string;
}

/** Whether an event is a placement, and into which environment slot. */
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
  // Preview environments are per branch: one slot per ref.
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

export function deriveEnvironmentStates(
  events: CorrelationEvent[],
  links: Link[],
): EnvironmentState[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const builds = events.filter(isBuildEvent);
  const linksOf = new Map<string, Link[]>();
  for (const l of links) {
    for (const id of [l.from, l.to]) {
      const list = linksOf.get(id);
      if (list) list.push(l);
      else linksOf.set(id, [l]);
    }
  }
  const allShas = [...new Set(events.flatMap((e) => e.correlation.commitShas ?? []))];

  const states = new Map<string, EnvironmentState>();
  for (const e of [...events].sort(byTime)) {
    const slot = placementSlot(e);
    if (!slot) continue;
    const placement = attribute(e, slot.key);
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

  function attribute(e: CorrelationEvent, environmentKey: string): Placement {
    const notes: string[] = [];
    const placement: Placement = {
      eventId: e.id,
      at: e.occurredAt,
      environmentKey,
      how: e.trigger.type,
      deploymentIds: e.correlation.deploymentIds ?? [],
      images: [],
      commits: [],
      notes,
    };
    const actor = e.actor.login ?? e.actor.name ?? e.actor.id;
    if (actor) placement.actor = actor;

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
      // event-level digest list belongs to that image (see doc: imageRefs and
      // imageDigests are not paired in the schema today).
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
        for (const c of commitsFromImage(img)) addCommit(placement, c);
        if (img.builds.length === 0) {
          const label = img.ref ?? img.digest ?? "image";
          const tag = img.ref ? parseImageRef(img.ref).tag : undefined;
          const prefix = tag ? commitPrefixFromTag(tag) : undefined;
          const matches = prefix ? allShas.filter((s) => s.startsWith(prefix)) : [];
          if (matches.length === 1) {
            addCommit(placement, {
              commitSha: matches[0]!,
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
      return placement;
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
    if (direct.length > 0) return placement;

    // Same deployment observed elsewhere with its commit (e.g. a rollback event that only names the dpl id).
    for (const l of linksOf.get(e.id) ?? []) {
      if (!l.evidence.some((ev) => ev.kind === "same_deployment")) continue;
      const other = byId.get(l.from === e.id ? l.to : l.from)!;
      for (const sha of other.correlation.commitShas ?? []) {
        const repo = repositoriesOf(other)[0];
        addCommit(placement, {
          commitSha: sha,
          ...(repo ? { repository: repo } : {}),
          confidence: "certain",
          via: "same deployment id as an event with the commit",
        });
      }
    }
    if (placement.commits.length > 0) return placement;

    notes.push("no Git metadata on this deployment");
    for (const l of linksOf.get(e.id) ?? []) {
      const ev = l.evidence.find((x) => x.kind === "time_proximity");
      if (!ev) continue;
      const other = byId.get(l.from === e.id ? l.to : l.from)!;
      const sha = typeof other.data?.headCommit === "string" ? other.data.headCommit : undefined;
      const head = sha ?? other.correlation.commitShas?.[0];
      if (!head) continue;
      const repo = repositoriesOf(other)[0];
      addCommit(placement, {
        commitSha: head,
        ...(repo ? { repository: repo } : {}),
        confidence: "weak",
        via: `guess: ${ev.detail ?? "nearby push"}`,
      });
    }
    return placement;
  }

  function attributeImage(
    tagKey: string | undefined,
    digests: string[],
    at: string,
  ): ImageAttribution {
    const img: ImageAttribution = { builds: [] };
    if (tagKey && tagKey.includes(":")) img.ref = tagKey;
    if (digests[0]) img.digest = digests[0];
    const byDigest = builds.filter(
      (b) => b.occurredAt <= at && digestsOf(b).some((d) => digests.includes(d)),
    );
    if (byDigest.length > 0) {
      img.builds = byDigest.flatMap((b) => candidates(b, "strong"));
      return img;
    }
    if (!img.ref) return img;
    const byTag = builds.filter(
      (b) =>
        b.occurredAt <= at &&
        (b.correlation.imageRefs ?? []).some((r) => imageTagKey(r) === img.ref),
    );
    // If the deployment knows its digest and no build matches it, the tag
    // match is contradicted: report no build.
    if (digests.length > 0) return img;
    const distinct = new Set(byTag.map((b) => digestsOf(b).sort().join(",")));
    const confidence: Confidence = byTag.length > 1 && distinct.size > 1 ? "weak" : "probable";
    img.builds = byTag.flatMap((b) => candidates(b, confidence));
    return img;
  }

  function candidates(b: CorrelationEvent, confidence: Confidence): BuildCandidate[] {
    const repo = repositoriesOf(b)[0];
    const shas = b.correlation.commitShas ?? [];
    if (shas.length === 0) return [{ eventId: b.id, confidence }];
    return shas.map((commitSha) => ({
      eventId: b.id,
      commitSha,
      ...(repo ? { repository: repo } : {}),
      confidence,
    }));
  }
}

function commitsFromImage(img: ImageAttribution): CommitAttribution[] {
  const withCommit = img.builds.filter((b) => b.commitSha);
  const distinct = new Set(withCommit.map((b) => `${b.repository}@${b.commitSha}`));
  const label = img.ref ?? img.digest ?? "image";
  return withCommit.map((b) => {
    let confidence = b.confidence;
    let via = `${label} built by ${b.eventId} (${b.confidence === "strong" ? "digest match" : "tag match"})`;
    if (img.builds.length > 1) {
      if (distinct.size === 1) {
        // Several builds, all from the same commit: the commit is still probable.
        confidence = maxConfidence(confidence, "probable");
        via = `${label}: ${img.builds.length} builds share the tag, all from this commit`;
      } else {
        via = `${label}: ambiguous, ${img.builds.length} builds from ${distinct.size} commits share the tag`;
      }
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

function digestsOf(e: CorrelationEvent): string[] {
  return [
    ...(e.correlation.imageDigests ?? []),
    ...(e.correlation.imageRefs ?? []).flatMap((r) => parseImageRef(r).digest ?? []),
  ];
}
