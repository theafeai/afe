/**
 * Cache of access-scoped correlation snapshots (ADR 0020).
 *
 * A scoped snapshot is built only from the events one access rule set can see
 * (filter before linking, as before), so users with the same rules can share it.
 * Entries are keyed by tenant id **and** the SHA-256 of the canonical sorted rule
 * list: the tenant is part of the key structure, not only a hash input. Entries
 * hold no per-user data (identity, "mine", capabilities are computed per request).
 *
 * Memory is bounded per tenant (entries and events) and in total. A tenant that
 * reaches its own bound evicts only its own least recently used entries; when the
 * total bound would be exceeded the snapshot is computed without caching rather
 * than evicting another tenant's entries, so one tenant cannot flush another.
 */

export interface ScopedEntry<T> {
  value: T;
  /** Events held by `value` (memory accounting). */
  events: number;
  /** Newest stored seq of the tenant when the entry was computed. */
  latestSeq: number;
  /** Retention cutoff used (ISO), or null. */
  cutoff: string | null;
  /** Oldest `occurredAt` held (ISO), or null when empty. */
  oldest: string | null;
  /** Epoch ms when computed. */
  computedAt: number;
}

export interface ScopedCacheOptions {
  /** Entries older than this are never served. */
  ttlMs: number;
  maxEntriesPerTenant?: number;
  maxEventsPerTenant?: number;
  maxEventsTotal?: number;
  now?: () => number;
}

export class ScopedSnapshotCache<T> {
  readonly #tenants = new Map<string, Map<string, ScopedEntry<T>>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxTenantEvents: number;
  readonly #maxTotalEvents: number;
  readonly #now: () => number;
  #total = 0;

  constructor(options: ScopedCacheOptions) {
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntriesPerTenant ?? 32;
    this.#maxTenantEvents = options.maxEventsPerTenant ?? 250_000;
    this.#maxTotalEvents = options.maxEventsTotal ?? 1_000_000;
    this.#now = options.now ?? Date.now;
  }

  /** Events held across all tenants. */
  get totalEvents(): number {
    return this.#total;
  }

  size(tenantId: string): number {
    return this.#tenants.get(tenantId)?.size ?? 0;
  }

  get(tenantId: string, fingerprint: string): ScopedEntry<T> | undefined {
    const entries = this.#tenants.get(tenantId);
    const entry = entries?.get(fingerprint);
    if (!entries || !entry) return undefined;
    if (this.#expired(entry)) {
      this.delete(tenantId, fingerprint);
      return undefined;
    }
    // LRU within the tenant: most recently used last.
    entries.delete(fingerprint);
    entries.set(fingerprint, entry);
    return entry;
  }

  /** Stores the entry if the bounds allow; returns false when it was not cached. */
  set(tenantId: string, fingerprint: string, entry: ScopedEntry<T>): boolean {
    this.#pruneExpired();
    this.delete(tenantId, fingerprint);
    if (entry.events > this.#maxTenantEvents || this.#maxEntries <= 0) return false;
    let entries = this.#tenants.get(tenantId);
    const tenantEvents = () => [...(entries?.values() ?? [])].reduce((n, e) => n + e.events, 0);
    // Make room only from this tenant's own entries.
    while (
      entries?.size &&
      (entries.size >= this.#maxEntries || tenantEvents() + entry.events > this.#maxTenantEvents)
    )
      this.delete(tenantId, entries.keys().next().value!);
    if (this.#total + entry.events > this.#maxTotalEvents) return false;
    entries = this.#tenants.get(tenantId);
    if (!entries) {
      entries = new Map();
      this.#tenants.set(tenantId, entries);
    }
    entries.set(fingerprint, entry);
    this.#total += entry.events;
    return true;
  }

  delete(tenantId: string, fingerprint: string): void {
    const entries = this.#tenants.get(tenantId);
    const entry = entries?.get(fingerprint);
    if (!entries || !entry) return;
    entries.delete(fingerprint);
    this.#total -= entry.events;
    if (!entries.size) this.#tenants.delete(tenantId);
  }

  clear(tenantId?: string): void {
    for (const t of tenantId ? [tenantId] : [...this.#tenants.keys()])
      for (const fp of [...(this.#tenants.get(t)?.keys() ?? [])]) this.delete(t, fp);
  }

  #expired(entry: ScopedEntry<T>): boolean {
    const age = this.#now() - entry.computedAt;
    return age >= this.#ttlMs || age < 0;
  }

  #pruneExpired(): void {
    for (const [t, entries] of [...this.#tenants])
      for (const [fp, e] of [...entries]) if (this.#expired(e)) this.delete(t, fp);
  }
}
