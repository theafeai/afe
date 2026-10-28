import tls from "node:tls";
import { Agent, fetch as httpFetch } from "undici";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { constantTimeEqual } from "@afe/core";
import {
  createSafeLookup,
  validateOutboundUrl,
  type OutboundUrlPolicy,
  type Secret,
} from "@afe/core/security";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  scopes: string[];
  authMethod: "none" | "client_secret_basic" | "client_secret_post";
  caPem?: string;
  revision: string;
}
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}
/** Bounded, non-redirecting JSON HTTP; all discovered destinations are checked as well. */
export function oidcHttp(policy: OutboundUrlPolicy, caPem?: string) {
  const roots = tls.getCACertificates?.("default") ?? [...tls.rootCertificates];
  const agent = new Agent({
    connect: {
      lookup: createSafeLookup(policy),
      timeout: 10_000,
      ...(caPem ? { ca: [...roots, caPem] } : {}),
    },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  async function json<T>(url: string, body?: URLSearchParams, authorization?: string): Promise<T> {
    await validateOutboundUrl(url, policy);
    const res = await httpFetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(authorization ? { authorization } : {}),
      },
      ...(body ? { body: body.toString() } : {}),
      dispatcher: agent,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    try {
      if (
        res.status !== 200 ||
        !res.headers.get("content-type")?.toLowerCase().includes("application/json")
      )
        throw new Error("OIDC response rejected");
      let size = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.body!) {
        size += chunk.length;
        if (size > 256 * 1024) throw new Error("OIDC response too large");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } finally {
      await res.body?.cancel().catch(() => {});
    }
  }
  return { json, close: () => agent.close() };
}
export async function discoverOidc(
  http: ReturnType<typeof oidcHttp>,
  config: OidcConfig,
  policy: OutboundUrlPolicy,
) {
  const issuer = new URL(config.issuer);
  if (issuer.search || issuer.hash || issuer.username || issuer.password)
    throw new Error("invalid issuer");
  await validateOutboundUrl(config.issuer, policy);
  const d = await http.json<Discovery>(
    `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  );
  if (
    d.issuer !== config.issuer ||
    !Array.isArray(d.response_types_supported) ||
    !d.response_types_supported.includes("code") ||
    (d.code_challenge_methods_supported && !d.code_challenge_methods_supported.includes("S256")) ||
    !(d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"]).includes(
      config.authMethod,
    )
  )
    throw new Error("incompatible OIDC provider");
  for (const endpoint of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) {
    if (typeof endpoint !== "string") throw new Error("missing OIDC endpoint");
    await validateOutboundUrl(endpoint, policy);
  }
  return d;
}
export async function exchangeOidcCode(
  http: ReturnType<typeof oidcHttp>,
  config: OidcConfig,
  discovery: Discovery,
  options: {
    code: string;
    verifier: string;
    nonce: string;
    redirectUri: string;
    clientSecret?: Secret<string>;
  },
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.verifier,
  });
  let authorization: string | undefined;
  if (config.authMethod === "client_secret_basic") {
    if (!options.clientSecret) throw new Error("missing OIDC client secret");
    // OAuth Basic uses application/x-www-form-urlencoded encoding of both components.
    const encode = (v: string) => new URLSearchParams({ v }).toString().slice(2);
    authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(options.clientSecret.reveal())}`).toString("base64")}`;
  } else {
    body.set("client_id", config.clientId);
    if (config.authMethod === "client_secret_post") {
      if (!options.clientSecret) throw new Error("missing OIDC client secret");
      body.set("client_secret", options.clientSecret.reveal());
    }
  }
  const tokens = await http.json<{ id_token?: unknown }>(
    discovery.token_endpoint,
    body,
    authorization,
  );
  if (typeof tokens.id_token !== "string" || tokens.id_token.length > 32 * 1024)
    throw new Error("missing ID token");
  const jwks = await http.json<JSONWebKeySet>(discovery.jwks_uri);
  if (!Array.isArray(jwks.keys) || jwks.keys.length > 100) throw new Error("invalid JWKS");
  const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: ["RS256", "PS256", "ES256"],
    requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce"],
    maxTokenAge: "10 minutes",
    clockTolerance: 30,
  });
  const claims = verified.payload;
  if (
    typeof claims.nonce !== "string" ||
    !constantTimeEqual(claims.nonce, options.nonce) ||
    !claims.sub ||
    claims.sub.length > 512 ||
    (claims.azp !== undefined && claims.azp !== config.clientId) ||
    (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId) ||
    claims.exp! <= Date.now() / 1000
  )
    throw new Error("invalid ID token claims");
  return { token: tokens.id_token, subject: claims.sub, expiresAt: claims.exp! };
}
