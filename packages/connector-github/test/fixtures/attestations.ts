/**
 * Recorded-shape responses of `GET /repos/{owner}/{repo}/attestations/{digest}`
 * (https://docs.github.com/en/rest/repos/attestations): a Sigstore bundle
 * whose DSSE envelope carries an in-toto statement with the SLSA v1
 * provenance predicate written by actions/attest-build-provenance. Signatures
 * and certificates are placeholders (Afe does not verify them yet).
 */
export const DIGEST = "sha256:3b1f8e2a7c9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b";
export const BUILD_SHA = "8f3c2a1b9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70";
export const BUILD_RUN_ID = 9100001;

export function provenanceStatement(
  o: { digest?: string; commit?: string; runId?: number; predicateType?: string } = {},
) {
  const hex = (o.digest ?? DIGEST).replace(/^sha256:/, "");
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "ghcr.io/acme/api", digest: { sha256: hex } }],
    predicateType: o.predicateType ?? "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: "https://github.com/acme/api",
            path: ".github/workflows/deploy.yml",
          },
        },
        internalParameters: {
          github: {
            event_name: "push",
            repository_id: "11",
            repository_owner_id: "9001",
            runner_environment: "github-hosted",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/acme/api@refs/heads/main",
            digest: { gitCommit: o.commit ?? BUILD_SHA },
          },
        ],
      },
      runDetails: {
        builder: {
          id: "https://github.com/acme/api/.github/workflows/deploy.yml@refs/heads/main",
        },
        metadata: {
          invocationId: `https://github.com/acme/api/actions/runs/${o.runId ?? BUILD_RUN_ID}/attempts/1`,
        },
      },
    },
  };
}

export function attestation(statement: unknown, payloadType = "application/vnd.in-toto+json") {
  return {
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: "TUlJQy4uLg==" },
        tlogEntries: [],
        timestampVerificationData: {},
      },
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        payloadType,
        signatures: [{ sig: "TUVVQ0lRRC4uLg==" }],
      },
    },
    repository_id: 11,
    bundle_url: "https://api.github.com/repos/acme/api/attestations/bundles/1",
  };
}

/** A response with an SBOM attestation (skipped) and the provenance attestation. */
export function attestationsResponse(o: Parameters<typeof provenanceStatement>[0] = {}) {
  const sbom = { ...provenanceStatement(o), predicateType: "https://spdx.dev/Document/v2.3" };
  return { attestations: [attestation(sbom), attestation(provenanceStatement(o))] };
}
