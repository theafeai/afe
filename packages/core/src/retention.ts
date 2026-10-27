/**
 * Event retention: how long events (and their raw payloads) are kept.
 *
 * Afe keeps recent events to power the timeline, deployments view, connection
 * health and correlation; it is not a long-term record (ADR 0008). Retention
 * is measured on `occurredAt` (when it happened in the source):
 *
 * - `EventSink` implementations drop (do not store) an event whose
 *   `occurredAt` is already before the tenant's cutoff, so polling, backfill
 *   and reconciliation lookbacks cannot bring purged events back;
 * - the `retention.purge` job deletes stored events whose `occurredAt` has
 *   fallen before the cutoff, together with their raw payloads.
 *
 * `RetentionPolicy` is an extension point (ADR 0002): the open-source default
 * is `FixedWindowRetention` from `AFE_EVENT_RETENTION_DAYS`; another build can
 * pass its own policy to `createAfe({ retentionPolicy })`.
 */

const DAY_MS = 24 * 3600_000;

/** Default window of the open-source build, in days. */
export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
/**
 * Longest window the open-source build can be configured with, in days. This
 * is the boundary of the open-source product (ADR 0008), not a technical limit.
 */
export const MAX_RETENTION_DAYS = 60;

export interface RetentionPolicy {
  /**
   * Events of `tenantId` whose `occurredAt` is before the returned instant
   * are not kept: they are dropped at ingestion and purged when stored.
   * `null` means no time limit for this tenant.
   */
  cutoff(tenantId: string, now: Date): Date | null | Promise<Date | null>;
  /**
   * The longest window of any tenant in milliseconds (`null`: unbounded).
   * Used at startup to clamp connector backfill/lookback settings.
   */
  readonly maxWindowMs: number | null;
}

/** The same window of `days` days for every tenant. */
export class FixedWindowRetention implements RetentionPolicy {
  readonly days: number;
  readonly maxWindowMs: number;

  constructor(days: number = DEFAULT_RETENTION_DAYS) {
    if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
      throw new RangeError(
        `event retention must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`,
      );
    }
    this.days = days;
    this.maxWindowMs = days * DAY_MS;
  }

  cutoff(_tenantId: string, now: Date): Date {
    return new Date(now.getTime() - this.maxWindowMs);
  }
}

/**
 * The open-source policy from `AFE_EVENT_RETENTION_DAYS` (default 30, 1..60).
 * Throws on an invalid or out-of-range value: Afe refuses to start rather
 * than silently keeping less (or more) than configured.
 */
export function retentionPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): FixedWindowRetention {
  const raw = env.AFE_EVENT_RETENTION_DAYS?.trim();
  if (raw === undefined || raw === "") return new FixedWindowRetention();
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new Error(
      `AFE_EVENT_RETENTION_DAYS must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} ` +
        `(got ${JSON.stringify(raw)}); ${MAX_RETENTION_DAYS} days is the maximum of the open-source build (ADR 0008)`,
    );
  }
  return new FixedWindowRetention(days);
}

/** True when an event that occurred at `occurredAt` is outside the window. */
export function isOutsideRetention(occurredAt: string | Date, cutoff: Date | null): boolean {
  return cutoff !== null && new Date(occurredAt).getTime() < cutoff.getTime();
}

/** The later of `from` and the cutoff: the start of a lookback that stays inside the window. */
export function clampToRetention(from: Date, cutoff: Date | null): Date {
  return cutoff !== null && from.getTime() < cutoff.getTime() ? new Date(cutoff) : from;
}

/**
 * Clamps a lookback length (ms) to the policy's longest window. Returns the
 * value to use and whether it was clamped (callers log a line when it was).
 */
export function clampLookbackMs(
  lookbackMs: number,
  policy: Pick<RetentionPolicy, "maxWindowMs">,
): { ms: number; clamped: boolean } {
  const max = policy.maxWindowMs;
  return max !== null && lookbackMs > max
    ? { ms: max, clamped: true }
    : { ms: lookbackMs, clamped: false };
}
