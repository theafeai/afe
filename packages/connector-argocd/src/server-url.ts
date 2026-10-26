import { X509Certificate } from "node:crypto";

export class InvalidConnectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConnectionInputError";
  }
}

/**
 * Normalises an ArgoCD server URL into the connection's `externalId`, so the
 * same instance is recognised however the user typed it:
 * lower-case scheme and host, default port removed, query/fragment rejected,
 * trailing slashes removed. A path is kept, because ArgoCD can be served under
 * a root path (`server.rootpath`, e.g. `https://example.com/argocd`).
 *
 * This only normalises; `validateOutboundUrl` decides whether Afe may call it.
 */
export function normaliseServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InvalidConnectionInputError("server URL is not a valid absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidConnectionInputError("server URL must use https");
  }
  if (url.username || url.password) {
    throw new InvalidConnectionInputError("server URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new InvalidConnectionInputError("server URL must not contain a query or fragment");
  }
  let path = url.pathname.replace(/\/+$/, "");
  // Users often paste a UI or API URL; the API lives under <root>/api.
  path = path.replace(/\/(api(\/v1)?|applications)$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** Joins the normalised server URL with an API path (`/api/v1/...`). */
export function apiUrl(serverUrl: string, path: string): URL {
  return new URL(serverUrl.replace(/\/+$/, "") + path);
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END \1-----/g;
export const MAX_CA_BUNDLE_BYTES = 256 * 1024;

/**
 * Validates a user-supplied CA bundle (one or more PEM certificates) and
 * returns it in canonical form. CA certificates are public data and are stored
 * in the connection's non-secret config (docs/security/rules.md R7.2). A bundle
 * containing a private key is refused, so nobody pastes one by mistake.
 */
export function parseCaBundle(pem: string): string {
  if (pem.length > MAX_CA_BUNDLE_BYTES) {
    throw new InvalidConnectionInputError("CA bundle is too large");
  }
  if (/PRIVATE KEY-----/.test(pem)) {
    throw new InvalidConnectionInputError(
      "CA bundle contains a private key; paste only the CA certificate(s)",
    );
  }
  const certs: string[] = [];
  for (const m of pem.matchAll(PEM_BLOCK)) {
    if (m[1] !== "CERTIFICATE") continue;
    const block = m[0].replace(/\r\n/g, "\n");
    try {
      new X509Certificate(block);
    } catch {
      throw new InvalidConnectionInputError("CA bundle contains an invalid certificate");
    }
    certs.push(block);
  }
  if (certs.length === 0) {
    throw new InvalidConnectionInputError("CA bundle contains no PEM certificate");
  }
  return certs.join("\n") + "\n";
}

/** Subject, fingerprint and expiry of each certificate, for display. */
export function describeCaBundle(
  pem: string,
): { subject: string; fingerprint256: string; validTo: string }[] {
  const out: { subject: string; fingerprint256: string; validTo: string }[] = [];
  for (const m of pem.matchAll(PEM_BLOCK)) {
    if (m[1] !== "CERTIFICATE") continue;
    const cert = new X509Certificate(m[0]);
    out.push({
      subject: cert.subject,
      fingerprint256: cert.fingerprint256,
      validTo: new Date(cert.validTo).toISOString(),
    });
  }
  return out;
}
