import { createHmac, randomBytes } from "node:crypto";
import { Secret, signHmac, verifyHmacSignature } from "@afe/core/security";
import { VERCEL_API_URL, VercelApiError, type FetchLike } from "./client.ts";

/**
 * Auth-lifecycle calls for the Vercel Integration (ADR 0005). These are the
 * only non-GET requests Afe sends to Vercel, and neither touches customer
 * resources: one exchanges an OAuth code for Afe's own token, the other removes
 * Afe's own installation on disconnect.
 */

/** https://vercel.com/integrations/<slug>/new starts the installation (team + project picker). */
export function buildInstallUrl(integrationSlug: string, state: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(integrationSlug)) {
    throw new Error("invalid Vercel integration slug");
  }
  const url = new URL(`https://vercel.com/integrations/${integrationSlug}/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface OAuthExchangeInput {
  clientId: string;
  clientSecret: Secret<string>;
  code: string;
  redirectUri: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface OAuthExchangeResult {
  accessToken: Secret<string>;
  /** The integration configuration (installation) id, `icfg_…`. */
  configurationId: string;
  userId: string;
  /** Null when installed on a personal account. */
  teamId: string | null;
}

/**
 * Exchanges the `code` from the integration redirect for an access token:
 * `POST https://api.vercel.com/v2/oauth/access_token` (form-encoded).
 * https://vercel.com/docs/integrations/create-integration/submit-integration#exchange-code-for-access-token
 */
export async function exchangeOAuthCode(input: OAuthExchangeInput): Promise<OAuthExchangeResult> {
  const doFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const path = "/v2/oauth/access_token";
  const res = await doFetch((input.baseUrl ?? VERCEL_API_URL) + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret.reveal(),
      code: input.code,
      redirect_uri: input.redirectUri,
    }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });
  const requestId = res.headers.get("x-vercel-id");
  if (!res.ok) {
    await res.body?.cancel();
    throw new VercelApiError(res.status, "oauth_exchange_failed", requestId, path);
  }
  const body = (await res.json()) as {
    access_token?: unknown;
    installation_id?: unknown;
    user_id?: unknown;
    team_id?: unknown;
  };
  if (
    typeof body.access_token !== "string" ||
    body.access_token === "" ||
    typeof body.installation_id !== "string" ||
    typeof body.user_id !== "string"
  ) {
    throw new VercelApiError(res.status, "oauth_response_invalid", requestId, path);
  }
  return {
    accessToken: new Secret(body.access_token),
    configurationId: body.installation_id,
    userId: body.user_id,
    teamId: typeof body.team_id === "string" && body.team_id !== "" ? body.team_id : null,
  };
}

/**
 * Removes Afe's own integration configuration, revoking its token at Vercel:
 * `DELETE /v1/integrations/configuration/{id}?teamId=`. Best effort: returns
 * false (never throws) if Vercel refuses or is unreachable, in which case the
 * user must remove the integration in the Vercel dashboard.
 */
export async function deleteIntegrationConfiguration(input: {
  token: Secret<string>;
  configurationId: string;
  teamId: string | null;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const doFetch = input.fetch ?? ((url, init) => fetch(url, init));
  const url = new URL(
    `${input.baseUrl ?? VERCEL_API_URL}/v1/integrations/configuration/${encodeURIComponent(input.configurationId)}`,
  );
  if (input.teamId) url.searchParams.set("teamId", input.teamId);
  try {
    const res = await doFetch(url.toString(), {
      method: "DELETE",
      headers: { authorization: `Bearer ${input.token.reveal()}` },
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
    await res.body?.cancel();
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// --- Signed OAuth state ------------------------------------------------------

export interface OAuthState {
  tenantId: string;
  /** Random, also set in an HttpOnly cookie to bind the flow to the browser. */
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Derives the state-signing key from the client secret (domain-separated). */
export function deriveStateKey(clientSecret: Secret<string>): Secret<string> {
  return new Secret(
    createHmac("sha256", clientSecret.reveal()).update("afe:vercel:oauth-state:v1").digest("hex"),
  );
}

export function newStateNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** `<base64url(json)>.<hex HMAC-SHA256>` */
export function signState(state: OAuthState, key: Secret<string>): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${body}.${signHmac("sha256", key, body)}`;
}

/** Returns the state if the signature is valid and it has not expired, else null. */
export function verifyState(
  value: unknown,
  key: Secret<string>,
  now: number = Date.now(),
): OAuthState | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!verifyHmacSignature({ payload: body, secret: key, signature: sig, algorithm: "sha256" })) {
    return null;
  }
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OAuthState>;
    if (
      typeof s.tenantId !== "string" ||
      typeof s.nonce !== "string" ||
      typeof s.expiresAt !== "number" ||
      s.expiresAt < now
    ) {
      return null;
    }
    return { tenantId: s.tenantId, nonce: s.nonce, expiresAt: s.expiresAt };
  } catch {
    return null;
  }
}
