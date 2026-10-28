import { readFileSync } from "node:fs";
import { retentionPolicyFromEnv } from "@afe/core";
import { Secret } from "@afe/core/security";
import { parseDuration } from "./health/config.ts";

export interface VercelIntegrationConfig {
  clientId: string;
  clientSecret: Secret<string>;
  /** The integration's URL slug: https://vercel.com/integrations/<slug>. */
  integrationSlug: string;
}

/** API authentication settings (ADR 0006, docs/self-hosting/configuration.md "Authentication"). */
export interface AuthConfig {
  /** AFE_ADMIN_TOKEN / _FILE: full API access. */
  adminToken?: Secret<string>;
  /** AFE_VIEWER_TOKEN / _FILE: optional read-only API access. */
  viewerToken?: Secret<string>;
  /** AFE_SESSION_SECRET / _FILE: HMAC key of web UI session cookies. Default: derived from the tokens. */
  sessionSecret?: Secret<string>;
  /** AFE_SESSION_TTL: lifetime of a web UI session. Default 12h. */
  sessionTtlMs: number;
}

export const DEFAULT_SESSION_TTL_MS = 12 * 3600_000;

export interface AfeConfig {
  smtp?: SmtpConfig;
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: string;
  /** Self-host only: allow outbound calls to private networks (docs/security/rules.md R6). */
  allowPrivateNetworkTargets: boolean;
  /** Self-host only, lab setups: allow plain http to private targets. */
  allowInsecureHttpTargets: boolean;
  /** Externally reachable base URL of this Afe (OAuth redirect URLs), without trailing slash. */
  publicUrl?: string;
  /** Vercel Integration (OAuth) settings; absent = only the access-token fallback is available. */
  vercel?: VercelIntegrationConfig;
  /** Directory with the built web UI to serve (`AFE_WEB_DIR`); unset serves no UI. */
  webDir?: string;
  /** API authentication; absent tokens mean every /api request is rejected (see cli startup check). */
  auth?: AuthConfig;
  /**
   * AFE_EVENT_RETENTION_DAYS: how long events are kept, by occurredAt.
   * Default 30, 1..60 (the open-source maximum, ADR 0008).
   */
  eventRetentionDays?: number;
}

/**
 * Reads `name` or `name_FILE` (path to a file holding the value, e.g. a Docker
 * or Kubernetes secret). Setting both is an error. Values are never echoed.
 */
export function readSecretEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const inline = env[name] === "" ? undefined : env[name];
  const file = env[`${name}_FILE`];
  if (inline && file) throw new Error(`set only one of ${name} and ${name}_FILE`);
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`${name}_FILE: cannot read ${file}`);
    }
  }
  return inline;
}

function loadVercelConfig(env: NodeJS.ProcessEnv): VercelIntegrationConfig | undefined {
  const clientId = env.AFE_VERCEL_CLIENT_ID;
  const clientSecret = readSecretEnv(env, "AFE_VERCEL_CLIENT_SECRET");
  const integrationSlug = env.AFE_VERCEL_INTEGRATION_SLUG;
  const set = [clientId, clientSecret, integrationSlug].filter(Boolean).length;
  if (set === 0) return undefined;
  if (!clientId || !clientSecret || !integrationSlug) {
    throw new Error(
      "AFE_VERCEL_CLIENT_ID, AFE_VERCEL_CLIENT_SECRET (or _FILE) and AFE_VERCEL_INTEGRATION_SLUG must be set together",
    );
  }
  return { clientId, clientSecret: new Secret(clientSecret), integrationSlug };
}

