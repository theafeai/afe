/**
 * Cache of commit comparisons (AFE-22). Ancestry of two commit SHAs never
 * changes, so entries never go stale: an in-memory LRU in front of the
 * optional tenant-scoped `commit_comparisons` table (migration 0022).
 * Only definitive results are cached, never errors or "unknown".
 */
import type pg from "pg";
import type { CommitComparison, CompareStatus } from "@afe/connector-github";

export interface ComparisonKey {
  tenantId: string;
  /** Lower-case "owner/name". */
  repository: string;
  base: string;
  head: string;
}

export interface ComparisonCacheOptions {
  /** Entries kept in memory. Default 5000. */
  maxEntries?: number;
  /** Also store results in `commit_comparisons`. Default true when a pool is given. */
  pool?: pg.Pool | null;
  /** Called when the table cannot be read or written (the cache then acts as memory-only). */
  onError?: (err: unknown) => void;
}

export interface CacheStats {
  memoryHits: number;
  tableHits: number;
  misses: number;
}

const keyOf = (k: ComparisonKey) =>
  `${k.tenantId}\u0000${k.repository}\u0000${k.base}\u0000${k.head}`;

export class ComparisonCache {
  readonly #lru = new Map<string, CommitComparison>();
  readonly #max: number;
  readonly #pool: pg.Pool | null;
  readonly #onError: (err: unknown) => void;
  readonly stats: CacheStats = { memoryHits: 0, tableHits: 0, misses: 0 };

  constructor(options: ComparisonCacheOptions = {}) {
    this.#max = Math.max(1, options.maxEntries ?? 5000);
    this.#pool = options.pool ?? null;
    this.#onError = options.onError ?? (() => {});
  }

  get size(): number {
    return this.#lru.size;
  }

  #remember(key: string, value: CommitComparison): void {
    this.#lru.delete(key);
    this.#lru.set(key, value);
    while (this.#lru.size > this.#max) {
      const oldest = this.#lru.keys().next().value as string;
      this.#lru.delete(oldest);
    }
  }

  async get(k: ComparisonKey): Promise<CommitComparison | null> {
    const key = keyOf(k);
    const hit = this.#lru.get(key);
    if (hit) {
      this.#remember(key, hit); // refresh recency
      this.stats.memoryHits++;
      return hit;
    }
    if (this.#pool) {
      try {
        const { rows } = await this.#pool.query<{
          status: CompareStatus;
          ahead_by: number;
          behind_by: number;
          merge_base_sha: string | null;
        }>(
          `UPDATE commit_comparisons SET last_used_at = now()
            WHERE tenant_id = $1 AND repository = $2 AND base_sha = $3 AND head_sha = $4
          RETURNING status, ahead_by, behind_by, merge_base_sha`,
          [k.tenantId, k.repository, k.base, k.head],
        );
        const r = rows[0];
        if (r) {
          const value: CommitComparison = {
            status: r.status,
            aheadBy: r.ahead_by,
            behindBy: r.behind_by,
            mergeBaseSha: r.merge_base_sha,
          };
          this.#remember(key, value);
          this.stats.tableHits++;
          return value;
        }
      } catch (err) {
        this.#onError(err);
      }
    }
    this.stats.misses++;
    return null;
  }

  async put(k: ComparisonKey, value: CommitComparison): Promise<void> {
    this.#remember(keyOf(k), value);
    if (!this.#pool) return;
    try {
      await this.#pool.query(
        `INSERT INTO commit_comparisons
           (tenant_id, repository, base_sha, head_sha, status, ahead_by, behind_by, merge_base_sha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, repository, base_sha, head_sha) DO UPDATE
           SET last_used_at = now()`,
        [
          k.tenantId,
          k.repository,
          k.base,
          k.head,
          value.status,
          value.aheadBy,
          value.behindBy,
          value.mergeBaseSha,
        ],
      );
    } catch (err) {
      this.#onError(err);
    }
  }

  /** Clears the in-memory part (tests). */
  clearMemory(): void {
    this.#lru.clear();
  }
}

/** Deletes cached comparisons not used since `before`. Returns how many. */
export async function pruneComparisons(pool: pg.Pool, before: Date): Promise<number> {
  const { rowCount } = await pool.query("DELETE FROM commit_comparisons WHERE last_used_at < $1", [
    before,
  ]);
  return rowCount ?? 0;
}
