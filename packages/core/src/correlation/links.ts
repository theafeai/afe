/**
 * Link building: given canonical events, find pairs that refer to the same
 * thing and record typed evidence for each pair. Links are undirected facts
 * stored from the earlier event to the later one.
 *
 * Cost (AFE-20): events are grouped per key ("bucket", e.g. one commit SHA).
 * Buckets up to `pairwiseLimit` events are linked pairwise. Larger buckets
 * (hot keys: a long-lived config commit, `:latest`, a busy deployment id)
 * are linked as a chain in time order plus a link to the bucket's first
 * event, so the link count stays linear in the number of events and every
 * member stays reachable forward in time with the same evidence kind.
 * Image tags in large buckets link each event to the most recent builds of
 * that tag that existed at its time (`maxTagBuilds`). Measured in
 * docs/correlation.md.
 */
import {
  sortedByTime,
  commitPrefixFromTag,
  digestsOf,
  EVIDENCE_CONFIDENCE,
  hintsOf,
  isBuildEvent,
  isChangeEvent,
  isDeployEvent,
  maxConfidence,
  parseImageRef,
  repositoriesOf,
  ShaPrefixIndex,
  type Conflict,
  type CorrelationEvent,
  type CorrelationHints,
  type Evidence,
  type EvidenceKind,
  type Link,
} from "./model.ts";

export interface LinkOptions {
  /** Window for `time_proximity` guesses (default 6 hours). */
  proximityWindowMs?: number;
  /** Buckets up to this size are linked pairwise (default 24). */
  pairwiseLimit?: number;
  /** Large tag buckets: builds linked per event (most recent first, default 5). */
  maxTagBuilds?: number;
}

export interface LinkResult {
  links: Link[];
  conflicts: Conflict[];
}

export const DEFAULT_PROXIMITY_WINDOW_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PAIRWISE_LIMIT = 24;
export const DEFAULT_MAX_TAG_BUILDS = 5;

/** What linking reads from an event, computed once. */
interface Features {
  e: CorrelationEvent;
  digests: string[];
  /** Sorted digests joined: identifies the content of a build. */
  digestKey: string;
  tagKeys: string[];
  /** Tags of `imageRefs` (for tags that name a commit). */
  tags: string[];
  hints: CorrelationHints;
  build: boolean;
}

function featuresOf(e: CorrelationEvent): Features {
  const digests = digestsOf(e);
  const tagKeys: string[] = [];
  const tags: string[] = [];
  for (const r of e.correlation.imageRefs ?? []) {
    const p = parseImageRef(r);
    if (p.tag) {
      tagKeys.push(`${p.name}:${p.tag}`);
      tags.push(p.tag);
    }
  }
  return {
    e,
    digests,
    digestKey: [...digests].sort().join(","),
    tagKeys,
    tags,
    hints: hintsOf(e),
    build: isBuildEvent(e),
  };
}

