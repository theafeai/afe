import { readFileSync } from "node:fs";

export interface AfeConfig {
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: string;
  /** Self-host only: allow outbound calls to private networks (docs/security/rules.md R6). */
  allowPrivateNetworkTargets: boolean;
  /** Self-host only, lab setups: allow plain http to private targets. */
  allowInsecureHttpTargets: boolean;
  /** Directory with the built web UI to serve (`AFE_WEB_DIR`); unset serves no UI. */
  webDir?: string;
}

/**
 * Reads `name` or `name_FILE` (path to a file holding the value, e.g. a Docker
 * or Kubernetes secret). Setting both is an error. Values are never echoed.
 */
function envOrFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const inline = env[name];
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AfeConfig {
  const databaseUrl = envOrFile(env, "DATABASE_URL");
  if (!databaseUrl) throw new Error("DATABASE_URL (or DATABASE_URL_FILE) is required");
  return {
    databaseUrl,
    host: env.AFE_HOST ?? "0.0.0.0",
    port: Number(env.AFE_PORT ?? 8080),
    logLevel: env.AFE_LOG_LEVEL ?? "info",
    allowPrivateNetworkTargets: env.AFE_ALLOW_PRIVATE_NETWORK_TARGETS === "true",
    allowInsecureHttpTargets: env.AFE_ALLOW_INSECURE_HTTP_TARGETS === "true",
    ...(env.AFE_WEB_DIR ? { webDir: env.AFE_WEB_DIR } : {}),
  };
}
