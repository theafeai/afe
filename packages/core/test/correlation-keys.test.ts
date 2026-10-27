/**
 * AFE-18: `upstreamCommitShas`, `deploymentUrls`, digest-pinned `imageRefs`
 * and `artifact.published`, and their compatibility with stored events.
 */
import { describe, expect, it } from "vitest";
import { buildLinks, hintsOf, type CorrelationEvent } from "../src/correlation/index.ts";
import {
  ACTIONS,
  buildChainedEvent,
  canonicalEventSchema,
  deploymentUrlKey,
  GENESIS_HASH,
  isKnownAction,
  parseEventInput,
  safeParseEventInput,
  sha256Hex,
  verifyChain,
  type CanonicalEvent,
  type CanonicalEventInputLike,
} from "../src/index.ts";
import { deploymentInput, SHA } from "./fixtures.ts";

const A = "a".repeat(40);
const DIGEST = `sha256:${"ab".repeat(32)}`;
/** Golden hash pinned in hash-chain.test.ts; it must never change. */
const GOLDEN_HASH = "10d43e189b804e4dc1b69fbc5a89acc90c26589505256b974aff665f81a1a431";

function withCorrelation(extra: Record<string, unknown>): CanonicalEventInputLike {
  const base = deploymentInput();
  return { ...base, correlation: { ...base.correlation, ...extra } } as CanonicalEventInputLike;
}

function chained(input: CanonicalEventInputLike, seq = 1, prevHash = GENESIS_HASH) {
  return buildChainedEvent({
    tenantId: "default",
    seq,
    prevHash,
    input: parseEventInput(input),
    rawPayload: {
      id: "6f1c3c1e-8a7e-4b8e-9d4a-2f1e0c9b8a70",
      sha256: sha256Hex('{"deployment":{"id":1234567}}'),
    },
    id: "0b9f6c43-2f8e-4b49-a9c5-0c3c6d1d7e21",
    recordedAt: new Date("2026-10-01T10:00:02Z"),
  });
}

describe("correlation schema: new keys", () => {
  it("normalises upstreamCommitShas like commitShas", () => {
    const e = parseEventInput(withCorrelation({ upstreamCommitShas: [SHA.toUpperCase(), SHA, A] }));
    expect(e.correlation.upstreamCommitShas).toEqual([SHA, A].sort());
    for (const bad of ["4f2c9b8", "x".repeat(40), `${SHA}0`]) {
      expect(safeParseEventInput(withCorrelation({ upstreamCommitShas: [bad] })).success).toBe(
        false,
      );
    }
    expect(
      safeParseEventInput(withCorrelation({ upstreamCommitShas: Array(201).fill(SHA) })).success,
    ).toBe(false);
  });

  it("accepts deployment URL hosts only, lower-cased, de-duplicated and sorted", () => {
    const e = parseEventInput(
      withCorrelation({
        deploymentUrls: ["Web-Git-Main.vercel.app", "api.acme.example", "api.acme.example"],
      }),
    );
    expect(e.correlation.deploymentUrls).toEqual(["api.acme.example", "web-git-main.vercel.app"]);
    for (const bad of [
      "https://web.vercel.app",
      "web.vercel.app/path",
      "web.vercel.app?_vercel_share=secret",
      "web.vercel.app#x",
      "user:pw@web.vercel.app",
      "web.vercel.app:443",
      "",
    ]) {
      expect(safeParseEventInput(withCorrelation({ deploymentUrls: [bad] })).success, bad).toBe(
        false,
      );
    }
  });

  it("deploymentUrlKey keeps only the host (query strings can hold tokens)", () => {
    expect(deploymentUrlKey("https://Web.vercel.app/x?_vercel_share=tok#f")).toBe("web.vercel.app");
    expect(deploymentUrlKey("http://u:p@api.acme.example:8080/")).toBe("api.acme.example");
    expect(deploymentUrlKey("dpl-abc.vercel.app")).toBe("dpl-abc.vercel.app");
    expect(deploymentUrlKey("ftp://files.example")).toBeUndefined();
    expect(deploymentUrlKey("http://[::1]/")).toBeUndefined();
    expect(deploymentUrlKey("")).toBeUndefined();
    expect(deploymentUrlKey(null)).toBeUndefined();
  });

  it("accepts tagged and digest-pinned image refs, lower-casing the digest", () => {
    const refs = [
      "ghcr.io/acme/api:1.4.2",
      `ghcr.io/acme/api@${DIGEST.toUpperCase().replace("SHA256", "sha256")}`,
      `localhost:5000/acme/api:dev@${DIGEST}`,
      "nginx", // bare name (implicit tag), as recorded before AFE-18
    ];
    const e = parseEventInput(withCorrelation({ imageRefs: refs }));
    expect(e.correlation.imageRefs).toEqual(
      [
        "ghcr.io/acme/api:1.4.2",
        `ghcr.io/acme/api@${DIGEST}`,
        `localhost:5000/acme/api:dev@${DIGEST}`,
        "nginx",
      ].sort(),
    );
    for (const bad of [
      "ghcr.io/acme/api:1@sha256:xyz",
      "a@b@sha256:" + "a".repeat(64),
      "a b:1",
      "@sha256:" + "a".repeat(64),
    ]) {
      expect(safeParseEventInput(withCorrelation({ imageRefs: [bad] })).success, bad).toBe(false);
    }
  });

  it("adds artifact.published to the action vocabulary", () => {
    expect(ACTIONS.ARTIFACT_PUBLISHED).toBe("artifact.published");
    expect(isKnownAction("artifact.published")).toBe(true);
  });
});

