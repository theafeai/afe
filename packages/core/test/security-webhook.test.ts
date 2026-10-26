import { createHmac } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryReplayGuard,
  Secret,
  isTimestampFresh,
  signHmac,
  verifyGitHubSignature,
  verifyHmacSignature,
  verifyVercelSignature,
} from "../src/index.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeCrypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const secret = "It's a Secret to Everybody";
// Test vector from GitHub's "Validating webhook deliveries" documentation.
const githubPayload = "Hello, World!";
const githubSignature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

afterEach(() => {
  vi.mocked(nodeCrypto.timingSafeEqual).mockClear();
});

describe("verifyGitHubSignature", () => {
  it("accepts GitHub's documented test vector", () => {
    expect(verifyGitHubSignature(githubPayload, secret, githubSignature)).toBe(true);
    expect(
      verifyGitHubSignature(Buffer.from(githubPayload), new Secret(secret), githubSignature),
    ).toBe(true);
  });

  it("accepts upper-case hex", () => {
    const upper = "sha256=" + githubSignature.slice(7).toUpperCase();
    expect(verifyGitHubSignature(githubPayload, secret, upper)).toBe(true);
  });

  it("rejects a modified body, wrong secret, missing or duplicated header", () => {
    expect(verifyGitHubSignature("Hello, World?", secret, githubSignature)).toBe(false);
    expect(verifyGitHubSignature(githubPayload, "other", githubSignature)).toBe(false);
    expect(verifyGitHubSignature(githubPayload, secret, undefined)).toBe(false);
    expect(verifyGitHubSignature(githubPayload, secret, null)).toBe(false);
    expect(verifyGitHubSignature(githubPayload, secret, [githubSignature, githubSignature])).toBe(
      false,
    );
  });

  it("rejects the legacy sha1 form and a missing prefix", () => {
    const sha1 = "sha1=" + createHmac("sha1", secret).update(githubPayload).digest("hex");
    expect(verifyGitHubSignature(githubPayload, secret, sha1)).toBe(false);
    expect(verifyGitHubSignature(githubPayload, secret, githubSignature.slice(7))).toBe(false);
  });

  it("rejects wrong-length and non-hex signatures before the constant-time compare", () => {
    const bad = [
      "sha256=",
      githubSignature.slice(0, -2),
      githubSignature + "00",
      githubSignature.slice(0, -1) + "g",
      "sha256=" + "z".repeat(64),
    ];
    for (const sig of bad) expect(verifyGitHubSignature(githubPayload, secret, sig)).toBe(false);
    expect(nodeCrypto.timingSafeEqual).not.toHaveBeenCalled();
  });

  it("uses the constant-time compare for well-formed signatures, valid or not", () => {
    const wrong = "sha256=" + "0".repeat(64);
    expect(verifyGitHubSignature(githubPayload, secret, wrong)).toBe(false);
    expect(verifyGitHubSignature(githubPayload, secret, githubSignature)).toBe(true);
    expect(nodeCrypto.timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it("never verifies with an empty secret", () => {
    const sig = signHmac("sha256", "", githubPayload, "sha256=");
    expect(verifyGitHubSignature(githubPayload, "", sig)).toBe(false);
  });
});

describe("verifyVercelSignature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "deployment.created", createdAt: 1 });
  const sig = createHmac("sha1", "vercel-secret").update(body).digest("hex");

  it("accepts a SHA1 hex HMAC of the raw body", () => {
    expect(sig).toHaveLength(40);
    expect(verifyVercelSignature(body, "vercel-secret", sig)).toBe(true);
    expect(signHmac("sha1", "vercel-secret", body)).toBe(sig);
  });

  it("rejects a re-serialised body, wrong secret and a sha256-length signature", () => {
    expect(
      verifyVercelSignature(JSON.stringify(JSON.parse(body), null, 1), "vercel-secret", sig),
    ).toBe(false);
    expect(verifyVercelSignature(body, "nope", sig)).toBe(false);
    const sha256 = createHmac("sha256", "vercel-secret").update(body).digest("hex");
    expect(verifyVercelSignature(body, "vercel-secret", sha256)).toBe(false);
  });
});

describe("verifyHmacSignature", () => {
  it("supports an arbitrary prefix", () => {
    const sig = signHmac("sha256", "s", "p", "v1=");
    expect(
      verifyHmacSignature({
        payload: "p",
        secret: "s",
        signature: sig,
        algorithm: "sha256",
        prefix: "v1=",
      }),
    ).toBe(true);
    expect(
      verifyHmacSignature({ payload: "p", secret: "s", signature: sig, algorithm: "sha256" }),
    ).toBe(false);
  });
});

describe("replay protection", () => {
  it("InMemoryReplayGuard accepts a delivery once", async () => {
    const guard = new InMemoryReplayGuard();
    const d = { tenantId: null, source: "github", deliveryId: "abc" };
    expect(await guard.recordDelivery(d)).toBe(true);
    expect(await guard.recordDelivery(d)).toBe(false);
    expect(await guard.recordDelivery({ ...d, tenantId: "t" })).toBe(false);
    expect(await guard.recordDelivery({ ...d, source: "vercel" })).toBe(true);
  });

  it("isTimestampFresh enforces the tolerance window", () => {
    const now = 1_700_000_000_000;
    expect(isTimestampFresh(now - 60_000, 300_000, now)).toBe(true);
    expect(isTimestampFresh(now + 60_000, 300_000, now)).toBe(true);
    expect(isTimestampFresh(now - 600_000, 300_000, now)).toBe(false);
    expect(isTimestampFresh(Number.NaN, 300_000, now)).toBe(false);
  });
});
