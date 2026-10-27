/**
 * Build provenance of published container images (AFE-21).
 *
 * `registry_package` webhooks say that an image (name, tags, digest) was
 * pushed to ghcr.io, but not which commit and workflow run built it. That
 * comes from the repository's artifact attestations: GitHub's
 * `actions/attest-build-provenance` stores a Sigstore bundle whose DSSE
 * envelope carries an in-toto statement with a SLSA v1 provenance predicate
 * (`resolvedDependencies[].digest.gitCommit`, `runDetails.metadata.invocationId`).
 * Fallback: the OCI labels `org.opencontainers.image.revision` / `.source`
 * that GitHub copies into the webhook payload.
 *
 * Attestation signatures are NOT verified here (follow-up): every provenance
 * Afe records says `verification: "unverified"`. It is evidence of what the
 * attestation claims, linked by digest, not a proof.
 *
 * This file is pure apart from `lookupProvenance` (one REST read through an
 * `InstallationClient`). The webhook mapping of the package event itself is
 * `artifactPublishedEvent` in mapping.ts. Design and limits:
 * docs/connectors/github.md "Artifacts".
 *
 * References:
 * - https://docs.github.com/en/rest/repos/attestations
 * - https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
 * - https://slsa.dev/spec/v1.0/provenance
 * - https://github.com/actions/attest-build-provenance (GitHub build type)
 * - https://github.com/opencontainers/image-spec/blob/main/annotations.md
 */
import { createHash } from "node:crypto";
import {
  repositoryKey,
  type CanonicalEventInputLike,
  type JsonObject,
  type ObservationMethod,
} from "@afe/core";
import type { InstallationClient } from "./client.ts";
import { artifactProvenanceEventId } from "./event-ids.ts";
import { GitHubApiError } from "./http.ts";

/** The registry Afe records images for. Outbound requests never go anywhere else. */
export const IMAGE_REGISTRY = "ghcr.io";

/** Action of the follow-up event (see `artifactProvenanceEvent`). Not yet in core `ACTIONS`. */
export const ARTIFACT_PROVENANCE_RESOLVED = "artifact.provenance_resolved";

export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FULL_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_STATEMENT_BYTES = 1024 * 1024;
const MAX_ATTESTATIONS = 30;

// ---------------------------------------------------------------------------
// REST shapes (subset)
// ---------------------------------------------------------------------------

/** One entry of `GET /repos/{o}/{r}/attestations/{digest}`. */
export interface GitHubAttestation {
  /** Sigstore bundle; may be null when GitHub only returns `bundle_url` (To verify). */
  bundle?: {
    mediaType?: string;
    dsseEnvelope?: { payload?: string; payloadType?: string; signatures?: unknown[] };
    verificationMaterial?: unknown;
  } | null;
  repository_id?: number;
  bundle_url?: string;
}

export interface GitHubAttestationsResponse {
  attestations?: GitHubAttestation[];
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type ProvenanceSource = "attestation" | "oci_labels";

/** What a build provenance claims about one image digest. */
export interface ArtifactProvenance {
  source: ProvenanceSource;
  /** Signatures are not checked (follow-up): always "unverified". */
  verification: "unverified";
  /** Full commit SHA the image was built from. */
  commitSha: string | null;
  /** GitHub Actions run id (`runDetails.metadata.invocationId`). */
  runId: number | null;
  runAttempt: number | null;
  /** Repository the build ran in, `host/owner/name` (`repositoryKey`). */
  repository: string | null;
  /** Workflow file and ref (`externalParameters.workflow`). */
  workflowPath: string | null;
  workflowRef: string | null;
  /** Event that started the run (`internalParameters.github.event_name`). */
  eventName: string | null;
  builderId: string | null;
  buildType: string | null;
  predicateType: string | null;
  /** SHA-256 (hex) of the decoded in-toto statement bytes, to match it with GitHub's copy later. */
  statementSha256: string | null;
}

export type ProvenanceLookup =
  | { status: "resolved"; provenance: ArtifactProvenance; attestation: GitHubAttestation }
  /** GitHub has no (usable) provenance attestation for the digest yet. */
  | { status: "not_found"; detail: string }
  /** The lookup failed (network, rate limit, permission, timeout). */
  | { status: "failed"; detail: string }
  /** Not attempted (no `attestations` permission, disabled, no repository). */
  | { status: "not_attempted"; detail: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, max = 1024): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\u0000")
    ? v
    : null;
}

