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
}

/** Reads `NAME`, or the contents of the file named by `NAME_FILE` (Docker/K8s secrets). */
export function readSecretEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
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
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
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
  };
}
