import { describe, expect, it } from "vitest";
import {
  AuthConfigError,
  bearerToken,
  constantTimeEqual,
  denyAllAuthProvider,
  hasRole,
  principalTenantResolver,
  StaticTokenAuthProvider,
} from "../src/index.ts";

const ADMIN = "a".repeat(32);
const VIEWER = "v".repeat(40);
const req = (authorization?: string) => ({
  headers: authorization ? { authorization } : {},
  cookies: {},
});

describe("StaticTokenAuthProvider", () => {
  const auth = new StaticTokenAuthProvider({ adminToken: ADMIN, viewerToken: VIEWER });

  it("maps the admin and viewer tokens to principals of the default tenant", () => {
    const admin = auth.authenticate(req(`Bearer ${ADMIN}`));
    expect(admin).toMatchObject({ tenantId: "default", roles: ["admin"], kind: "token" });
    expect(admin!.id).not.toContain(ADMIN);
    expect(auth.authenticate(req(`bearer  ${VIEWER}`))).toMatchObject({ roles: ["viewer"] });
    expect(hasRole(admin!, "viewer")).toBe(true);
    expect(hasRole(auth.authenticate(req(`Bearer ${VIEWER}`))!, "admin")).toBe(false);
  });

  it("rejects anything else", () => {
    for (const h of [
      undefined,
      ADMIN,
      `Bearer ${ADMIN}x`,
      `Bearer ${ADMIN.slice(1)}`,
      `Basic ${ADMIN}`,
      "Bearer ",
    ]) {
      expect(auth.authenticate(req(h)), String(h)).toBeNull();
    }
    expect(denyAllAuthProvider.authenticate(req(`Bearer ${ADMIN}`))).toBeNull();
  });

  it("enforces token length and distinct tokens", () => {
    expect(() => new StaticTokenAuthProvider({ adminToken: "short" })).toThrow(AuthConfigError);
    expect(() => new StaticTokenAuthProvider({ adminToken: ADMIN, viewerToken: ADMIN })).toThrow(
      /must differ/,
    );
    expect(() => new StaticTokenAuthProvider({ adminToken: `${ADMIN} x` })).toThrow(/whitespace/);
  });

  it("treats principals of rotated tokens as inactive", () => {
    const p = auth.authenticate(req(`Bearer ${ADMIN}`))!;
    expect(auth.isActive(p)).toBe(true);
    const rotated = new StaticTokenAuthProvider({ adminToken: "b".repeat(32) });
    expect(rotated.isActive(p)).toBe(false);
  });
});

describe("helpers", () => {
  it("parses bearer tokens and compares in constant time", () => {
    expect(bearerToken({ authorization: "Bearer abc" })).toBe("abc");
    expect(bearerToken({ authorization: ["Bearer abc"] })).toBeNull();
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("resolves the tenant from the principal only", () => {
    expect(
      principalTenantResolver.resolveTenant({
        headers: { "x-tenant": "evil" },
        principal: { id: "x", tenantId: "t1", roles: ["viewer"], kind: "token" },
      }),
    ).toBe("t1");
    expect(() => principalTenantResolver.resolveTenant({ headers: {} })).toThrow();
  });
});
