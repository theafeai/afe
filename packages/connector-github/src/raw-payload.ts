/**
 * Raw evidence for GitHub events (docs/security/data-inventory.md, rule R8).
 *
 * Afe keeps the delivery body as received, except for fields the data
 * inventory says Afe does not store:
 * - email addresses (any `email` member: commit author/committer, pusher,
 *   user objects). Actors are identified by GitHub id and login instead;
 * - pull request bodies (`pull_request.body`).
 *
 * When nothing is stripped the stored bytes are exactly the signed delivery
 * body. When something is, the body is the re-serialised JSON without those
 * members and the event's `observation.detail` says so.
 *
 * Kept on purpose: commit messages and display titles (commit metadata),
 * `repository_dispatch.client_payload` and `deployment.payload` (set by the
 * caller; evidence of what was requested; never copied into `data`), and
 * deployment review comments (the reviewer's stated reason).
 */
import type { RawPayloadInput } from "@afe/core";

export interface SanitisedRawPayload {
  rawPayload: RawPayloadInput;
  /** JSON paths that were removed (wildcards for repeated members). */
  stripped: string[];
}

export function githubRawPayload(rawBody: string, payload: unknown): SanitisedRawPayload {
  const stripped = new Set<string>();
  const clean = strip(payload, "", stripped);
  if (stripped.size === 0) {
    return { rawPayload: { contentType: "application/json", body: rawBody }, stripped: [] };
  }
  return {
    rawPayload: { contentType: "application/json", body: JSON.stringify(clean) },
    stripped: [...stripped].sort(),
  };
}

function strip(value: unknown, path: string, out: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, `${path}[]`, out));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const p = path ? `${path}.${key}` : key;
    if (key === "email" && v !== null) {
      out.add(p);
      continue;
    }
    if (p === "pull_request.body" && v !== null) {
      out.add(p);
      continue;
    }
    result[key] = strip(v, p, out);
  }
  return result;
}