/** `https://github.com/<owner>/<repo>/actions/runs/<id>[/attempts/<n>]` → run id and attempt. */
export function parseInvocationId(
  invocationId: unknown,
): { repository: string; runId: number; runAttempt: number | null } | null {
  const s = str(invocationId);
  if (!s) return null;
  const m =
    /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d{1,19})(?:\/attempts\/(\d{1,6}))?\/?$/.exec(
      s,
    );
  if (!m) return null;
  const runId = Number(m[2]);
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  return { repository: m[1]!, runId, runAttempt: m[3] ? Number(m[3]) : null };
}

function safeRepositoryKey(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^https:\/\//.test(s)) return null;
  try {
    return repositoryKey(s);
  } catch {
    return null;
  }
}

/**
 * Parses one in-toto statement (already decoded) as SLSA v1 provenance for
 * `digest`. Returns null when it is not a provenance statement about that
 * digest (e.g. an SBOM attestation, or another subject).
 */
export function provenanceFromStatement(
  statement: unknown,
  digest: string,
  statementSha256: string | null = null,
): ArtifactProvenance | null {
  if (!isObject(statement)) return null;
  const type = str(statement._type);
  if (!type || !type.startsWith("https://in-toto.io/Statement/")) return null;
  if (statement.predicateType !== SLSA_PROVENANCE_V1) return null;
  const hex = digest.toLowerCase().replace(/^sha256:/, "");
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const about = subjects.some(
    (s) => isObject(s) && isObject(s.digest) && String(s.digest.sha256).toLowerCase() === hex,
  );
  if (!about) return null;

  const predicate = isObject(statement.predicate) ? statement.predicate : {};
  const build = isObject(predicate.buildDefinition) ? predicate.buildDefinition : {};
  const run = isObject(predicate.runDetails) ? predicate.runDetails : {};
  const external = isObject(build.externalParameters) ? build.externalParameters : {};
  const workflow = isObject(external.workflow) ? external.workflow : {};
  const internal = isObject(build.internalParameters) ? build.internalParameters : {};
  const github = isObject(internal.github) ? internal.github : {};
  const metadata = isObject(run.metadata) ? run.metadata : {};
  const builder = isObject(run.builder) ? run.builder : {};

  let commitSha: string | null = null;
  for (const dep of Array.isArray(build.resolvedDependencies) ? build.resolvedDependencies : []) {
    const sha = isObject(dep) && isObject(dep.digest) ? dep.digest.gitCommit : undefined;
    if (typeof sha === "string" && FULL_SHA.test(sha.toLowerCase())) {
      commitSha = sha.toLowerCase();
      break;
    }
  }
  const invocation = parseInvocationId(metadata.invocationId);
  const repository =
    safeRepositoryKey(workflow.repository) ??
    (invocation ? repositoryKey(invocation.repository) : null);
  return {
    source: "attestation",
    verification: "unverified",
    commitSha,
    runId: invocation?.runId ?? null,
    runAttempt: invocation?.runAttempt ?? null,
    repository,
    workflowPath: str(workflow.path),
    workflowRef: str(workflow.ref),
    eventName: str(github.event_name, 64),
    builderId: str(builder.id),
    buildType: str(build.buildType),
    predicateType: SLSA_PROVENANCE_V1,
    statementSha256,
  };
}

