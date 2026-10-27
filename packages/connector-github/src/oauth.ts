/**
 * Installer verification for the hosted service (AFE-27, found in AFE-6).
 *
 * GitHub sends the browser to the App's setup URL with `installation_id`,
 * which anyone can edit, so a guessed id must not be claimable. With
 * "Request user authorization (OAuth) during installation" enabled on the
 * App, GitHub also sends a `code`: Afe exchanges it for a user access token
 * and checks that the installation is in `GET /user/installations`, i.e.
 * that the user coming back actually has access to it.
 *
 * Docs:
 * - https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 * - https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-the-setup-url
 * - https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token
 * - https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token
 */
import { Secret } from "@afe/core/security";
import { GitHubApiError, GitHubHttp, nextPageUrl, type FetchLike } from "./http.ts";

export const GITHUB_WEB_URL = "https://github.com";

export interface InstallerVerificationConfig {
  /** The App's OAuth client id (`Iv1.…` / `Iv23…`). */
  clientId: string;
  clientSecret: Secret<string>;
}

export interface OAuthHttpOptions {
  fetch?: FetchLike;
  /** Base of the OAuth endpoints. Default https://github.com. */
  webBaseUrl?: string;
  timeoutMs?: number;
}

/** Thrown when the code cannot be exchanged. Never contains the code, secret or token. */
export class GitHubOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

/** Exchanges the OAuth `code` from the setup redirect for a user access token. */
export async function exchangeUserCode(
  config: InstallerVerificationConfig,
  code: string,
  options: OAuthHttpOptions = {},
): Promise<Secret<string>> {
  const f = options.fetch ?? ((url, init) => fetch(url, init));
  const base = (options.webBaseUrl ?? GITHUB_WEB_URL).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await f(`${base}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret.reveal(),
        code,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch {
    throw new GitHubOAuthError("GitHub OAuth code exchange failed (network)");
  }
  let body: { access_token?: unknown; error?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new GitHubOAuthError(`GitHub OAuth code exchange returned ${res.status}`);
  }
  // Errors come back as 200 with an `error` field (e.g. bad_verification_code).
  if (!res.ok || typeof body.access_token !== "string" || body.access_token === "") {
    const reason = typeof body.error === "string" ? body.error.slice(0, 64) : `http_${res.status}`;
    throw new GitHubOAuthError(`GitHub OAuth code exchange rejected: ${reason}`);
  }
  return new Secret(body.access_token);
}

/** Ids of the installations of this App the user's token can access (bounded to 10 pages). */
export async function listUserInstallationIds(
  http: GitHubHttp,
  token: Secret<string>,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let path: string | null = "/user/installations";
  for (let page = 0; path && page < 10; page++) {
    const res: { data: { installations?: { id?: unknown }[] }; headers: Headers } =
      await http.request<{ installations?: { id?: unknown }[] }>({
        method: "GET",
        path,
        ...(page === 0 ? { query: { per_page: 100 } } : {}),
        token,
        bucket: "user",
      });
    for (const inst of res.data?.installations ?? []) {
      if (typeof inst.id === "number" || typeof inst.id === "string") ids.add(String(inst.id));
    }
    path = nextPageUrl(res.headers.get("link"));
  }
  return ids;
}

/**
 * Best effort: revokes the short-lived user token once it was used.
 * `DELETE /applications/{client_id}/token`, Basic auth with the client id/secret.
 */
export async function revokeUserToken(
  config: InstallerVerificationConfig,
  token: Secret<string>,
  options: { fetch?: FetchLike; apiBaseUrl?: string } = {},
): Promise<boolean> {
  const f = options.fetch ?? ((url, init) => fetch(url, init));
  const base = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret.reveal()}`).toString(
    "base64",
  );
  try {
    const res = await f(`${base}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "user-agent": "afe-github-connector",
      },
      body: JSON.stringify({ access_token: token.reveal() }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * True when the user who completed the install (identified by the OAuth
 * `code`) can access `installationId`. Throws GitHubOAuthError when the code
 * is invalid; GitHubApiError when GitHub fails.
 */
export async function verifyInstaller(
  config: InstallerVerificationConfig,
  code: string,
  installationId: string,
  options: OAuthHttpOptions & { http: GitHubHttp },
): Promise<boolean> {
  const token = await exchangeUserCode(config, code, options);
  try {
    const ids = await listUserInstallationIds(options.http, token);
    return ids.has(installationId);
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 401 || err.status === 403)) return false;
    throw err;
  } finally {
    await revokeUserToken(config, token, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      apiBaseUrl: options.http.baseUrl,
    });
  }
}
