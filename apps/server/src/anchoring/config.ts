/** Chain anchoring settings (docs/self-hosting/configuration.md "Chain anchoring"). */
import { readSecretEnv } from "../config.ts";
import { parseDuration } from "../health/config.ts";

export interface AnchorConfig {
  /** Append-only anchor directory (AFE_ANCHOR_DIR). */
  dir: string | null;
  /** Operator webhook receiving signed checkpoints (AFE_ANCHOR_WEBHOOK_URL). */
  webhookUrl: string | null;
  /** RFC 3161 timestamp authority (AFE_ANCHOR_TSA_URL). */
  tsaUrl: string | null;
  /** Optional TSA policy OID (AFE_ANCHOR_TSA_POLICY). */
  tsaPolicy: string | null;
  /** How often to anchor (AFE_ANCHOR_INTERVAL), default 1h. */
  intervalMs: number;
  /** Cron for the anchor.publish job, derived from the interval (or given as cron). */
  schedule: string;
  /** Also anchor when an export is made, and embed the receipt (AFE_ANCHOR_ON_EXPORT, default true). */
  onExport: boolean;
  /**
   * Ed25519 key material: AFE_ANCHOR_SIGNING_KEY (or _FILE), else
   * AFE_EXPORT_SIGNING_KEY (or _FILE). Never logged.
   */
  signingKey: string | null;
  /** Extra public keys accepted for old checkpoints, e.g. after rotation (AFE_ANCHOR_TRUSTED_PUBLIC_KEYS). */
  trustedPublicKeys: string[];
}

/** Interval (e.g. "15m", "1h", "6h", "1d") or a 5-field cron expression to a cron schedule. */
export function intervalToCron(value: string): { schedule: string; intervalMs: number } {
  const v = value.trim();
  if (v.split(/\s+/).length === 5) return { schedule: v, intervalMs: 60 * 60_000 };
  const ms = parseDuration(v, "AFE_ANCHOR_INTERVAL");
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes) && minutes >= 1 && minutes < 60) {
    return { schedule: `*/${minutes} * * * *`, intervalMs: ms };
  }
  const hours = ms / 3_600_000;
  if (Number.isInteger(hours) && hours >= 1 && hours < 24) {
    return { schedule: hours === 1 ? "0 * * * *" : `0 */${hours} * * *`, intervalMs: ms };
  }
  if (hours === 24) return { schedule: "0 0 * * *", intervalMs: ms };
  throw new Error(
    "AFE_ANCHOR_INTERVAL: use whole minutes below 1h, whole hours below 1d, 1d, or a cron expression",
  );
}

export function loadAnchorConfig(env: NodeJS.ProcessEnv = process.env): AnchorConfig {
  const { schedule, intervalMs } = intervalToCron(env.AFE_ANCHOR_INTERVAL || "1h");
  const signingKey =
    readSecretEnv(env, "AFE_ANCHOR_SIGNING_KEY") ??
    readSecretEnv(env, "AFE_EXPORT_SIGNING_KEY") ??
    null;
  const onExport = env.AFE_ANCHOR_ON_EXPORT ?? "true";
  if (onExport !== "true" && onExport !== "false") {
    throw new Error("AFE_ANCHOR_ON_EXPORT must be true or false");
  }
  return {
    dir: env.AFE_ANCHOR_DIR || null,
    webhookUrl: env.AFE_ANCHOR_WEBHOOK_URL || null,
    tsaUrl: env.AFE_ANCHOR_TSA_URL || null,
    tsaPolicy: env.AFE_ANCHOR_TSA_POLICY || null,
    intervalMs,
    schedule,
    onExport: onExport === "true",
    signingKey: signingKey?.trim() ? signingKey.trim() : null,
    trustedPublicKeys: (env.AFE_ANCHOR_TRUSTED_PUBLIC_KEYS ?? "").split(/[\s,]+/).filter(Boolean),
  };
}