function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const adminToken = readSecretEnv(env, "AFE_ADMIN_TOKEN")?.trim();
  const viewerToken = readSecretEnv(env, "AFE_VIEWER_TOKEN")?.trim();
  const sessionSecret = readSecretEnv(env, "AFE_SESSION_SECRET")?.trim();
  if (viewerToken && !adminToken) {
    throw new Error("AFE_VIEWER_TOKEN requires AFE_ADMIN_TOKEN (or AFE_ADMIN_TOKEN_FILE)");
  }
  if (sessionSecret !== undefined && sessionSecret.length < 32) {
    throw new Error("AFE_SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)");
  }
  const ttl = env.AFE_SESSION_TTL?.trim();
  const sessionTtlMs = ttl ? parseDuration(ttl, "AFE_SESSION_TTL") : DEFAULT_SESSION_TTL_MS;
  if (sessionTtlMs < 60_000 || sessionTtlMs > 30 * 24 * 3600_000) {
    throw new Error("AFE_SESSION_TTL must be between 1m and 30d");
  }
  return {
    ...(adminToken ? { adminToken: new Secret(adminToken) } : {}),
    ...(viewerToken ? { viewerToken: new Secret(viewerToken) } : {}),
    ...(sessionSecret ? { sessionSecret: new Secret(sessionSecret) } : {}),
    sessionTtlMs,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AfeConfig {
  const databaseUrl = readSecretEnv(env, "DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL (or DATABASE_URL_FILE) is required");
  const publicUrl = env.AFE_PUBLIC_URL?.replace(/\/+$/, "") || undefined;
  const vercel = loadVercelConfig(env);
  const smtp = loadSmtpConfig(env, publicUrl);
  return {
    databaseUrl,
    ...(smtp ? { smtp } : {}),
    host: env.AFE_HOST ?? "0.0.0.0",
    port: Number(env.AFE_PORT ?? 8080),
    logLevel: env.AFE_LOG_LEVEL ?? "info",
    allowPrivateNetworkTargets: env.AFE_ALLOW_PRIVATE_NETWORK_TARGETS === "true",
    allowInsecureHttpTargets: env.AFE_ALLOW_INSECURE_HTTP_TARGETS === "true",
    ...(publicUrl ? { publicUrl } : {}),
    ...(vercel ? { vercel } : {}),
    ...(env.AFE_WEB_DIR ? { webDir: env.AFE_WEB_DIR } : {}),
    auth: loadAuthConfig(env),
    // Throws (refuses to start) outside 1..60 days.
    eventRetentionDays: retentionPolicyFromEnv(env).days,
  };
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  allowPlaintext: boolean;
  from: string;
  username?: string;
  password?: Secret<string>;
}
function loadSmtpConfig(env: NodeJS.ProcessEnv, publicUrl?: string): SmtpConfig | undefined {
  const host = env.AFE_SMTP_HOST?.trim();
  const password = readSecretEnv(env, "AFE_SMTP_PASSWORD");
  if (!host) {
    if (Object.keys(env).some((k) => k.startsWith("AFE_SMTP_") && env[k]))
      throw new Error("AFE_SMTP_HOST is required for SMTP settings");
    return undefined;
  }
  if (!/^[a-z0-9.-]+$/i.test(host) || host.length > 253)
    throw new Error("AFE_SMTP_HOST must be a hostname or IPv4 address");
  const port = Number(env.AFE_SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("AFE_SMTP_PORT must be 1..65535");
  const from = env.AFE_SMTP_FROM?.trim();
  if (
    !from ||
    from.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(from)
  )
    throw new Error("AFE_SMTP_FROM must be a single email address");
  if (!publicUrl) throw new Error("SMTP requires AFE_PUBLIC_URL");
  const url = new URL(publicUrl);
  const lab =
    env.AFE_ALLOW_PRIVATE_NETWORK_TARGETS === "true" &&
    env.AFE_ALLOW_INSECURE_HTTP_TARGETS === "true";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(lab && url.protocol === "http:"))
  )
    throw new Error(
      "SMTP requires an HTTPS AFE_PUBLIC_URL origin (HTTP requires both lab network flags)",
    );
  const username = env.AFE_SMTP_USERNAME?.trim();
  if (Boolean(username) !== Boolean(password))
    throw new Error("AFE_SMTP_USERNAME and AFE_SMTP_PASSWORD (or _FILE) must be set together");
  const allowPlaintext = env.AFE_SMTP_ALLOW_PLAINTEXT === "true";
  if (allowPlaintext && !lab) throw new Error("Plaintext SMTP requires both lab network flags");
  for (const key of ["AFE_SMTP_SECURE", "AFE_SMTP_ALLOW_PLAINTEXT"])
    if (env[key] && !["true", "false"].includes(env[key]!))
      throw new Error(`${key} must be true or false`);
  return {
    host,
    port,
    from,
    secure: env.AFE_SMTP_SECURE === "true",
    allowPlaintext,
    ...(username ? { username, password: new Secret(password!) } : {}),
  };
}
