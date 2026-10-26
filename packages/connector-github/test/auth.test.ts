import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Secret } from "@afe/core/security";
import {
  AppJwtSource,
  GitHubConfigError,
  InstallationTokenCache,
  createAppJwt,
  deriveStateKey,
  loadGitHubAppConfigFromEnv,
  newNonce,
  signState,
  verifyState,
  type InstallationToken,
} from "../src/index.ts";
import { testKeyPair } from "./fixtures.ts";

const { privatePem, publicKey } = testKeyPair();

function decode(jwt: string) {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p!, "base64url").toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s!, "base64url"),
  };
}

describe("App JWT", () => {
  it("is RS256 with iat backdated 60s, exp within 10 minutes and iss = app id", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const jwt = createAppJwt({ appId: "77", privateKey: new Secret(privatePem), now });
    const { header, payload, signingInput, signature } = decode(jwt);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    const nowSec = now / 1000;
    expect(payload).toEqual({ iat: nowSec - 60, exp: nowSec + 540, iss: "77" });
    expect(payload.exp - nowSec).toBeLessThanOrEqual(600);
    expect(verify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature)).toBe(true);
    // A different key does not verify it.
    const other = createPublicKey(testKeyPair().privatePem);
    expect(verify("RSA-SHA256", Buffer.from(signingInput), other, signature)).toBe(false);
  });

  it("is cached and re-signed one minute before expiry", () => {
    let now = Date.parse("2026-10-26T12:00:00Z");
    const src = new AppJwtSource({ appId: "77", privateKey: privatePem }, () => now);
    const a = src.get();
    now += 7 * 60_000;
    expect(src.get()).toBe(a);
    now += 60_000 + 1000; // within the last minute
    expect(src.get()).not.toBe(a);
  });
});

describe("env config", () => {
  const base = {
    AFE_GITHUB_APP_ID: "77",
    AFE_GITHUB_APP_SLUG: "afe-test",
    AFE_GITHUB_WEBHOOK_SECRET: "whsec",
  };

  it("returns null when nothing is set", () => {
    expect(loadGitHubAppConfigFromEnv({})).toBeNull();
  });

  it("loads a key with escaped newlines and keeps secrets wrapped", () => {
    const cfg = loadGitHubAppConfigFromEnv({
      ...base,
      AFE_GITHUB_APP_PRIVATE_KEY: privatePem.replace(/\n/g, "\\n"),
    })!;
    expect(cfg.appId).toBe("77");
    expect(cfg.privateKey.reveal()).toContain("\n");
    expect(JSON.stringify(cfg)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(cfg)).not.toContain("whsec");
  });

  it("reads the key from a _FILE variable", () => {
    const cfg = loadGitHubAppConfigFromEnv(
      { ...base, AFE_GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/key" },
      (p) => (p === "/run/secrets/key" ? privatePem : ""),
    )!;
    expect(cfg.privateKey.reveal()).toBe(privatePem.trim() + "\n");
  });

  it("rejects partial config, bad ids and bad keys without echoing them", () => {
    expect(() => loadGitHubAppConfigFromEnv({ AFE_GITHUB_APP_ID: "77" })).toThrow(
      /missing: .*AFE_GITHUB_APP_PRIVATE_KEY/,
    );
    expect(() =>
      loadGitHubAppConfigFromEnv({
        ...base,
        AFE_GITHUB_APP_ID: "x",
        AFE_GITHUB_APP_PRIVATE_KEY: privatePem,
      }),
    ).toThrow(GitHubConfigError);
    let msg = "";
    try {
      loadGitHubAppConfigFromEnv({ ...base, AFE_GITHUB_APP_PRIVATE_KEY: "not-a-key-SECRET" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/not a valid PEM/);
    expect(msg).not.toContain("SECRET");
  });
});

describe("installation token cache", () => {
  const token = (value: string, expiresAt: number): InstallationToken => ({
    token: new Secret(value),
    expiresAt: new Date(expiresAt),
    permissions: {},
  });

  it("reuses a token until shortly before expiry, then mints a new one", async () => {
    let now = 0;
    let n = 0;
    const mint = vi.fn(async () => token(`t${++n}`, now + 60 * 60_000));
    const cache = new InstallationTokenCache(mint, { clock: () => now });
    expect((await cache.get({ installationId: 1 })).token.reveal()).toBe("t1");
    now += 50 * 60_000;
    expect((await cache.get({ installationId: 1 })).token.reveal()).toBe("t1");
    now += 6 * 60_000; // 4 minutes left < 5 minute margin
    expect((await cache.get({ installationId: 1 })).token.reveal()).toBe("t2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("shares one mint between concurrent callers and keys by tenant and permissions", async () => {
    const mint = vi.fn(async () => token("t", Date.now() + 3_600_000));
    const cache = new InstallationTokenCache(mint);
    await Promise.all([cache.get({ installationId: 1 }), cache.get({ installationId: 1 })]);
    expect(mint).toHaveBeenCalledTimes(1);
    await cache.get({ installationId: 1, tenantId: "other" });
    await cache.get({ installationId: 1, permissions: { actions: "read" } });
    expect(mint).toHaveBeenCalledTimes(3);
    cache.invalidate(1);
    expect(cache.size).toBe(0);
  });

  it("does not cache failures", async () => {
    let fail = true;
    const cache = new InstallationTokenCache(async () => {
      if (fail) throw new Error("boom");
      return token("ok", Date.now() + 3_600_000);
    });
    await expect(cache.get({ installationId: 2 })).rejects.toThrow("boom");
    fail = false;
    expect((await cache.get({ installationId: 2 })).token.reveal()).toBe("ok");
  });
});

describe("redirect state", () => {
  const key = deriveStateKey("instance-secret");

  it("round-trips with the browser nonce", () => {
    const nonce = newNonce();
    const state = signState(key, { purpose: "install", tenantId: "t1", nonce }, 1000);
    const r = verifyState(key, state, { purpose: "install", nonce }, 2000);
    expect(r.ok && r.payload.tenantId).toBe("t1");
  });

  it("rejects tampering, expiry, wrong purpose, missing or wrong nonce", () => {
    const nonce = newNonce();
    const state = signState(key, { purpose: "install", tenantId: "t1", nonce }, 0);
    const [body, mac] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString()),
        tenantId: "evil",
      }),
    ).toString("base64url");
    const check = (
      s: unknown,
      opts: { purpose?: "install" | "manifest"; nonce?: string; now?: number } = {},
    ) =>
      verifyState(
        key,
        s,
        { purpose: opts.purpose ?? "install", nonce: "nonce" in opts ? opts.nonce : nonce },
        opts.now ?? 1,
      );
    expect(check(`${forged}.${mac}`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(check("garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(check(undefined)).toEqual({ ok: false, reason: "malformed" });
    expect(check(state, { now: 16 * 60_000 })).toEqual({ ok: false, reason: "expired" });
    expect(check(state, { purpose: "manifest" })).toEqual({ ok: false, reason: "wrong_purpose" });
    expect(check(state, { nonce: undefined })).toEqual({ ok: false, reason: "nonce" });
    expect(check(state, { nonce: newNonce() })).toEqual({ ok: false, reason: "nonce" });
    expect(verifyState(deriveStateKey("other"), state, { purpose: "install", nonce }, 1).ok).toBe(
      false,
    );
  });
});
