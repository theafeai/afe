import { readFileSync } from "node:fs";
import { Secret } from "@afe/core/security";

export interface VercelIntegrationConfig {
  clientId: string;
  clientSecret: Secret<string>;
  /** The integration's URL slug: https://vercel.com/integrations/<slug>. */
  integrationSlug: string;
}

export interface AfeConfig {
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AfeConfig {
  const databaseUrl = readSecretEnv(env, "DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL (or DATABASE_URL_FILE) is required");
  const publicUrl = env.AFE_PUBLIC_URL?.replace(/\/+$/, "") || undefined;
  const vercel = loadVercelConfig(env);
  return {
    databaseUrl,
    host: env.AFE_HOST ?? "0.0.0.0",
    port: Number(env.AFE_PORT ?? 8080),
    logLevel: env.AFE_LOG_LEVEL ?? "info",
    allowPrivateNetworkTargets: env.AFE_ALLOW_PRIVATE_NETWORK_TARGETS === "true",
    allowInsecureHttpTargets: env.AFE_ALLOW_INSECURE_HTTP_TARGETS === "true",
    ...(publicUrl ? { publicUrl } : {}),
    ...(vercel ? { vercel } : {}),
    ...(env.AFE_WEB_DIR ? { webDir: env.AFE_WEB_DIR } : {}),
  };
}