describe("hash-chain compatibility", () => {
  it("absent and empty new keys hash identically to the pre-AFE-18 golden event", () => {
    // Empty lists are normalised away (keyList → undefined, then compacted),
    // so neither form adds anything to the canonical JSON.
    expect(chained(deploymentInput()).hash).toBe(GOLDEN_HASH);
    const empty = chained(withCorrelation({ upstreamCommitShas: [], deploymentUrls: [] }));
    expect(empty.hash).toBe(GOLDEN_HASH);
    expect(empty.correlation).not.toHaveProperty("upstreamCommitShas");
    expect(empty.correlation).not.toHaveProperty("deploymentUrls");
    const nulls = chained(withCorrelation({ upstreamCommitShas: null, deploymentUrls: null }));
    expect(nulls.hash).toBe(GOLDEN_HASH);
  });

  it("new keys are covered by the hash when set", () => {
    const e = chained(withCorrelation({ deploymentUrls: ["api.acme.example"] }));
    expect(e.hash).not.toBe(GOLDEN_HASH);
    expect(verifyChain([e]).ok).toBe(true);
  });

  it("events stored before the upgrade (legacy data.correlationHints) still verify", () => {
    // The shape connectors wrote before AFE-18, as read back from storage/export.
    const legacy = chained({
      ...deploymentInput(),
      data: {
        task: "deploy",
        correlationHints: { mentionedCommitShas: [A], deploymentUrls: ["api.acme.example"] },
      },
    });
    const stored = JSON.parse(JSON.stringify(legacy)) as CanonicalEvent;
    const next = JSON.parse(
      JSON.stringify(
        chained(
          withCorrelation({ upstreamCommitShas: [A], deploymentUrls: ["api.acme.example"] }),
          2,
          legacy.hash,
        ),
      ),
    ) as CanonicalEvent;
    expect(canonicalEventSchema.safeParse(stored).success).toBe(true);
    expect(canonicalEventSchema.safeParse(next).success).toBe(true);
    expect(verifyChain([stored, next], { tenantId: "default" })).toMatchObject({ ok: true });
  });
});

describe("correlation prototype reads new keys and legacy hints", () => {
  let n = 0;
  const ev = (p: Partial<CorrelationEvent> & Pick<CorrelationEvent, "action" | "correlation">) =>
    ({
      id: `k${++n}`,
      source: "github",
      actor: { type: "system" },
      target: { type: "other", id: "x" },
      trigger: { type: "unknown" },
      outcome: "succeeded",
      occurredAt: `2026-10-20T10:0${n}:00.000Z`,
      data: {},
      ...p,
    }) as CorrelationEvent;

  it("merges correlation keys (first) with legacy hints", () => {
    const B = "b".repeat(40);
    const e = ev({
      action: "ref.pushed",
      correlation: { upstreamCommitShas: [A], deploymentUrls: ["x.vercel.app"] },
      data: {
        correlationHints: {
          mentionedCommitShas: [B.toUpperCase(), A],
          deploymentUrls: ["X.vercel.app", "y.vercel.app"],
        },
      },
    });
    expect(hintsOf(e)).toEqual({
      upstreamCommitShas: [A, B],
      mentionedImageDigests: [],
      deploymentUrls: ["x.vercel.app", "y.vercel.app"],
    });
  });

  it("links a new-style event with a legacy-style event", () => {
    const APP = "github.com/acme/app";
    const DEPLOY = "github.com/acme/deploy";
    const push = ev({
      action: "ref.pushed",
      correlation: { commitShas: [A], repositories: [APP] },
    });
    const newBump = ev({
      action: "ref.pushed",
      correlation: {
        commitShas: ["c".repeat(40)],
        repositories: [DEPLOY],
        upstreamCommitShas: [A],
      },
    });
    const legacyBump = ev({
      action: "ref.pushed",
      correlation: { commitShas: ["d".repeat(40)], repositories: [DEPLOY] },
      data: { correlationHints: { mentionedCommitShas: [A] } },
    });
    const ghStatus = ev({
      action: "deployment.status_updated",
      correlation: { deploymentIds: ["github:1"], deploymentUrls: ["web-abc.vercel.app"] },
    });
    const vercelLegacy = ev({
      source: "vercel",
      action: "deployment.status_updated",
      correlation: { deploymentIds: ["vercel:dpl_1"] },
      data: { correlationHints: { deploymentUrls: ["web-abc.vercel.app"] } },
    });
    const { links } = buildLinks([push, newBump, legacyBump, ghStatus, vercelLegacy]);
    const kinds = (a: string, b: string) =>
      links
        .find((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a))
        ?.evidence.map((x) => x.kind);
    expect(kinds(push.id, newBump.id)).toContain("reference");
    expect(kinds(push.id, legacyBump.id)).toContain("reference");
    expect(kinds(ghStatus.id, vercelLegacy.id)).toContain("same_deployment_url");
  });
});
