/**
 * Per-user source access cache (M1, P4; security review P4 conditions 1-9).
 *
 * Each managed user's GitHub repository access, as their own linked account
 * reported it, is stored in `user_source_access` for at most five minutes and
 * served to **read views only** (event lists and details, environments, journeys,
 * drift, mapping, run metadata). Everything that acts or reads protected content
 * (mutations, prepare/confirm, receipt replay, log reads, artifact and archive
 * downloads, workflow-source reads, automations, notification sends) keeps the
 * live check of ADR 0014: those paths pass `{ live: true }` or never use this.
 *
 * - The TTL is a hard limit, measured on the server clock: an older row is never
 *   served. A failed refresh deletes the row and denies; there is no grace period.
 * - Rows are bound to the linked credential: relinking never reuses old rules.
 * - Local changes invalidate immediately (unlink, relink, policy or deny-rule
 *   change, disable, deletion): the row is deleted before the request returns and
 *   listeners (the correlation snapshot cache) drop that user's fingerprint entry.
 * - Rules never leave the server and are never shown to other users.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { EventAccessRule } from "@afe/core";
import { deleteUserSourceAccess, getUserSourceAccess, putUserSourceAccess } from "@afe/db";

/** Five minutes: the longest a revoked upstream grant may stay visible in read views. */
export const ACCESS_CACHE_TTL_MS = 5 * 60_000;
/** Tools whose access is cached. Other tools are always checked live. */
export const CACHED_TOOLS: ReadonlySet<string> = new Set(["github"]);

/** Canonical, order-independent form of an access rule list. */
export function canonicalRules(rules: readonly EventAccessRule[]): EventAccessRule[] {
  const canon = rules.map((r) => ({
    source: r.source,
    resource: r.resource,
    ...(r.connectionId !== undefined ? { connectionId: r.connectionId } : {}),
    ...(r.targetId !== undefined ? { targetId: r.targetId } : {}),
  }));
  return [...new Map(canon.map((r) => [JSON.stringify(r), r])).values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

/** SHA-256 of the canonical sorted rule list. Combined with the tenant id as the snapshot key. */
export function accessFingerprint(rules: readonly EventAccessRule[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalRules(rules)))
    .digest("hex");
}

export interface AccessCacheOptions {
  /** At most ACCESS_CACHE_TTL_MS; larger values are clamped. */
  ttlMs?: number;
  /** Clock in epoch milliseconds (tests). */
  now?: () => number;
}

type Listener = (tenantId: string, fingerprint: string) => void;

export class AccessCache {
  readonly ttlMs: number;
  readonly #now: () => number;
  readonly #listeners = new Set<Listener>();
  /** Last fingerprint served per (tenant, user), so invalidation can drop its snapshot. */
  readonly #fingerprints = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<EventAccessRule[]>>();

  constructor(
    readonly pool: pg.Pool,
    options: AccessCacheOptions = {},
  ) {
    this.ttlMs = Math.max(0, Math.min(options.ttlMs ?? ACCESS_CACHE_TTL_MS, ACCESS_CACHE_TTL_MS));
    this.#now = options.now ?? Date.now;
  }

  now(): number {
    return this.#now();
  }

  /** Fresh cached rules, or null (miss, expired, other credential). A miss never means "unrestricted". */
  async read(
    tenantId: string,
    userId: string,
    tool: string,
    credentialId: string,
  ): Promise<EventAccessRule[] | null> {
    if (!CACHED_TOOLS.has(tool) || this.ttlMs === 0) return null;
    const row = await getUserSourceAccess(this.pool, tenantId, userId, tool, credentialId);
    if (!row) return null;
    const age = this.#now() - row.fetchedAt.getTime();
    // Hard limit; a row from the future (clock skew) is not trusted either.
    if (age >= this.ttlMs || age < -60_000) return null;
    return row.rules;
  }

  /**
   * Runs `fetch` once per (tenant, user, tool, credential) at a time and stores its
   * result. A failure deletes the cached row and rethrows (deny).
   */
  async refresh(
    tenantId: string,
    userId: string,
    tool: string,
    credentialId: string,
    fetch: () => Promise<EventAccessRule[]>,
  ): Promise<EventAccessRule[]> {
    const key = JSON.stringify([tenantId, userId, tool, credentialId]);
    const running = this.#inflight.get(key);
    if (running) return running;
    const run: Promise<EventAccessRule[]> = (async () => {
      const fetchedAt = new Date(this.#now());
      let rules: EventAccessRule[];
      try {
        rules = canonicalRules(await fetch());
      } catch (error) {
        await deleteUserSourceAccess(this.pool, tenantId, userId, tool);
        throw error;
      }
      if (CACHED_TOOLS.has(tool) && this.ttlMs > 0)
        await putUserSourceAccess(
          this.pool,
          tenantId,
          userId,
          tool,
          credentialId,
          rules,
          fetchedAt,
        ).catch(() => false);
      return rules;
    })().finally(() => {
      if (this.#inflight.get(key) === run) this.#inflight.delete(key);
    });
    this.#inflight.set(key, run);
    return run;
  }

  /** Records the fingerprint a user's read view was computed with. */
  noteFingerprint(tenantId: string, userId: string, fingerprint: string): void {
    const key = `${tenantId}\0${userId}`;
    this.#fingerprints.delete(key);
    this.#fingerprints.set(key, fingerprint);
    // Bounded: oldest notes go first (they only speed up invalidation).
    while (this.#fingerprints.size > 10_000)
      this.#fingerprints.delete(this.#fingerprints.keys().next().value!);
  }

  /**
   * Drops the user's cached access (all tools unless `tool` is given) and their
   * snapshot entry, before the caller returns. Pass the transaction client when
   * the local change runs in a transaction.
   */
  async invalidate(
    db: pg.Pool | pg.PoolClient,
    tenantId: string,
    userId: string,
    tool?: string,
  ): Promise<void> {
    await deleteUserSourceAccess(db, tenantId, userId, tool);
    this.forgetUser(tenantId, userId);
  }

  /** In-memory part of `invalidate` (after the database rows are gone). */
  forgetUser(tenantId: string, userId: string): void {
    const key = `${tenantId}\0${userId}`;
    const fingerprint = this.#fingerprints.get(key);
    this.#fingerprints.delete(key);
    // Later reads must not join a refresh that started before the change.
    const prefix = JSON.stringify([tenantId, userId]).slice(0, -1) + ",";
    for (const k of [...this.#inflight.keys()]) if (k.startsWith(prefix)) this.#inflight.delete(k);
    if (fingerprint) for (const l of this.#listeners) l(tenantId, fingerprint);
  }

  onInvalidate(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
