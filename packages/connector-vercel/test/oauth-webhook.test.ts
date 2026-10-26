import { describe, expect, it } from "vitest";
import { Secret, signHmac } from "@afe/core/security";
import {
  buildInstallUrl,
  deriveStateKey,
  exchangeOAuthCode,
  signState,
  verifyState,
  verifyVercelWebhook,
} from "../src/index.ts";
import { FakeVercelApi } from "../src/testing.ts";

describe("OAuth", () => {
  it("builds the install URL", () => {
    expect(buildInstallUrl("afe-audit", "s.1")).toBe(
      "https://vercel.com/integrations/afe-audit/new?state=s.1",
    );
    expect(() => buildInstallUrl("../evil", "s")).toThrow();
  });

  it("exchanges a code for a token", async () => {
    const api = new FakeVercelApi();
    api.oauthCodes.set("c1", {
      code: "c1",
      token: "oauth-tok",
      configurationId: "icfg_1",
      userId: "usr_1",
      teamId: "team_1",
      redirectUri: "https://afe.example/cb",
    });
    const result = await exchangeOAuthCode({
      clientId: api.clientId,
      clientSecret: new Secret(api.clientSecret),
      code: "c1",
      redirectUri: "https://afe.example/cb",
      fetch: api.fetch,
    });
    expect(result.accessToken.reveal()).toBe("oauth-tok");
    expect(String(result.accessToken)).toBe("[REDACTED]");
    expect(result).toMatchObject({ configurationId: "icfg_1", userId: "usr_1", teamId: "team_1" });
    // codes are single use
    await expect(
      exchangeOAuthCode({
        clientId: api.clientId,
        clientSecret: new Secret(api.clientSecret),
        code: "c1",
        redirectUri: "https://afe.example/cb",
        fetch: api.fetch,
      }),
    ).rejects.toThrow(/400/);
  });

  it("signs and verifies state; rejects tampering and expiry", () => {
    const key = deriveStateKey(new Secret("client-secret"));
    const now = 1_000_000;
    const state = signState({ tenantId: "t1", nonce: "n", expiresAt: now + 1000 }, key);
    expect(verifyState(state, key, now)).toEqual({
      tenantId: "t1",
      nonce: "n",
      expiresAt: now + 1000,
    });
    expect(verifyState(state, key, now + 2000)).toBeNull();
    expect(verifyState(state, deriveStateKey(new Secret("other")), now)).toBeNull();
    const [body, sig] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ tenantId: "t2", nonce: "n", expiresAt: now + 1000 }),
    ).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, key, now)).toBeNull();
    expect(verifyState(`${body}`, key, now)).toBeNull();
    expect(verifyState(undefined, key, now)).toBeNull();
  });
});

describe("verifyVercelWebhook", () => {
  const secret = new Secret("whsec");
  const now = 1_700_000_000_000;
  const body = JSON.stringify({
    id: "evt_1",
    type: "deployment.created",
    createdAt: now,
    payload: {
      team: { id: "team_1" },
      user: { id: "usr_1" },
      project: { id: "prj_1" },
      deployment: { id: "dpl_1", meta: {} },
      env: { SECRET: "x" },
    },
  });

  it("accepts a valid signature and parses ids", () => {
    const res = verifyVercelWebhook({
      rawBody: Buffer.from(body),
      signature: signHmac("sha1", "whsec", body),
      secret,
      now,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.event).toMatchObject({
      id: "evt_1",
      type: "deployment.created",
      teamId: "team_1",
      userId: "usr_1",
      projectId: "prj_1",
    });
    expect(res.event.payload.env).toBeUndefined();
  });

  it("rejects missing, wrong, duplicated or re-serialised signatures", () => {
    const sig = signHmac("sha1", "whsec", body);
    for (const signature of [undefined, "", "00".repeat(20), [sig, sig], `sha1=${sig}`]) {
      const res = verifyVercelWebhook({ rawBody: Buffer.from(body), signature, secret, now });
      expect(res).toEqual({ ok: false, reason: "bad_signature" });
    }
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body), null, 1));
    expect(verifyVercelWebhook({ rawBody: reserialised, signature: sig, secret, now }).ok).toBe(
      false,
    );
  });

  it("rejects stale deliveries", () => {
    const res = verifyVercelWebhook({
      rawBody: Buffer.from(body),
      signature: signHmac("sha1", "whsec", body),
      secret,
      now: now + 10 * 60 * 1000,
    });
    expect(res).toEqual({ ok: false, reason: "stale" });
  });

  it("supports the legacy payload shape", () => {
    const legacy = JSON.stringify({
      id: "evt_2",
      type: "integration-configuration.removed",
      createdAt: now,
      payload: { teamId: "team_1", userId: "usr_1", configurationId: "icfg_1" },
    });
    const res = verifyVercelWebhook({
      rawBody: Buffer.from(legacy),
      signature: signHmac("sha1", "whsec", legacy),
      secret,
      now,
    });
    expect(res.ok && res.event).toMatchObject({ teamId: "team_1", configurationId: "icfg_1" });
  });
});
