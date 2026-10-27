/** AFE-21: artifact.published from container packages, and build provenance. */
import { describe, expect, it } from "vitest";
import {
  createMemoryEventSink,
  parseEventInput,
  sourceEventId,
  type CanonicalEvent,
  type CanonicalEventInputLike,
} from "@afe/core";
import { buildLinks } from "@afe/core/correlation";
import {
  GitHubApiError,
  GitHubPayloadError,
  artifactProvenanceEvent,
  buildAppManifest,
  checkPermissions,
  lookupProvenance,
  mapWebhookDelivery,
  parseInvocationId,
  provenanceFromAttestations,
  provenanceFromLabels,
  type GitHubAttestationsResponse,
  type MapResult,
  type ProvenanceLookup,
} from "../src/index.ts";
import {
  BUILD_RUN_ID,
  BUILD_SHA,
  DIGEST,
  attestation,
  attestationsResponse,
  provenanceStatement,
} from "./fixtures/attestations.ts";
import { loadWebhook, variant, type WebhookFixture } from "./fixtures/webhooks.ts";

const RECEIVED = "2026-10-26T10:05:00.000Z";
const IMAGE = "ghcr.io/acme/api";

function map(f: WebhookFixture, provenance?: ProvenanceLookup): MapResult {
  return mapWebhookDelivery({
    event: f.event,
    payload: f.payload,
    rawBody: JSON.stringify(f.payload),
    deliveryId: "d-1",
    receivedAt: RECEIVED,
    connectionId: "conn-1",
    ...(provenance ? { provenance } : {}),
  });
}

function one(f: WebhookFixture, provenance?: ProvenanceLookup) {
  const r = map(f, provenance);
  if (r.status !== "mapped") throw new Error(`not mapped: ${r.reason}`);
  expect(r.events).toHaveLength(1);
  return parseEventInput(r.events[0]);
}

function resolved(response: GitHubAttestationsResponse = attestationsResponse()): ProvenanceLookup {
  const found = provenanceFromAttestations(response, DIGEST);
  if (!found) throw new Error("no provenance");
  return { status: "resolved", ...found };
}

const noLabels = (f: WebhookFixture) => {
  delete f.payload.registry_package.package_version.container_metadata.labels;
};