export function buildLinks(events: CorrelationEvent[], options: LinkOptions = {}): LinkResult {
  const window = options.proximityWindowMs ?? DEFAULT_PROXIMITY_WINDOW_MS;
  const pairwiseLimit = options.pairwiseLimit ?? DEFAULT_PAIRWISE_LIMIT;
  const maxTagBuilds = options.maxTagBuilds ?? DEFAULT_MAX_TAG_BUILDS;
  const f = sortedByTime(events).map(featuresOf);
  const n = f.length;
  const pairs = new Map<number, Link>();
  const conflicts = new Map<string, Conflict>();

  /** Adds evidence between events i and j (indices in time order). */
  const add = (i: number, j: number, kind: EvidenceKind, key: string, detail?: string) => {
    if (i === j) return;
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    const pairKey = a * n + b;
    const confidence = EVIDENCE_CONFIDENCE[kind];
    let link = pairs.get(pairKey);
    if (!link) {
      link = { from: f[a]!.e.id, to: f[b]!.e.id, confidence, evidence: [] };
      pairs.set(pairKey, link);
    } else if (link.evidence.some((ev) => ev.kind === kind && ev.key === key)) {
      return;
    }
    const ev: Evidence = { kind, confidence, key };
    if (detail) ev.detail = detail;
    link.evidence.push(ev);
    link.confidence = maxConfidence(link.confidence, confidence);
  };
  const conflict = (dedupe: string, c: Omit<Conflict, "events">, i: number, j: number) => {
    if (conflicts.has(dedupe)) return;
    conflicts.set(dedupe, { ...c, events: [f[Math.min(i, j)]!.e.id, f[Math.max(i, j)]!.e.id] });
  };

  /** key → event indices in time order. */
  const index = (keysOf: (x: Features) => readonly string[] | undefined) => {
    const m = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const keys = keysOf(f[i]!);
      if (!keys) continue;
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k]!;
        if (k > 0 && keys.indexOf(key) < k) continue; // duplicate within the event
        const list = m.get(key);
        if (list) list.push(i);
        else m.set(key, [i]);
      }
    }
    return m;
  };
  /** Pairwise for small buckets; chain + first for large ones. */
  const linkBucket = (ids: number[], fn: (a: number, b: number) => void) => {
    if (ids.length <= pairwiseLimit) {
      for (let x = 0; x < ids.length; x++)
        for (let y = x + 1; y < ids.length; y++) fn(ids[x]!, ids[y]!);
      return;
    }
    for (let x = 1; x < ids.length; x++) {
      fn(ids[x - 1]!, ids[x]!);
      if (x > 1) fn(ids[0]!, ids[x]!);
    }
  };
  /** Bucket members a referencing event is linked to: all (small bucket) or the first. */
  const anchors = (ids: number[] | undefined) =>
    !ids ? [] : ids.length <= pairwiseLimit ? ids : ids.slice(0, 1);

  // 1. Same object in the same tool: deployment ids and CI run ids are exact.
  const deploymentIndex = index((x) => x.e.correlation.deploymentIds);
  for (const [k, ids] of deploymentIndex)
    linkBucket(ids, (a, b) => add(a, b, "same_deployment", `deployment:${k}`));
  for (const [k, ids] of index((x) => x.e.correlation.runIds))
    linkBucket(ids, (a, b) => add(a, b, "same_run", `run:${k}`));

  // 2. Commit SHAs: certain within one repository, strong across repositories.
  const commitIndex = index((x) => x.e.correlation.commitShas);
  for (const [sha, ids] of commitIndex) {
    linkBucket(ids, (a, b) => {
      const ra = repositoriesOf(f[a]!.e);
      const rb = repositoriesOf(f[b]!.e);
      const shared = ra.some((r) => rb.includes(r));
      add(a, b, shared ? "same_commit_same_repo" : "same_commit", `commit:${sha}`);
    });
  }

  // 3. Image digests (content addressed) and deployment URLs.
  const digestIndex = index((x) => x.digests);
  for (const [d, ids] of digestIndex) {
    linkBucket(ids, (a, b) => add(a, b, "same_image_digest", `digest:${d}`));
    // Builds of one digest that claim different commits contradict each other.
    const claims = new Map<string, number>();
    for (const i of ids) {
      if (!f[i]!.build) continue;
      for (const sha of f[i]!.e.correlation.commitShas ?? [])
        if (!claims.has(sha)) claims.set(sha, i);
    }
    if (claims.size > 1) {
      const [[s1, i1], [s2, i2]] = [...claims] as [[string, number], [string, number]];
      conflict(
        `dc:${d}`,
        {
          kind: "digest_commit_mismatch",
          key: `digest:${d}`,
          detail: `builds of one digest name different commits (${s1.slice(0, 12)} vs ${s2.slice(0, 12)})`,
        },
        i1,
        i2,
      );
    }
  }
  for (const [u, ids] of index((x) => x.hints.deploymentUrls))
    linkBucket(ids, (a, b) => add(a, b, "same_deployment_url", `url:${u}`));

  // 4. References: a commit message or PR (e.g. a GitOps bump) names a SHA or digest.
  for (let i = 0; i < n; i++) {
    const h = f[i]!.hints;
    for (const sha of h.upstreamCommitShas)
      for (const other of anchors(commitIndex.get(sha)))
        add(i, other, "reference", `commit:${sha}`);
    for (const d of h.mentionedImageDigests)
      for (const other of anchors(digestIndex.get(d))) add(i, other, "reference", `digest:${d}`);
  }

  // 5. Image tags. Probable when one build produced the tag by then; weak when
  // several builds with different digests did (the tag was moved). A tag match
  // whose digests contradict is not a link but a conflict.
  for (const [tagKey, ids] of index((x) => x.tagKeys)) {
    // Running state in time order: builds so far, distinct contents so far.
    const buildsBefore: number[][] = [];
    const buildCount: number[] = [];
    const mutable: boolean[] = [];
    const builds: number[] = [];
    const distinct = new Set<string>();
    for (const i of ids) {
      if (f[i]!.build) {
        builds.push(i);
        distinct.add(f[i]!.digestKey);
      }
      buildsBefore.push(builds.slice(-maxTagBuilds));
      buildCount.push(builds.length);
      mutable.push(builds.length > 1 && distinct.size > 1);
    }
    const tagLink = (a: number, b: number, laterPos: number) => {
      const da = f[a]!.digests;
      const db = f[b]!.digests;
      if (da.length > 0 && db.length > 0 && !da.some((d) => db.includes(d))) {
        const [x, y] = [f[a]!.digestKey, f[b]!.digestKey].sort() as [string, string];
        conflict(
          `td:${tagKey}:${x}:${y}`,
          {
            kind: "tag_digest_mismatch",
            key: `image:${tagKey}`,
            detail: `same tag, different digests (${x} vs ${y})`,
          },
          a,
          b,
        );
        return;
      }
      if (mutable[laterPos]) {
        const detail = `tag produced by ${buildCount[laterPos]} builds`;
        add(a, b, "same_mutable_image_tag", `image:${tagKey}`, detail);
      } else {
        add(a, b, "same_image_tag", `image:${tagKey}`);
      }
    };
    if (ids.length <= pairwiseLimit) {
      for (let x = 0; x < ids.length; x++)
        for (let y = x + 1; y < ids.length; y++) tagLink(ids[x]!, ids[y]!, y);
    } else {
      let prevBuild = -1;
      ids.forEach((i, pos) => {
        if (f[i]!.build) {
          // A moved tag: consecutive builds with different content.
          if (prevBuild >= 0) tagLink(prevBuild, i, pos);
          prevBuild = i;
          return;
        }
        for (const b of buildsBefore[pos]!) tagLink(b, i, pos);
      });
    }
  }

  // 6. Tags that encode a commit SHA ("<sha>", "sha-<short>").
  const shas = new ShaPrefixIndex(commitIndex.keys());
  for (let i = 0; i < n; i++) {
    for (const tag of f[i]!.tags) {
      const prefix = commitPrefixFromTag(tag);
      if (!prefix) continue;
      const sha = shas.unique(prefix); // ambiguous short SHA: do not guess
      if (!sha) continue;
      for (const other of anchors(commitIndex.get(sha)))
        add(i, other, "image_tag_names_commit", `commit:${sha}`, `tag ${tag}`);
    }
  }

  // 7. Orphans: a deploy event that (with every event sharing its deployment
  // id) carries no commit and no image gets a weak guess: the nearest earlier
  // push to the same repository within the window.
  const hasIdentifiers = (e: CorrelationEvent) =>
    Boolean(
      e.correlation.commitShas?.length ||
      e.correlation.imageRefs?.length ||
      e.correlation.imageDigests?.length,
    );
  const pushesByRepo = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (!isChangeEvent(f[i]!.e)) continue;
    for (const r of repositoriesOf(f[i]!.e)) {
      const list = pushesByRepo.get(r);
      if (list) list.push(i);
      else pushesByRepo.set(r, [i]);
    }
  }
  for (let i = 0; i < n; i++) {
    const e = f[i]!.e;
    if (!isDeployEvent(e) || hasIdentifiers(e)) continue;
    const siblings = (e.correlation.deploymentIds ?? []).flatMap(
      (d) => deploymentIndex.get(d) ?? [],
    );
    if (siblings.some((s) => hasIdentifiers(f[s]!.e))) continue;
    const t = Date.parse(e.occurredAt);
    let best: { push: number; repo: string } | undefined;
    for (const repo of repositoriesOf(e)) {
      const p = latestBefore(pushesByRepo.get(repo) ?? [], i);
      if (p === undefined || t - Date.parse(f[p]!.e.occurredAt) > window) continue;
      if (!best || best.push < p) best = { push: p, repo };
    }
    if (best) {
      const minutes = Math.round((t - Date.parse(f[best.push]!.e.occurredAt)) / 60000);
      add(
        best.push,
        i,
        "time_proximity",
        `repository:${best.repo}`,
        `nearest earlier push, ${minutes} min before`,
      );
    }
  }

  return { links: [...pairs.values()], conflicts: [...conflicts.values()] };
}

/** The largest index in the ascending list that is below `i`. */
function latestBefore(list: number[], i: number): number | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]! < i) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? list[lo - 1] : undefined;
}