/** Decodes a DSSE envelope's in-toto statement; null if it is not one or is malformed. */
function decodeStatement(att: GitHubAttestation): { statement: unknown; sha256: string } | null {
  const env = isObject(att.bundle) ? att.bundle.dsseEnvelope : undefined;
  if (!isObject(env) || env.payloadType !== IN_TOTO_PAYLOAD_TYPE) return null;
  if (typeof env.payload !== "string" || env.payload.length > (MAX_STATEMENT_BYTES * 4) / 3 + 4) {
    return null;
  }
  const bytes = Buffer.from(env.payload, "base64");
  if (bytes.length === 0 || bytes.length > MAX_STATEMENT_BYTES) return null;
  try {
    return {
      statement: JSON.parse(bytes.toString("utf8")) as unknown,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  }
}

/**
 * The first SLSA provenance attestation for `digest` in an attestations
 * response (GitHub lists newest first), or null. Other attestation types
 * (SBOMs, custom predicates) and statements about other subjects are skipped.
 */
export function provenanceFromAttestations(
  response: GitHubAttestationsResponse | null | undefined,
  digest: string,
): { provenance: ArtifactProvenance; attestation: GitHubAttestation } | null {
  const list = Array.isArray(response?.attestations) ? response.attestations : [];
  for (const att of list.slice(0, MAX_ATTESTATIONS)) {
    if (!isObject(att)) continue;
    const decoded = decodeStatement(att);
    if (!decoded) continue;
    const provenance = provenanceFromStatement(decoded.statement, digest, decoded.sha256);
    if (provenance) return { provenance, attestation: att };
  }
  return null;
}

/** OCI image labels as GitHub reports them in `container_metadata.labels`. */
export interface OciLabels {
  revision?: string | null;
  source?: string | null;
  all_labels?: Record<string, unknown> | null;
  [k: string]: unknown;
}

/**
 * Fallback provenance from OCI labels: `org.opencontainers.image.revision`
 * (a full commit SHA; short SHAs are ignored) and `.source` (repository URL).
 * Set by whoever built the image (e.g. docker/metadata-action), so it is a
 * claim, like an unverified attestation. Null when neither is usable.
 */
export function provenanceFromLabels(labels: unknown): ArtifactProvenance | null {
  if (!isObject(labels)) return null;
  const all = isObject(labels.all_labels) ? labels.all_labels : {};
  const revision = str(labels.revision) ?? str(all["org.opencontainers.image.revision"]);
  const source = str(labels.source) ?? str(all["org.opencontainers.image.source"]);
  const commitSha =
    revision && FULL_SHA.test(revision.toLowerCase()) ? revision.toLowerCase() : null;
  const repository = safeRepositoryKey(source);
  if (!commitSha && !repository) return null;
  return {
    source: "oci_labels",
    verification: "unverified",
    commitSha,
    runId: null,
    runAttempt: null,
    repository,
    workflowPath: null,
    workflowRef: null,
    eventName: null,
    builderId: null,
    buildType: null,
    predicateType: null,
    statementSha256: null,
  };
}

/** The provenance as stored in `data.provenance`. */
export function provenanceData(p: ArtifactProvenance): JsonObject {
  return {
    source: p.source,
    verification: p.verification,
    note:
      p.source === "attestation"
        ? "unverified attestation: signature not checked"
        : "unverified OCI labels set by the image builder",
    commitSha: p.commitSha,
    runId: p.runId,
    runAttempt: p.runAttempt,
    repository: p.repository,
    workflowPath: p.workflowPath,
    workflowRef: p.workflowRef,
    eventName: p.eventName,
    builderId: p.builderId,
    buildType: p.buildType,
    predicateType: p.predicateType,
    statementSha256: p.statementSha256,
  };
}

// ---------------------------------------------------------------------------
// Lookup (one REST read)
// ---------------------------------------------------------------------------

export interface LookupOptions {
  /** Give up after this long (the request itself may finish later; its result is ignored). */
  timeoutMs?: number;
}

/**
 * Looks up the provenance attestation of `digest` in `owner/repo`. Never
 * throws: failures are returned as `failed` (with a detail that carries no
 * credentials or response bodies) so the caller can ingest without it.
 */
export async function lookupProvenance(
  client: Pick<InstallationClient, "listAttestations">,
  owner: string,
  repo: string,
  digest: string,
  options: LookupOptions = {},
): Promise<ProvenanceLookup> {
  if (!DIGEST.test(digest)) return { status: "not_attempted", detail: "invalid digest" };
  const timeoutMs = options.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const response = await Promise.race([client.listAttestations(owner, repo, digest), timeout]);
    if (response === "timeout") {
      return { status: "failed", detail: `attestation lookup timed out after ${timeoutMs} ms` };
    }
    const found = provenanceFromAttestations(response, digest);
    if (found) return { status: "resolved", ...found };
    const count = Array.isArray(response?.attestations) ? response.attestations.length : 0;
    return {
      status: "not_found",
      detail:
        count > 0
          ? `${count} attestation(s), none a readable SLSA provenance for the digest`
          : "no attestations",
    };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return { status: "not_found", detail: "no attestations (404)" };
    }
    const detail =
      err instanceof GitHubApiError
        ? `attestation lookup failed: ${err.status || err.name}`
        : `attestation lookup failed: ${err instanceof Error ? err.name : "error"}`;
    return { status: "failed", detail };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Follow-up event: provenance resolved after the artifact was recorded
// ---------------------------------------------------------------------------

/** The image an `artifact.published` event recorded; enough to look up and link its provenance. */
export interface ArtifactRef {
  /** `ghcr.io/<namespace>/<name>`, lower case. */
  image: string;
  digest: string;
  tags: string[];
  packageVersionId: number;
  repository: { id: number; fullName: string };
}

/** Digest-pinned image refs, one per tag (`image:tag@digest`), or `image@digest` when untagged. */
export function pinnedImageRefs(image: string, digest: string, tags: string[]): string[] {
  return tags.length > 0 ? tags.map((t) => `${image}:${t}@${digest}`) : [`${image}@${digest}`];
}

/** Correlation keys contributed by a provenance. */
export function provenanceCorrelation(p: ArtifactProvenance | null): {
  commitShas?: string[];
  runIds?: string[];
  repositories: string[];
  refs?: string[];
} {
  if (!p) return { repositories: [] };
  return {
    ...(p.commitSha ? { commitShas: [p.commitSha] } : {}),
    ...(p.runId ? { runIds: [`github:${p.runId}`] } : {}),
    repositories: p.repository ? [p.repository] : [],
    ...(p.workflowRef?.startsWith("refs/") ? { refs: [p.workflowRef] } : {}),
  };
}

/**
 * `artifact.provenance_resolved`: the provenance of an image that was
 * recorded (as `artifact.published`) before its attestation existed. Stored
 * events are immutable, so the late provenance is a separate event linked by
 * digest (and by commit and run to the build). Raw payload: the attestation.
 */
export function artifactProvenanceEvent(
  artifact: ArtifactRef,
  found: { provenance: ArtifactProvenance; attestation: GitHubAttestation },
  ctx: {
    connectionId: string | null;
    observedAt: Date | string;
    method?: ObservationMethod;
    jobId?: string;
    detail?: string;
  },
): CanonicalEventInputLike {
  const { provenance } = found;
  const corr = provenanceCorrelation(provenance);
  return {
    source: "github",
    sourceEventId: artifactProvenanceEventId({
      repositoryId: artifact.repository.id,
      digest: artifact.digest,
    }),
    connectionId: ctx.connectionId,
    action: ARTIFACT_PROVENANCE_RESOLVED,
    // The attestation names a run, not a person; the run's actors are on its
    // workflow_run events (same runIds).
    actor: { type: "unknown" },
    target: {
      type: "other",
      id: `${artifact.image}@${artifact.digest}`,
      name: artifact.image,
      repository: artifact.repository.fullName,
    },
    trigger: {
      type: "upstream",
      sourceValue: "attestation",
      detail: "build provenance attestation found after the image was recorded",
    },
    outcome: "none",
    // An attestation carries no reliable time of its own in the parts Afe
    // reads; the event is the moment Afe resolved it.
    occurredAt: ctx.observedAt,
    observedAt: ctx.observedAt,
    observation: {
      method: ctx.method ?? "poll",
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
      detail: (ctx.detail ?? "GET /repos/{owner}/{repo}/attestations/{digest}").slice(0, 1024),
    },
    correlation: {
      imageRefs: pinnedImageRefs(artifact.image, artifact.digest, artifact.tags),
      imageDigests: [artifact.digest],
      repositories: [
        ...new Set([repositoryKey(artifact.repository.fullName), ...corr.repositories]),
      ],
      ...(corr.commitShas ? { commitShas: corr.commitShas } : {}),
      ...(corr.runIds ? { runIds: corr.runIds } : {}),
      ...(corr.refs ? { refs: corr.refs } : {}),
    },
    data: {
      image: artifact.image,
      digest: artifact.digest,
      tags: artifact.tags,
      packageVersionId: artifact.packageVersionId,
      provenance: provenanceData(provenance),
    },
    rawPayload: { contentType: "application/json", body: JSON.stringify(found.attestation) },
  };
}