describe("registry_package → artifact.published", () => {
  it("maps a published container version with its attested provenance", () => {
    const e = one(loadWebhook("registry_package.published"), resolved());
    expect(e).toMatchObject({
      source: "github",
      sourceEventId: "package_version:88001:published:v1.4.0",
      action: "artifact.published",
      actor: { type: "bot", id: "41898282", login: "github-actions[bot]" },
      target: {
        type: "other",
        id: `${IMAGE}@${DIGEST}`,
        name: IMAGE,
        repository: "acme/api",
        url: "https://github.com/acme/api/pkgs/container/api/88001?tag=v1.4.0",
      },
      trigger: {
        type: "upstream",
        sourceValue: "registry_package.published",
        detail: `pushed by workflow run ${BUILD_RUN_ID} (run trigger push)`,
      },
      outcome: "none",
      occurredAt: "2026-10-26T10:03:20.000Z",
      observation: { method: "webhook", deliveryId: "d-1" },
      correlation: {
        imageRefs: [`${IMAGE}:v1.4.0@${DIGEST}`],
        imageDigests: [DIGEST],
        commitShas: [BUILD_SHA],
        runIds: [`github:${BUILD_RUN_ID}`],
        repositories: ["github.com/acme/api"],
        refs: ["refs/heads/main"],
      },
    });
    expect(e.data).toMatchObject({
      action: "published",
      image: IMAGE,
      digest: DIGEST,
      tags: ["v1.4.0"],
      packageVersion: { id: 88001 },
      provenance: {
        source: "attestation",
        verification: "unverified",
        note: "unverified attestation: signature not checked",
        commitSha: BUILD_SHA,
        runId: BUILD_RUN_ID,
        runAttempt: 1,
        workflowPath: ".github/workflows/deploy.yml",
        eventName: "push",
      },
      provenanceLookup: { status: "resolved", detail: null },
    });
    expect((e.data.provenance as { statementSha256: string }).statementSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("without an attestation falls back to the OCI labels in the payload", () => {
    const e = one(loadWebhook("registry_package.published"), {
      status: "not_found",
      detail: "no attestations (404)",
    });
    expect(e.correlation).toMatchObject({ commitShas: [BUILD_SHA] });
    expect(e.correlation.runIds).toBeUndefined();
    expect(e.data).toMatchObject({
      provenance: { source: "oci_labels", verification: "unverified", commitSha: BUILD_SHA },
      provenanceLookup: { status: "not_found", detail: "no attestations (404)" },
      labels: { revision: BUILD_SHA, source: "https://github.com/acme/api" },
    });
  });

  it("without attestation or labels records the base facts only", () => {
    const e = one(variant("registry_package.published", noLabels), {
      status: "failed",
      detail: "attestation lookup failed: 502",
    });
    expect(e.correlation.commitShas).toBeUndefined();
    expect(e.correlation.imageDigests).toEqual([DIGEST]);
    expect(e.data).toMatchObject({
      provenance: null,
      provenanceLookup: { status: "failed" },
    });
    // Still a build pushed by Actions.
    expect(e.trigger).toMatchObject({ type: "upstream", detail: "pushed by GitHub Actions" });
  });

  it("a push by a person is not guessed to be CI", () => {
    const e = one(
      variant("registry_package.published", (f) => {
        noLabels(f);
        f.payload.sender = { login: "alice", id: 501, type: "User" };
      }),
    );
    expect(e.actor).toEqual({ type: "user", id: "501", login: "alice" });
    expect(e.trigger).toEqual({ type: "unknown", sourceValue: "registry_package.published" });
    expect(e.data.provenanceLookup).toBeNull();
  });

  it("keeps every tag of a multi-tag version, each pinned to the digest", () => {
    const e = one(
      variant("registry_package.published", (f) => {
        f.payload.action = "updated";
        f.payload.registry_package.package_version.updated_at = "2026-10-26T10:04:00Z";
        f.payload.registry_package.package_version.metadata = {
          package_type: "container",
          container: { tags: ["latest", "v1.4.0", "sha-8f3c2a1", "bad tag!"] },
        };
      }),
    );
    expect(e.sourceEventId).toBe(
      sourceEventId("package_version", 88001, "updated", "latest,sha-8f3c2a1,v1.4.0"),
    );
    expect(e.occurredAt).toBe("2026-10-26T10:04:00.000Z");
    expect(e.correlation.imageRefs).toEqual([
      `${IMAGE}:latest@${DIGEST}`,
      `${IMAGE}:sha-8f3c2a1@${DIGEST}`,
      `${IMAGE}:v1.4.0@${DIGEST}`,
    ]);
    expect(e.data.tags).toEqual(["latest", "sha-8f3c2a1", "v1.4.0"]);
  });

  it("an untagged version is recorded by digest", () => {
    const e = one(
      variant("registry_package.published", (f) => {
        f.payload.registry_package.package_version.container_metadata.tag = {
          name: "",
          digest: DIGEST,
        };
      }),
    );
    expect(e.sourceEventId).toBe("package_version:88001:published:-");
    expect(e.correlation.imageRefs).toEqual([`${IMAGE}@${DIGEST}`]);
  });

  it("the newer `package` event maps to the same event and key", () => {
    const f = loadWebhook("registry_package.published");
    const pkg: WebhookFixture = {
      event: "package",
      payload: { ...f.payload, package: f.payload.registry_package },
    };
    delete pkg.payload.registry_package;
    const a = one(f);
    const b = one(pkg);
    expect(b.sourceEventId).toBe(a.sourceEventId);
    expect(b.correlation).toEqual(a.correlation);
  });

  it("dedupes a redelivery (same key, stored once)", async () => {
    const sink = createMemoryEventSink();
    const f = loadWebhook("registry_package.published");
    const first = map(f);
    const second = mapWebhookDelivery({
      event: f.event,
      payload: f.payload,
      rawBody: JSON.stringify(f.payload),
      deliveryId: "d-2",
      receivedAt: "2026-10-26T11:00:00Z",
      connectionId: "conn-1",
    });
    if (first.status !== "mapped" || second.status !== "mapped") throw new Error("not mapped");
    expect((await sink.ingest("t", first.events[0]!)).inserted).toBe(true);
    expect((await sink.ingest("t", second.events[0]!)).inserted).toBe(false);
    expect(sink.events("t")).toHaveLength(1);
  });

  it("ignores other actions, non-container packages, unlinked packages and missing digests", () => {
    const reason = (f: WebhookFixture) => {
      const r = map(f);
      return r.status === "ignored" ? r.reason : "mapped";
    };
    expect(reason(variant("registry_package.published", (f) => (f.payload.action = "x")))).toBe(
      "registry_package action x not recorded",
    );
    expect(
      reason(
        variant("registry_package.published", (f) => {
          f.payload.registry_package.package_type = "npm";
          f.payload.registry_package.ecosystem = "npm";
        }),
      ),
    ).toBe("registry_package: npm packages not recorded");
    expect(reason(variant("registry_package.published", (f) => delete f.payload.repository))).toBe(
      "registry_package: package not linked to a repository",
    );
    expect(
      reason(
        variant("registry_package.published", (f) => {
          const v = f.payload.registry_package.package_version;
          v.name = v.version = "1.0.0";
          delete v.container_metadata;
        }),
      ),
    ).toBe("registry_package: package version without an image digest");
  });

  it("rejects a version without id", () => {
    expect(() =>
      map(
        variant("registry_package.published", (f) => {
          delete f.payload.registry_package.package_version.id;
        }),
      ),
    ).toThrow(GitHubPayloadError);
  });
});

describe("provenance parsing", () => {
  it("skips non-provenance attestations and statements about other digests", () => {
    const other = `sha256:${"a".repeat(64)}`;
    expect(provenanceFromAttestations(attestationsResponse({ digest: other }), DIGEST)).toBeNull();
    expect(
      provenanceFromAttestations(
        { attestations: [attestation(provenanceStatement(), "text/plain")] },
        DIGEST,
      ),
    ).toBeNull();
    expect(
      provenanceFromAttestations(
        { attestations: [{ bundle: null, bundle_url: "https://x" }, { bundle: {} }] },
        DIGEST,
      ),
    ).toBeNull();
    const garbled = attestation(provenanceStatement());
    garbled.bundle.dsseEnvelope.payload = Buffer.from("{not json").toString("base64");
    expect(provenanceFromAttestations({ attestations: [garbled] }, DIGEST)).toBeNull();
  });

  it("ignores short commit SHAs", () => {
    const found = provenanceFromAttestations(attestationsResponse({ commit: "8f3c2a1" }), DIGEST);
    expect(found?.provenance.commitSha).toBeNull();
    expect(found?.provenance.runId).toBe(BUILD_RUN_ID);
    expect(provenanceFromLabels({ revision: "8f3c2a1" })).toBeNull();
  });

  it("parses run ids only from github.com run URLs", () => {
    expect(parseInvocationId("https://github.com/acme/api/actions/runs/123/attempts/2")).toEqual({
      repository: "acme/api",
      runId: 123,
      runAttempt: 2,
    });
    expect(parseInvocationId("https://github.com/acme/api/actions/runs/123")).toMatchObject({
      runId: 123,
      runAttempt: null,
    });
    expect(parseInvocationId("https://evil.example/acme/api/actions/runs/123")).toBeNull();
    expect(parseInvocationId(42)).toBeNull();
  });
});

describe("lookupProvenance", () => {
  const client = (fn: () => Promise<GitHubAttestationsResponse>) => ({ listAttestations: fn });

  it("resolves, reports not found (404 or none usable) and failures without throwing", async () => {
    await expect(
      lookupProvenance(
        client(async () => attestationsResponse()),
        "acme",
        "api",
        DIGEST,
      ),
    ).resolves.toMatchObject({ status: "resolved", provenance: { commitSha: BUILD_SHA } });
    await expect(
      lookupProvenance(
        client(async () => {
          throw new GitHubApiError("GitHub GET /x returned 404", 404, null);
        }),
        "acme",
        "api",
        DIGEST,
      ),
    ).resolves.toEqual({ status: "not_found", detail: "no attestations (404)" });
    await expect(
      lookupProvenance(
        client(async () => ({ attestations: [] })),
        "acme",
        "api",
        DIGEST,
      ),
    ).resolves.toMatchObject({ status: "not_found" });
    await expect(
      lookupProvenance(
        client(async () => {
          throw new GitHubApiError("boom token=secret", 502, null);
        }),
        "acme",
        "api",
        DIGEST,
      ),
    ).resolves.toEqual({ status: "failed", detail: "attestation lookup failed: 502" });
  });

  it("gives up after the timeout", async () => {
    const r = await lookupProvenance(
      client(() => new Promise(() => {})),
      "acme",
      "api",
      DIGEST,
      { timeoutMs: 10 },
    );
    expect(r).toEqual({ status: "failed", detail: "attestation lookup timed out after 10 ms" });
  });

  it("refuses an invalid digest", async () => {
    const r = await lookupProvenance(
      client(async () => ({})),
      "acme",
      "api",
      "sha256:../../x",
    );
    expect(r.status).toBe("not_attempted");
  });
});

describe("permissions and manifest", () => {
  it("packages and attestations are optional", () => {
    const check = checkPermissions({
      actions: "read",
      deployments: "read",
      environments: "read",
      metadata: "read",
    });
    expect(check.ok).toBe(true);
    expect(check.optionalMissing).toEqual([
      "attestations",
      "contents",
      "packages",
      "pull_requests",
    ]);
    expect(
      checkPermissions({
        actions: "read",
        deployments: "read",
        environments: "read",
        metadata: "read",
        packages: "read",
        attestations: "read",
      }).optionalMissing,
    ).toEqual(["contents", "pull_requests"]);
  });

  it("the manifest requests packages and attestations read and subscribes to registry_package", () => {
    const m = buildAppManifest({ publicUrl: "https://x" });
    expect(m.default_permissions).toMatchObject({ packages: "read", attestations: "read" });
    expect(m.default_events).toContain("registry_package");
  });
});

describe("correlation (AFE-15 prototype)", () => {
  async function stored(inputs: CanonicalEventInputLike[]): Promise<CanonicalEvent[]> {
    const sink = createMemoryEventSink();
    for (const i of inputs) await sink.ingest("t", i);
    return sink.events("t");
  }

  function run() {
    const r = map(loadWebhook("workflow_run.push.completed"));
    if (r.status !== "mapped") throw new Error("run not mapped");
    return r.events[0]!;
  }

  function argoSync(): CanonicalEventInputLike {
    return {
      source: "argocd",
      sourceEventId: "sync:uid-1:2026-10-26T10:10:00Z:finished",
      connectionId: "argo-1",
      action: "argocd.sync.succeeded",
      actor: { type: "system", id: "argocd" },
      target: {
        type: "application",
        id: "argocd/api-prod",
        application: "api-prod",
        environment: "production",
      },
      trigger: { type: "auto_sync" },
      outcome: "succeeded",
      occurredAt: "2026-10-26T10:10:00Z",
      observedAt: "2026-10-26T10:10:01Z",
      observation: { method: "stream" },
      correlation: {
        repositories: ["github.com/acme/deploy"],
        commitShas: ["c".repeat(40)],
        imageRefs: [`${IMAGE}:v1.4.0@${DIGEST}`],
        imageDigests: [DIGEST],
      },
      data: {},
    };
  }

  const linkBetween = (events: CanonicalEvent[], a: string, b: string) => {
    const ida = events.find((e) => e.action === a)!.id;
    const idb = events.find((e) => e.action === b)!.id;
    return buildLinks(events).links.find(
      (l) => (l.from === ida && l.to === idb) || (l.from === idb && l.to === ida),
    );
  };

  it("links the artifact to the run that built it and to the ArgoCD sync of its digest", async () => {
    const r = map(loadWebhook("registry_package.published"), resolved());
    if (r.status !== "mapped") throw new Error("not mapped");
    const events = await stored([run(), r.events[0]!, argoSync()]);

    const toRun = linkBetween(events, "workflow_run.completed", "artifact.published");
    expect(toRun?.confidence).toBe("certain");
    expect(toRun?.evidence.map((e) => e.kind).sort()).toEqual([
      "same_commit_same_repo",
      "same_run",
    ]);

    const toSync = linkBetween(events, "artifact.published", "argocd.sync.succeeded");
    expect(toSync?.confidence).toBe("strong");
    expect(toSync?.evidence.map((e) => e.kind)).toContain("same_image_digest");
  });

  it("a late artifact.provenance_resolved event links the stored artifact to its run", async () => {
    const base = map(variant("registry_package.published", noLabels), {
      status: "not_found",
      detail: "no attestations",
    });
    if (base.status !== "mapped") throw new Error("not mapped");
    const found = provenanceFromAttestations(attestationsResponse(), DIGEST)!;
    const late = artifactProvenanceEvent(
      {
        image: IMAGE,
        digest: DIGEST,
        tags: ["v1.4.0"],
        packageVersionId: 88001,
        repository: { id: 11, fullName: "acme/api" },
      },
      found,
      { connectionId: "conn-1", observedAt: "2026-10-26T10:08:00Z" },
    );
    const parsed = parseEventInput(late);
    expect(parsed).toMatchObject({
      sourceEventId: `artifact_provenance:11:${sourceEventId(DIGEST)}`,
      action: "artifact.provenance_resolved",
      observation: { method: "poll" },
      correlation: {
        imageDigests: [DIGEST],
        commitShas: [BUILD_SHA],
        runIds: [`github:${BUILD_RUN_ID}`],
      },
      data: { provenance: { verification: "unverified", source: "attestation" } },
    });
    const events = await stored([run(), base.events[0]!, late]);
    expect(linkBetween(events, "artifact.published", "workflow_run.completed")).toBeUndefined();
    expect(
      linkBetween(events, "artifact.published", "artifact.provenance_resolved")?.evidence[0]?.kind,
    ).toBe("same_image_digest");
    expect(
      linkBetween(events, "workflow_run.completed", "artifact.provenance_resolved")?.confidence,
    ).toBe("certain");
  });
});
