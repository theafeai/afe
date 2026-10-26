/** Connection health settings (docs/connection-health.md "Configuration"). */
export interface HealthConfig {
  /** Probe interval for healthy connections. AFE_HEALTH_PROBE_INTERVAL, default 5m. */
  probeIntervalMs: number;
  /** First retry delay after a failure; doubles per failure. AFE_HEALTH_BACKOFF_BASE, default 30s. */
  backoffBaseMs: number;
  /** Cap of the exponential backoff. AFE_HEALTH_BACKOFF_MAX, default 15m. */
  backoffMaxMs: number;
  /** Fraction of the delay removed at random (0..1), to spread retries. Default 0.2. */
  backoffJitter: number;
  /** Retry interval while credentials are revoked/unauthorized. AFE_HEALTH_AUTH_RETRY_INTERVAL, default 1h. */
  authRetryIntervalMs: number;
  /** Upper bound honoured for a source's Retry-After. Default 24h. */
  maxRetryAfterMs: number;
  /** Alert when a connection has been blind longer than this. AFE_HEALTH_ALERT_AFTER, default 15m. */
  alertAfterMs: number;
  /**
   * If a healthy connection was not attempted for longer than this, Afe itself
   * was not observing (down, or workers not running): record an
   * `afe_unavailable` gap. AFE_HEALTH_DOWNTIME_THRESHOLD, default 15m.
   */
  downtimeThresholdMs: number;
  /** Timeout of one connector probe. Default 30s. */
  probeTimeoutMs: number;
  /** Max delivery attempts per alert notification. Default 10. */
  maxNotifyAttempts: number;
  /** Optional JSON webhook for alerts. AFE_ALERT_WEBHOOK_URL. */
  alertWebhookUrl: string | null;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  probeIntervalMs: 5 * 60_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 15 * 60_000,
  backoffJitter: 0.2,
  authRetryIntervalMs: 60 * 60_000,
  maxRetryAfterMs: 24 * 60 * 60_000,
  alertAfterMs: 15 * 60_000,
  downtimeThresholdMs: 15 * 60_000,
  probeTimeoutMs: 30_000,
  maxNotifyAttempts: 10,
  alertWebhookUrl: null,
};

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses "90s", "15m", "1h", "2d", "500ms" or a plain number of milliseconds. */
export function parseDuration(value: string, name = "duration"): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(value);
  if (!m) throw new Error(`${name}: invalid duration "${value}" (use e.g. 30s, 15m, 1h)`);
  const ms = Number(m[1]) * UNITS[m[2] ?? "ms"]!;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${name}: duration must be positive`);
  return Math.round(ms);
}

export function loadHealthConfig(env: NodeJS.ProcessEnv = process.env): HealthConfig {
  const d = (key: string, fallback: number) => (env[key] ? parseDuration(env[key], key) : fallback);
  return {
    ...DEFAULT_HEALTH_CONFIG,
    probeIntervalMs: d("AFE_HEALTH_PROBE_INTERVAL", DEFAULT_HEALTH_CONFIG.probeIntervalMs),
    backoffBaseMs: d("AFE_HEALTH_BACKOFF_BASE", DEFAULT_HEALTH_CONFIG.backoffBaseMs),
    backoffMaxMs: d("AFE_HEALTH_BACKOFF_MAX", DEFAULT_HEALTH_CONFIG.backoffMaxMs),
    authRetryIntervalMs: d(
      "AFE_HEALTH_AUTH_RETRY_INTERVAL",
      DEFAULT_HEALTH_CONFIG.authRetryIntervalMs,
    ),
    alertAfterMs: d("AFE_HEALTH_ALERT_AFTER", DEFAULT_HEALTH_CONFIG.alertAfterMs),
    downtimeThresholdMs: d(
      "AFE_HEALTH_DOWNTIME_THRESHOLD",
      DEFAULT_HEALTH_CONFIG.downtimeThresholdMs,
    ),
    alertWebhookUrl: env.AFE_ALERT_WEBHOOK_URL || null,
  };
}

/**
 * Delay before the next probe after `failures` consecutive failures:
 * min(max, base * 2^(failures-1)), minus up to `jitter` of it at random.
 */
export function backoffDelayMs(failures: number, config: HealthConfig, random: number): number {
  const exp = config.backoffBaseMs * 2 ** Math.max(0, Math.min(failures - 1, 30));
  const capped = Math.min(config.backoffMaxMs, exp);
  return Math.round(capped * (1 - config.backoffJitter * Math.min(Math.max(random, 0), 1)));
}
