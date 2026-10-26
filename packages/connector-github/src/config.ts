import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { Secret } from "@afe/core/security";

/**
 * Credentials and identity of the GitHub App Afe acts as. The hosted service
 * registers one App; self-hosters register their own (by hand, or with the
 * manifest flow, see manifest.ts) and pass it in through the environment.
 */
export interface GitHubAppConfig {
  /** Numeric App id (the JWT `iss`). */
  appId: string;
  /** PEM private key (PKCS#1 "RSA PRIVATE KEY" as GitHub issues it, or PKCS#8). */
  privateKey: Secret<string>;
  /** Secret GitHub signs webhook deliveries with (X-Hub-Signature-256). */
  webhookSecret: Secret<string>;
  /** App slug, used in https://github.com/apps/<slug>/installations/new. */
  slug: string;
  /** OAuth client id (optional; not needed for installation tokens). */
  clientId?: string;
}

export class GitHubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConfigError";
  }
}

export const GITHUB_ENV = {
  APP_ID: "AFE_GITHUB_APP_ID",
  PRIVATE_KEY: "AFE_GITHUB_APP_PRIVATE_KEY",
  PRIVATE_KEY_FILE: "AFE_GITHUB_APP_PRIVATE_KEY_FILE",
  WEBHOOK_SECRET: "AFE_GITHUB_WEBHOOK_SECRET",
  WEBHOOK_SECRET_FILE: "AFE_GITHUB_WEBHOOK_SECRET_FILE",
  SLUG: "AFE_GITHUB_APP_SLUG",
  CLIENT_ID: "AFE_GITHUB_APP_CLIENT_ID",
} as const;

/** Throws GitHubConfigError if `pem` is not a usable RSA private key. Never echoes the key. */
export function assertRsaPrivateKey(pem: string): void {
  let type: string | undefined;
  try {
    type = createPrivateKey(pem).asymmetricKeyType;
  } catch {
    throw new GitHubConfigError("GitHub App private key is not a valid PEM private key");
  }
  if (type !== "rsa") throw new GitHubConfigError("GitHub App private key must be an RSA key");
}

function secretFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fileName: string,
  readFile: (path: string) => string,
): string | undefined {
  const direct = env[name];
  const file = env[fileName];
  if (direct && file) throw new GitHubConfigError(`set only one of ${name} and ${fileName}`);
  if (file) {
    try {
      return readFile(file);
    } catch {
      throw new GitHubConfigError(`cannot read ${fileName}`);
    }
  }
  return direct;
}

/**
 * Loads the App config from the environment (self-host). Returns null when no
 * GitHub variable is set (the connector is then configured through the
 * manifest flow or not at all); throws when it is only partly configured.
 *
 * AFE_GITHUB_APP_PRIVATE_KEY may contain literal `\n` sequences (common in
 * .env files); they are turned into newlines.
 */
export function loadGitHubAppConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): GitHubAppConfig | null {
  const appId = env[GITHUB_ENV.APP_ID]?.trim();
  const slug = env[GITHUB_ENV.SLUG]?.trim();
  const rawKey = secretFromEnv(env, GITHUB_ENV.PRIVATE_KEY, GITHUB_ENV.PRIVATE_KEY_FILE, readFile);
  const webhookSecret = secretFromEnv(
    env,
    GITHUB_ENV.WEBHOOK_SECRET,
    GITHUB_ENV.WEBHOOK_SECRET_FILE,
    readFile,
  )?.trim();

  if (!appId && !slug && !rawKey && !webhookSecret) return null;
  const missing = [
    !appId && GITHUB_ENV.APP_ID,
    !rawKey && `${GITHUB_ENV.PRIVATE_KEY} or ${GITHUB_ENV.PRIVATE_KEY_FILE}`,
    !webhookSecret && GITHUB_ENV.WEBHOOK_SECRET,
    !slug && GITHUB_ENV.SLUG,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new GitHubConfigError(`incomplete GitHub App config, missing: ${missing.join(", ")}`);
  }
  if (!/^[1-9][0-9]{0,18}$/.test(appId!)) {
    throw new GitHubConfigError(`${GITHUB_ENV.APP_ID} must be the numeric App id`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug!)) {
    throw new GitHubConfigError(`${GITHUB_ENV.SLUG} is not a valid App slug`);
  }
  const pem = rawKey!.replace(/\\n/g, "\n").trim() + "\n";
  assertRsaPrivateKey(pem);
  const clientId = env[GITHUB_ENV.CLIENT_ID]?.trim();
  return {
    appId: appId!,
    slug: slug!,
    privateKey: new Secret(pem),
    webhookSecret: new Secret(webhookSecret!),
    ...(clientId ? { clientId } : {}),
  };
}
