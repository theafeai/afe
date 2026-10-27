/**
 * Agent configuration from environment variables (docs/connectors/argocd.md
 * "In-cluster agent"). Secrets are read from files (Kubernetes Secret
 * volumes); nothing secret is ever logged.
 */
import { readFileSync } from "node:fs";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface AgentConfig {
  afeUrl: string;
  agentId: string;
  /** File holding the agent secret (re-read on every request, so rotation needs no restart). */
  secretFile?: string;
  /** The secret itself (AFE_AGENT_SECRET; for development only). */
  secret?: string;
  afeCa?: string;
  /** Namespaces whose Applications are read; null = all namespaces (needs a ClusterRole). */
  namespaces: string[] | null;
  kubeUrl: string;
  kubeTokenFile: string;
  kubeCa?: string;
  attributeWithEvents: boolean;
  bufferMaxItems: number;
  bufferMaxBytes: number;
  batchMaxItems: number;
  batchMaxBytes: number;
  listPageSize: number;
  watchTimeoutSeconds: number;
  /** Port of /healthz and /metrics; 0 disables it. */
  healthPort: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function int(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, def: boolean): boolean {
  const raw = env[name]?.toLowerCase();
  if (raw === undefined || raw === "") return def;
  if (["1", "true", "yes"].includes(raw)) return true;
  if (["0", "false", "no"].includes(raw)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

function readOptional(path: string | undefined, name: string): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`${name}: cannot read the file`);
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = (p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  },
): AgentConfig {
  const afeUrl = env.AFE_URL?.replace(/\/+$/, "");
  if (!afeUrl) throw new ConfigError("AFE_URL is required (Afe's public URL)");
  let u: URL;
  try {
    u = new URL(afeUrl);
  } catch {
    throw new ConfigError("AFE_URL is not a URL");
  }
  if (u.username || u.password || u.search || u.hash)
    throw new ConfigError("AFE_URL must not contain credentials, a query or a fragment");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && bool(env, "AFE_AGENT_ALLOW_INSECURE_HTTP", false)))
    throw new ConfigError("AFE_URL must use https (AFE_AGENT_ALLOW_INSECURE_HTTP=true for labs only)");

  const agentId = env.AFE_AGENT_ID ?? "";
  if (!UUID_RE.test(agentId)) throw new ConfigError("AFE_AGENT_ID must be the agent id (a UUID) shown at registration");
  const secretFile = env.AFE_AGENT_SECRET_FILE || undefined;
  const secret = env.AFE_AGENT_SECRET || undefined;
  if (!!secretFile === !!secret)
    throw new ConfigError("set exactly one of AFE_AGENT_SECRET_FILE (recommended) or AFE_AGENT_SECRET");
  if (secretFile && !fileExists(secretFile))
    throw new ConfigError("AFE_AGENT_SECRET_FILE: cannot read the file");

  const nsRaw = (env.AFE_AGENT_NAMESPACES ?? "argocd").trim();
  const namespaces =
    nsRaw === "*"
      ? null
      : nsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  if (namespaces && (!namespaces.length || namespaces.some((n) => !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(n))))
    throw new ConfigError('AFE_AGENT_NAMESPACES must be "*" or a comma-separated list of namespaces');

  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? "443";
  const kubeUrl =
    env.AFE_AGENT_KUBE_URL?.replace(/\/+$/, "") ||
    (host ? `https://${host.includes(":") ? `[${host}]` : host}:${port}` : "");
  if (!kubeUrl)
    throw new ConfigError("not running in a cluster (KUBERNETES_SERVICE_HOST unset); set AFE_AGENT_KUBE_URL");

  const kubeCaFile = env.AFE_AGENT_KUBE_CA_FILE ?? `${SERVICE_ACCOUNT_DIR}/ca.crt`;
  const logLevel = (env.AFE_AGENT_LOG_LEVEL ?? "info") as AgentConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel))
    throw new ConfigError("AFE_AGENT_LOG_LEVEL must be debug, info, warn or error");

  const afeCa = readOptional(env.AFE_AGENT_CA_FILE, "AFE_AGENT_CA_FILE");
  const kubeCa = fileExists(kubeCaFile) ? readOptional(kubeCaFile, "AFE_AGENT_KUBE_CA_FILE") : undefined;
  return {
    afeUrl,
    agentId: agentId.toLowerCase(),
    ...(secretFile ? { secretFile } : {}),
    ...(secret ? { secret } : {}),
    ...(afeCa ? { afeCa } : {}),
    namespaces,
    kubeUrl,
    kubeTokenFile: env.AFE_AGENT_KUBE_TOKEN_FILE ?? `${SERVICE_ACCOUNT_DIR}/token`,
    ...(kubeCa ? { kubeCa } : {}),
    attributeWithEvents: bool(env, "AFE_AGENT_ATTRIBUTE_WITH_EVENTS", true),
    bufferMaxItems: int(env, "AFE_AGENT_BUFFER_MAX_ITEMS", 10_000, 10, 1_000_000),
    bufferMaxBytes: int(env, "AFE_AGENT_BUFFER_MAX_BYTES", 64 * 1024 * 1024, 1024 * 1024, 2 ** 31),
    batchMaxItems: int(env, "AFE_AGENT_BATCH_MAX_ITEMS", 200, 1, 1000),
    batchMaxBytes: int(env, "AFE_AGENT_BATCH_MAX_BYTES", 2 * 1024 * 1024, 64 * 1024, 7 * 1024 * 1024),
    listPageSize: int(env, "AFE_AGENT_LIST_PAGE_SIZE", 250, 1, 5000),
    watchTimeoutSeconds: int(env, "AFE_AGENT_WATCH_TIMEOUT_SECONDS", 300, 10, 3600),
    healthPort: int(env, "AFE_AGENT_HEALTH_PORT", 8081, 0, 65535),
    logLevel,
  };
}
