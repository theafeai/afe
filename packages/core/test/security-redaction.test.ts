import { describe, expect, it } from "vitest";
import { inspect, format } from "node:util";
import {
  LOG_REDACT_OPTIONS,
  LOG_REDACT_PATHS,
  REDACTED,
  Secret,
  isSensitiveKey,
  redactDeep,
  redactHeaders,
  revealIfSecret,
} from "../src/index.ts";

describe("Secret", () => {
  const s = new Secret("hunter2");

  it("reveals only on request", () => {
    expect(s.reveal()).toBe("hunter2");
    expect(revealIfSecret(s)).toBe("hunter2");
    expect(revealIfSecret("plain")).toBe("plain");
  });

  it("never shows the value via toString, interpolation, JSON or inspect", () => {
    const renderings = [
      String(s),
      `${s}`,
      s + "",
      JSON.stringify(s),
      JSON.stringify({ token: s }),
      inspect(s),
      inspect({ nested: { s } }, { depth: 10 }),
      format("%s %o %O %j", s, s, s, s),
      Object.keys(s).join(","),
    ];
    for (const r of renderings) expect(r).not.toContain("hunter2");
    expect(JSON.stringify({ token: s })).toBe(`{"token":"${REDACTED}"}`);
  });
});

describe("redaction", () => {
  it("recognises sensitive keys regardless of case and separators", () => {
    for (const k of ["password", "Access_Token", "client-secret", "privateKey", "Authorization"]) {
      expect(isSensitiveKey(k)).toBe(true);
    }
    for (const k of ["tokenType", "credentialId", "name", "sha"]) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });

  it("redactDeep scrubs nested keys and Secrets without mutating input", () => {
    const input = {
      name: "conn",
      config: { url: "https://argocd.example", token: "abc", nested: [{ client_secret: "x" }] },
      wrapped: new Secret("y"),
      when: new Date(0),
    };
    const out = redactDeep(input, ["sessionId"]) as Record<string, unknown>;
    expect(out).toEqual({
      name: "conn",
      config: {
        url: "https://argocd.example",
        token: REDACTED,
        nested: [{ client_secret: REDACTED }],
      },
      wrapped: REDACTED,
      when: new Date(0),
    });
    expect(input.config.token).toBe("abc");
    expect(redactDeep({ sessionId: "s" }, ["session_id"])).toEqual({ sessionId: REDACTED });
  });

  it("redactDeep handles cycles", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(redactDeep(a)).toEqual({ x: 1, self: "[Circular]" });
  });

  it("redactHeaders hides auth and signature headers", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer t",
        "x-hub-signature-256": "sha256=abc",
        "x-github-delivery": "d1",
        cookie: undefined,
      }),
    ).toEqual({
      Authorization: REDACTED,
      "x-hub-signature-256": REDACTED,
      "x-github-delivery": "d1",
      cookie: undefined,
    });
  });

  it("exposes pino redact paths for auth and signature headers", () => {
    expect(LOG_REDACT_PATHS).toContain('req.headers["authorization"]');
    expect(LOG_REDACT_PATHS).toContain('req.headers["x-hub-signature-256"]');
    expect(LOG_REDACT_PATHS).toContain('req.headers["x-vercel-signature"]');
    expect(LOG_REDACT_PATHS).toContain("*.token");
    expect(LOG_REDACT_OPTIONS.censor).toBe(REDACTED);
  });
});
