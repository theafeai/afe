import { createPrivateKey, sign } from "node:crypto";
import { revealIfSecret, type Secret } from "@afe/core/security";

/**
 * GitHub App JWT (RS256), used only to call `/app/...` endpoints: read an
 * installation and mint installation access tokens.
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *
 * - `iat` is backdated 60 s to tolerate clock drift.
 * - `exp` is at most 10 minutes after the real current time (GitHub's limit);
 *   we use 9 minutes so a slightly fast local clock still stays inside it.
 * - `iss` is the App id.
 */
export const APP_JWT_BACKDATE_SECONDS = 60;
export const APP_JWT_LIFETIME_SECONDS = 9 * 60;

export interface AppJwtOptions {
  appId: string;
  privateKey: string | Secret<string>;
  /** Current time in ms; injectable for tests. */
  now?: number;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function createAppJwt(options: AppJwtOptions): string {
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSec - APP_JWT_BACKDATE_SECONDS,
    exp: nowSec + APP_JWT_LIFETIME_SECONDS,
    iss: options.appId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(revealIfSecret(options.privateKey));
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Caches the App JWT for most of its lifetime (signing is cheap, but there is
 * no reason to sign on every call). Re-signs one minute before expiry.
 */
export class AppJwtSource {
  #jwt: string | null = null;
  #expiresAtMs = 0;

  constructor(
    private readonly options: Omit<AppJwtOptions, "now">,
    private readonly clock: () => number = Date.now,
  ) {}

  get(): string {
    const now = this.clock();
    if (!this.#jwt || now >= this.#expiresAtMs - 60_000) {
      this.#jwt = createAppJwt({ ...this.options, now });
      this.#expiresAtMs = Math.floor(now / 1000) * 1000 + APP_JWT_LIFETIME_SECONDS * 1000;
    }
    return this.#jwt;
  }
}
