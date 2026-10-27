/**
 * Startup safety for API authentication (ADR 0006).
 *
 * Without AFE_ADMIN_TOKEN, the HTTP server refuses to start unless it is bound
 * to a loopback address. On loopback it generates a random one-time admin
 * token for this process and prints it once to stderr (not to the structured
 * log), so a local trial works without configuration and nothing is ever
 * served without authentication.
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { Secret } from "@afe/core/security";
import { DEFAULT_SESSION_TTL_MS, type AfeConfig } from "../config.ts";

export class StartupAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupAuthError";
  }
}

/** True for `localhost`, 127.0.0.0/8 and ::1 (IPv4-mapped included). */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) {
    if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return mapped ? mapped[1]!.startsWith("127.") : false;
  }
  return false;
}

/**
 * Makes sure `config.auth.adminToken` is set before the HTTP server listens.
 * Returns the generated token (already printed via `print`), or null when one
 * was configured.
 */
export function ensureAdminToken(
  config: AfeConfig,
  print: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): string | null {
  if (config.auth?.adminToken) return null;
  if (!isLoopbackHost(config.host)) {
    throw new StartupAuthError(
      `refusing to start: AFE_ADMIN_TOKEN (or AFE_ADMIN_TOKEN_FILE) is not set and the server listens on ${config.host}, ` +
        "which is not a loopback address. Set an admin token (openssl rand -hex 32), " +
        "or bind to 127.0.0.1 for a local trial (AFE_HOST=127.0.0.1). See docs/self-hosting/configuration.md#authentication.",
    );
  }
  const token = randomBytes(32).toString("hex");
  config.auth = {
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    ...config.auth,
    adminToken: new Secret(token),
  };
  print(
    [
      "",
      "AFE_ADMIN_TOKEN is not set. Generated a one-time admin token for this process",
      "(valid until restart; set AFE_ADMIN_TOKEN for a stable one):",
      "",
      `    ${token}`,
      "",
    ].join("\n"),
  );
  return token;
}
