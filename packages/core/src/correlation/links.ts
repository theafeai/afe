/**
 * Link building: given canonical events, find pairs that refer to the same
 * thing and record typed evidence for each pair. Links are undirected facts
 * stored from the earlier event to the later one.
 */
import {
  byTime,
  commitPrefixFromTag,
  EVIDENCE_CONFIDENCE,
  hintsOf,
  imageTagKey,
  isBuildEvent,
  isChangeEvent,
  isDeployEvent,
  maxConfidence,
  parseImageRef,
  repositoriesOf,
  type Conflict,
  type CorrelationEvent,
  type Evidence,
  type EvidenceKind,
  type Link,
} from "./model.ts";

export interface LinkOptions {
  /** Window for `time_proximity` guesses (default 6 hours). */
  proximityWindowMs?: number;
}

export interface LinkResult {
  links: Link[];
  conflicts: Conflict[];
}

const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;

export function buildLinks(events: CorrelationEvent[], options: LinkOptions = {}): LinkResult {
  const window = options.proximityWindowMs ?? DEFAULT_WINDOW_MS;
  const byId = new Map(events.map((e) => [e.id, e]));
  const pairs = new Map<string, Link>();
  const conflicts: Conflict[] = [];

  const add = (aId: string, bId: string, kind: EvidenceKind, key: string, detail?: string) => {
    if (aId === bId) return;
    const a = byId.get(aId)!;
    const b = byId.get(bId)!;
    const [from, to] = byTime(a, b) <= 0 ? [a, b] : [b, a];
    const pairKey = `${from.id}\u0000${to.id}`;
    let link = pairs.get(pairKey);
    if (!link) {
      link = { from: from.id, to: to.id, confidence: "weak", evidence: [] };
      pairs.set(pairKey, link);
    }
    if (link.evidence.some((ev) => ev.kind === kind && ev.key === key)) return;
    const ev: Evidence = { kind, confidence: EVIDENCE_CONFIDENCE[kind], key };
    if (detail) ev.detail = detail;
    link.evidence.push(ev);
    link.confidence = link.evidence.reduce(
      (c, x) => maxConfidence(c, x.confidence),
      link.evidence[0]!.confidence,
    );
  };

  const index = (keysOf: (e: CorrelationEvent) => string[] | undefined) => {
    const m = new Map<string, string[]>();
    for (const e of events) {
      for (const k of new Set(keysOf(e) ?? [])) {
        const list = m.get(k);
        if (list) list.push(e.id);
        else m.set(k, [e.id]);
      }
    }
    return m;
  };
  const eachPair = (ids: string[], fn: (a: string, b: string) => void) => {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) fn(ids[i]!, ids[j]!);
  };

  // 1. Same object in the same tool: deployment ids and CI run ids are exact.
  for (const [k, ids] of index((e) => e.correlation.deploymentIds))
    eachPair(ids, (a, b) => add(a, b, "same_deployment", `deployment:${k}`));
  for (const [k, ids] of index((e) => e.correlation.runIds))
    eachPair(ids, (a, b) => add(a, b, "same_run", `run:${k}`));

  // 2. Commit SHAs: certain within one repository, strong across repositories.
  const commitIndex = index((e) => e.correlation.commitShas);
  for (const [sha, ids] of commitIndex) {
    eachPair(ids, (a, b) => {
      const ra = repositoriesOf(byId.get(a)!);
      const rb = new Set(repositoriesOf(byId.get(b)!));
      const shared = ra.some((r) => rb.has(r));
      add(a, b, shared ? "same_commit_same_repo" : "same_commit", `commit:${sha}`);
    });
  }

  // 3. Image digests (content addressed) and deployment URLs.
  const digestIndex = index((e) => [
    ...(e.correlation.imageDigests ?? []),
    ...(e.correlation.imageRefs ?? []).flatMap((r) => parseImageRef(r).digest ?? []),
  ]);
  for (const [d, ids] of digestIndex)
    eachPair(ids, (a, b) => add(a, b, "same_image_digest", `digest:${d}`));
  for (const [u, ids] of index((e) => hintsOf(e).deploymentUrls))
    eachPair(ids, (a, b) => add(a, b, "same_deployment_url", `url:${u}`));

  // 4. References: a commit message or PR (e.g. a GitOps bump) names a SHA or digest.
  for (const e of events) {
    const h = hintsOf(e);
    for (const sha of h.upstreamCommitShas)
      for (const other of commitIndex.get(sha) ?? [])
        add(e.id, other, "reference", `commit:${sha}`);
    for (const d of h.mentionedImageDigests)
      for (const other of digestIndex.get(d) ?? []) add(e.id, other, "reference", `digest:${d}`);
  }

  // 5. Image tags. Probable when one build produced the tag; weak when several
  // builds with different digests did (the tag was moved). A tag match whose
  // digests contradict is not a link but a conflict.
  for (const [tagKey, ids] of index((e) =>
    (e.correlation.imageRefs ?? []).flatMap((r) => imageTagKey(r) ?? []),
  )) {
    const builds = ids.map((id) => byId.get(id)!).filter(isBuildEvent);
    eachPair(ids, (a, b) => {
      // Only builds that existed when the later of the two events happened count.
      const later = byTime(byId.get(a)!, byId.get(b)!) <= 0 ? byId.get(b)! : byId.get(a)!;
      const before = builds.filter((x) => x.occurredAt <= later.occurredAt);
      const distinct = new Set(before.map((x) => digestsOf(x).sort().join(",")));
      const mutable = before.length > 1 && distinct.size > 1;
      const da = digestsOf(byId.get(a)!);
      const db = digestsOf(byId.get(b)!);
      if (da.length > 0 && db.length > 0 && !da.some((d) => db.includes(d))) {
        conflicts.push({
          kind: "tag_digest_mismatch",
          events: [a, b],
          key: `image:${tagKey}`,
          detail: `same tag, different digests (${da.join(",")} vs ${db.join(",")})`,
        });
        return;
      }
      if (mutable) {
        add(
          a,
          b,
          "same_mutable_image_tag",
          `image:${tagKey}`,
          `tag produced by ${before.length} builds`,
        );
      } else {
        add(a, b, "same_image_tag", `image:${tagKey}`);
      }
    });
  }

  // 6. Tags that encode a commit SHA ("<sha>", "sha-<short>").
  const allShas = [...commitIndex.keys()];
  for (const e of events) {
    for (const ref of e.correlation.imageRefs ?? []) {
      const tag = parseImageRef(ref).tag;
      const prefix = tag ? commitPrefixFromTag(tag) : undefined;
      if (!prefix) continue;
      const matches = allShas.filter((s) => s.startsWith(prefix));
      if (matches.length !== 1) continue; // ambiguous short SHA: do not guess
      for (const other of commitIndex.get(matches[0]!) ?? [])
        add(e.id, other, "image_tag_names_commit", `commit:${matches[0]}`, `tag ${tag}`);
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
  const deploymentIndex = index((e) => e.correlation.deploymentIds);
  const pushes = events.filter(isChangeEvent).sort(byTime);
  for (const e of events) {
    if (!isDeployEvent(e) || hasIdentifiers(e)) continue;
    const siblings = (e.correlation.deploymentIds ?? []).flatMap(
      (d) => deploymentIndex.get(d) ?? [],
    );
    if (siblings.some((id) => hasIdentifiers(byId.get(id)!))) continue;
    const repos = new Set(repositoriesOf(e));
    const t = Date.parse(e.occurredAt);
    const candidate = pushes
      .filter((p) => {
        const pt = Date.parse(p.occurredAt);
        return pt <= t && t - pt <= window && repositoriesOf(p).some((r) => repos.has(r));
      })
      .at(-1);
    if (candidate) {
      const minutes = Math.round((t - Date.parse(candidate.occurredAt)) / 60000);
      add(
        candidate.id,
        e.id,
        "time_proximity",
        `repository:${repositoriesOf(candidate).find((r) => repos.has(r))}`,
        `nearest earlier push, ${minutes} min before`,
      );
    }
  }

  return { links: [...pairs.values()], conflicts };
}

function digestsOf(e: CorrelationEvent): string[] {
  return [
    ...new Set([
      ...(e.correlation.imageDigests ?? []),
      ...(e.correlation.imageRefs ?? []).flatMap((r) => parseImageRef(r).digest ?? []),
    ]),
  ];
}
