/**
 * "What is live where" for one repository (AFE-22): the latest successful
 * placement (deployment, promotion, rollback, ArgoCD sync) per environment,
 * from recent events within the retention window.
 *
 * Deliberately small: AFE-20 (correlation service) provides the canonical
 * environment state later; this only answers "which commit of repository R
 * is live in each environment", which commit containment needs.
 */
import { normaliseEventFilter, repositoryKey, type CanonicalEvent } from "@afe/core";
import { queryEvents } from "@afe/db";
import type { ServerContext } from "../context.ts";

/** Actions that can make something live (filtered further by `isPlacement`). */
export const PLACEMENT_ACTIONS = [
  "argocd.sync.succeeded",
  "deployment.status_updated",
  "deployment.promoted",
  "deployment.rolled_back",
] as const;

/** At most this many placements (newest first) are read per request. */
export const DEFAULT_MAX_PLACEMENT_EVENTS = 1000;
/** At most this many event ids are listed as evidence per environment. */
const MAX_EVIDENCE = 5;

export interface LiveDeployment {
  /** Slot key: mapped environment id, or `raw:<name>` (plus `@<ref>` for previews). */
  key: string;
  /** Display name: the mapped environment's name, else the tool's name. */
  environment: string;
  /** Mapped environment id (AFE-19), or null when the tool's raw name is used. */
  environmentId: string | null;
  /** Tool of the latest placement. */
  source: string;
  /** Live commit of the repository, or null when the placement names none (or several). */
  liveCommit: string | null;
  /** Earliest of the consecutive latest placements of `liveCommit` in this slot. */
  liveSince: string;
  /** Placement event ids, newest first (at most 5). */
  evidence: string[];
}

export interface LiveResult {
  deployments: LiveDeployment[];
  /** True when more placements exist than were read (older ones were not considered). */
  truncated: boolean;
  /** Retention cutoff applied (ISO), or null when unlimited. */
  since: string | null;
}

/** Whether an event put something live (same rule as the correlation prototype). */
export function isPlacement(e: CanonicalEvent): boolean {
  switch (e.action) {
    case "argocd.sync.succeeded":
    case "deployment.promoted":
    case "deployment.rolled_back":
      return true;
    case "deployment.status_updated":
      // Vercel: a successful build that did not get the domains is not live.
      return e.outcome === "succeeded" && e.data?.aliasAssigned !== false;
    default:
      return false;
  }
}

/** Repository keys an event is about: `correlation.repositories` and `target.repository`. */
function repositoriesOf(e: CanonicalEvent): Set<string> {
  const out = new Set(e.correlation.repositories ?? []);
  const t = e.target.repository;
  if (t && t.includes("/")) {
    try {
      out.add(repositoryKey(t));
    } catch {
      // not a repository identifier
    }
  }
  return out;
}

/**
 * The commit of `repoKey` an event placed, when unambiguous: the event is
 * about that repository only and carries exactly one commit SHA. Events that
 * name several repositories (multi-source ArgoCD apps) or commits are not
 * attributed (null).
 */
export function placedCommit(e: CanonicalEvent, repoKey: string): string | null {
  const repos = repositoriesOf(e);
  if (repos.size !== 1 || !repos.has(repoKey)) return null;
  const shas = e.correlation.commitShas ?? [];
  return shas.length === 1 ? shas[0]! : null;
}

function rawEnvironment(e: CanonicalEvent): string {
  return e.target.environment ?? e.correlation.environments?.[0] ?? "unknown";
}

/**
 * Latest placement per environment for one repository ("owner/name" or any
 * form `repositoryKey` accepts), newest environment first.
 */
export async function liveDeployments(
  ctx: Pick<ServerContext, "pool" | "retention" | "mapping">,
  tenantId: string,
  repository: string,
  options: { now?: Date; maxEvents?: number } = {},
): Promise<LiveResult> {
  const now = options.now ?? new Date();
  const repoKey = repositoryKey(repository);
  const cutoff = await ctx.retention.cutoff(tenantId, now);
  const filter = normaliseEventFilter({
    actions: [...PLACEMENT_ACTIONS],
    repositories: [repository],
    ...(cutoff ? { occurredFrom: cutoff.toISOString() } : {}),
  });
  const page = await queryEvents(ctx.pool, tenantId, {
    filter,
    order: "desc",
    limit: options.maxEvents ?? DEFAULT_MAX_PLACEMENT_EVENTS,
  });
  const events = page.events.filter((e) => isPlacement(e) && repositoriesOf(e).has(repoKey));
  const placements = ctx.mapping ? await ctx.mapping.placements(tenantId, events) : null;

  const slots = new Map<string, LiveDeployment & { open: boolean }>();
  for (const e of events) {
    const mapped = placements?.get(e.id)?.environment ?? null;
    const raw = rawEnvironment(e);
    const preview = mapped ? mapped.kind === "preview" : raw.toLowerCase().startsWith("preview");
    const base = mapped ? mapped.id : `raw:${raw.toLowerCase()}`;
    // Preview environments are per branch: one slot per ref.
    const key = preview && e.target.ref ? `${base}@${e.target.ref}` : base;
    const commit = placedCommit(e, repoKey);
    const slot = slots.get(key);
    if (!slot) {
      const name = mapped ? mapped.name : raw;
      slots.set(key, {
        key,
        environment:
          preview && e.target.ref
            ? `${name} (${e.target.ref.replace(/^refs\/heads\//, "")})`
            : name,
        environmentId: mapped ? mapped.id : null,
        source: e.source,
        liveCommit: commit,
        liveSince: e.occurredAt,
        evidence: [e.id],
        open: true,
      });
      continue;
    }
    // Older placement: extends "live since" while it placed the same commit.
    if (!slot.open) continue;
    if (commit !== null && commit === slot.liveCommit) {
      slot.liveSince = e.occurredAt;
      if (slot.evidence.length < MAX_EVIDENCE) slot.evidence.push(e.id);
    } else {
      slot.open = false;
    }
  }
  return {
    deployments: [...slots.values()].map(({ open: _open, ...d }) => d),
    truncated: page.nextCursor !== null,
    since: cutoff ? cutoff.toISOString() : null,
  };
}
