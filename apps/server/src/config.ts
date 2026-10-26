export interface AfeConfig {
  databaseUrl: string;
  host: string;
  port: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AfeConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl,
    host: env.AFE_HOST ?? "0.0.0.0",
    port: Number(env.AFE_PORT ?? 8080),
    logLevel: env.AFE_LOG_LEVEL ?? "info",
  };
}
