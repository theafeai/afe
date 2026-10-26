export interface AfeConfig {
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: string;
  /** Self-host only: allow outbound calls to private networks (docs/security/rules.md R6). */
  allowPrivateNetworkTargets: boolean;
  /** Self-host only, lab setups: allow plain http to private targets. */
  allowInsecureHttpTargets: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AfeConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl,
    host: env.AFE_HOST ?? "0.0.0.0",
    port: Number(env.AFE_PORT ?? 8080),
    logLevel: env.AFE_LOG_LEVEL ?? "info",
    allowPrivateNetworkTargets: env.AFE_ALLOW_PRIVATE_NETWORK_TARGETS === "true",
    allowInsecureHttpTargets: env.AFE_ALLOW_INSECURE_HTTP_TARGETS === "true",
  };
}
