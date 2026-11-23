/**
 * M1, P4: per-user access cache and access-scoped snapshot keying. These tests
 * use an in-memory stand-in for the two SQL statements of the cache, so they run
 * without Postgres; the database behaviour is covered in access-cache-db.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { FastifyRequest } from "fastify";
import type { EventAccessRule } from "@afe/core";
import {
  ACCESS_CACHE_TTL_MS,
  AccessCache,
  accessFingerprint,
  canonicalRules,
} from "../src/auth/access-cache.ts";
import { requestEventAccess } from "../src/auth/permissions.ts";
import * as toolAccess from "../src/auth/tool-accounts.ts";
import type { ServerContext } from "../src/context.ts";
import { ScopedSnapshotCache } from "../src/correlation/scoped-cache.ts";

const CRED = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const repo = (r: string): EventAccessRule => ({ source: "github", resource: `repository:${r}` });

/** Rows of user_source_access and the policy table, answering only the queries used here. */
function fakePool(policyMode = "source") {
  const rows = new Map<string, { credential: string; rules: unknown; fetchedAt: Date }>();
  const deletes: unknown[][] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      const key = `${params[0]}|${params[1]}|${params[2]}`;
      if (sql.includes("FROM user_source_access") && sql.trim().startsWith("SELECT")) {
        const r = rows.get(key);
        return {
          rows:
            r && r.credential === params[3] ? [{ rules: r.rules, fetched_at: r.fetchedAt }] : [],
        };
      }
      if (sql.includes("INSERT INTO user_source_access")) {
        rows.set(key, {
          credential: String(params[3]),
          rules: JSON.parse(String(params[4])),
          fetchedAt: params[5] as Date,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM user_source_access")) {
        deletes.push(params);
        for (const k of [...rows.keys()])
          if (k.startsWith(`${params[0]}|${params[1]}|`) && (!params[2] || k === key))
            rows.delete(k);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM user_tool_permissions"))
        return { rows: [{ mode: policyMode, custom: [], denied: [] }] };
      if (sql.includes("FROM user_external_identities"))
        return {
          rows: [
            { userId: USER, provider: "github", subject: "1", login: "a", provisioned: false },
          ],
        };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  return { pool: pool as unknown as pg.Pool, rows, deletes };
}

function request(tenantId = "default", userId = USER): FastifyRequest {
  return {
    tenantId,
    principal: {
      id: `local:${userId}`,
      tenantId,
      roles: ["viewer"],
      kind: "local",
      localUserId: userId,
    },
  } as unknown as FastifyRequest;
}

function context(pool: pg.Pool, access: AccessCache): ServerContext {
  return { pool, access, log: { info() {}, warn() {} } } as unknown as ServerContext;
}

afterEach(() => vi.restoreAllMocks());

describe("fingerprints", () => {
  it("are order independent and de-duplicated", () => {
    const a = [repo("acme/b"), repo("acme/a"), repo("acme/a")];
    const b = [repo("acme/a"), repo("acme/b")];
    expect(canonicalRules(a)).toEqual(canonicalRules(b));
    expect(accessFingerprint(a)).toBe(accessFingerprint(b));
    expect(accessFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(accessFingerprint([repo("acme/a")])).not.toBe(accessFingerprint(b));
    expect(accessFingerprint([])).not.toBe(accessFingerprint([repo("acme/a")]));
  });
});

describe("AccessCache", () => {
  it("serves a row only within the 5-minute TTL (hard limit) and only for the same credential", async () => {
    let now = 1_000_000;
    const { pool } = fakePool();
    const cache = new AccessCache(pool, { now: () => now });
    expect(cache.ttlMs).toBe(ACCESS_CACHE_TTL_MS);
    await cache.refresh("default", USER, "github", CRED, async () => [repo("acme/a")]);
    expect(await cache.read("default", USER, "github", CRED)).toEqual([repo("acme/a")]);
    expect(
      await cache.read("default", USER, "github", "33333333-3333-4333-8333-333333333333"),
    ).toBe(null);
    now += ACCESS_CACHE_TTL_MS - 1;
    expect(await cache.read("default", USER, "github", CRED)).toEqual([repo("acme/a")]);
    now += 1;
    expect(await cache.read("default", USER, "github", CRED)).toBe(null);
    // A row from the future (clock skew) is not trusted.
    now -= ACCESS_CACHE_TTL_MS + 120_000;
    expect(await cache.read("default", USER, "github", CRED)).toBe(null);
  });

  it("never caches tools other than GitHub and clamps the TTL to five minutes", async () => {
    const { pool } = fakePool();
    expect(new AccessCache(pool, { ttlMs: 60 * 60_000 }).ttlMs).toBe(ACCESS_CACHE_TTL_MS);
    const cache = new AccessCache(pool);
    await cache.refresh("default", USER, "vercel", CRED, async () => [
      { source: "vercel", resource: "project:x" },
    ]);
    expect(await cache.read("default", USER, "vercel", CRED)).toBe(null);
  });

  it("a failed refresh deletes the row and rethrows (deny, no grace period)", async () => {
    let now = 0;
    const { pool, rows } = fakePool();
    const cache = new AccessCache(pool, { now: () => now });
    await cache.refresh("default", USER, "github", CRED, async () => [repo("acme/a")]);
    now = ACCESS_CACHE_TTL_MS;
    await expect(
      cache.refresh("default", USER, "github", CRED, async () => {
        throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(rows.size).toBe(0);
  });

  it("runs one refresh at a time per user and credential", async () => {
    const { pool } = fakePool();
    const cache = new AccessCache(pool);
    let calls = 0;
    const fetch = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return [repo("acme/a")];
    };
    await Promise.all([1, 2, 3].map(() => cache.refresh("default", USER, "github", CRED, fetch)));
    expect(calls).toBe(1);
  });

  it("invalidation deletes the user's rows and drops their snapshot fingerprint", async () => {
    const { pool, rows } = fakePool();
    const cache = new AccessCache(pool);
    const dropped: [string, string][] = [];
    cache.onInvalidate((t, fp) => dropped.push([t, fp]));
    await cache.refresh("default", USER, "github", CRED, async () => [repo("acme/a")]);
    cache.noteFingerprint("default", USER, accessFingerprint([repo("acme/a")]));
    await cache.invalidate(pool, "default", USER);
    expect(rows.size).toBe(0);
    expect(dropped).toEqual([["default", accessFingerprint([repo("acme/a")])]]);
  });
});

describe("requestEventAccess (P4 fail closed)", () => {
  const account = {
    tool: "github",
    account_name: "alice",
    credential_id: CRED,
    context: {},
  } as toolAccess.ToolAccount;

  it("a cache miss with a failing refresh denies all: [] and never undefined", async () => {
    const { pool } = fakePool();
    const access = new AccessCache(pool);
    vi.spyOn(toolAccess, "toolAccounts").mockResolvedValue([account]);
    vi.spyOn(toolAccess, "sourceAccess").mockRejectedValue(new Error("network"));
    const rules = await requestEventAccess(pool, request(), context(pool, access));
    expect(rules).toEqual([]);
  });

  it("reads use the cache; live checks (actions, logs) always go upstream", async () => {
    const { pool } = fakePool();
    const access = new AccessCache(pool);
    vi.spyOn(toolAccess, "toolAccounts").mockResolvedValue([account]);
    const upstream = vi.spyOn(toolAccess, "sourceAccess").mockResolvedValue([repo("acme/a")]);
    const ctx = context(pool, access);
    expect(await requestEventAccess(pool, request(), ctx)).toEqual([repo("acme/a")]);
    upstream.mockResolvedValue([]);
    // Revoked upstream: read views keep the cached rules within the TTL...
    expect(await requestEventAccess(pool, request(), ctx)).toEqual([repo("acme/a")]);
    expect(upstream).toHaveBeenCalledTimes(1);
    // ...but a live check sees the revocation at once.
    expect(await requestEventAccess(pool, request(), ctx, { live: true })).toEqual([]);
    expect(upstream).toHaveBeenCalledTimes(2);
    // And the live refresh replaced the cached rules for later reads.
    expect(await requestEventAccess(pool, request(), ctx)).toEqual([]);
  });

  it("a policy other than source grants nothing even with a cached row", async () => {
    const { pool } = fakePool("none");
    const access = new AccessCache(pool);
    await access.refresh("default", USER, "github", CRED, async () => [repo("acme/a")]);
    vi.spyOn(toolAccess, "toolAccounts").mockResolvedValue([account]);
    const upstream = vi.spyOn(toolAccess, "sourceAccess");
    expect(await requestEventAccess(pool, request(), context(pool, access))).toEqual([]);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("unrestricted principals stay undefined; managed users without accounts get []", async () => {
    const { pool } = fakePool();
    vi.spyOn(toolAccess, "toolAccounts").mockResolvedValue([]);
    const admin = { tenantId: "default", principal: { id: "a", roles: ["admin"] } };
    expect(await requestEventAccess(pool, admin as unknown as FastifyRequest)).toBeUndefined();
    expect(await requestEventAccess(pool, request(), context(pool, new AccessCache(pool)))).toEqual(
      [],
    );
  });
});

describe("ScopedSnapshotCache keying and limits", () => {
  const entry = (events: number, computedAt = 0) => ({
    value: { events },
    events,
    latestSeq: 1,
    cutoff: null,
    oldest: null,
    computedAt,
  });
  const fpA = accessFingerprint([repo("acme/a")]);
  const fpB = accessFingerprint([repo("acme/b")]);

  it("users with different rules never share an entry; equal rules in another tenant never do", () => {
    const cache = new ScopedSnapshotCache<{ events: number }>({ ttlMs: 1000, now: () => 0 });
    expect(cache.set("t1", fpA, entry(1))).toBe(true);
    expect(cache.get("t1", fpB)).toBeUndefined();
    expect(cache.get("t2", fpA)).toBeUndefined();
    cache.set("t2", fpA, entry(2));
    expect(cache.get("t1", fpA)!.events).toBe(1);
    expect(cache.get("t2", fpA)!.events).toBe(2);
  });

  it("never serves an entry at or past its TTL", () => {
    let now = 0;
    const cache = new ScopedSnapshotCache<{ events: number }>({ ttlMs: 1000, now: () => now });
    cache.set("t1", fpA, entry(1, 0));
    now = 999;
    expect(cache.get("t1", fpA)).toBeDefined();
    now = 1000;
    expect(cache.get("t1", fpA)).toBeUndefined();
  });

  it("a tenant at its own bound evicts only its own entries", () => {
    const cache = new ScopedSnapshotCache<{ events: number }>({
      ttlMs: 1000,
      now: () => 0,
      maxEntriesPerTenant: 2,
    });
    cache.set("victim", fpA, entry(1));
    for (let i = 0; i < 10; i++) cache.set("noisy", accessFingerprint([repo(`x/${i}`)]), entry(1));
    expect(cache.size("noisy")).toBe(2);
    expect(cache.get("victim", fpA)).toBeDefined();
  });

  it("above the total bound it computes without caching instead of evicting another tenant", () => {
    const cache = new ScopedSnapshotCache<{ events: number }>({
      ttlMs: 1000,
      now: () => 0,
      maxEventsPerTenant: 100,
      maxEventsTotal: 150,
    });
    expect(cache.set("victim", fpA, entry(100))).toBe(true);
    expect(cache.set("noisy", fpA, entry(80))).toBe(false);
    expect(cache.get("victim", fpA)).toBeDefined();
    expect(cache.set("noisy", fpB, entry(101))).toBe(false);
    expect(cache.totalEvents).toBe(100);
  });
});

describe("streamAccessGuard (P4 condition 8)", () => {
  async function guardFor(opts: { disabled?: boolean; expiresAt?: number; now: () => number }) {
    const { streamAccessGuard } = await import("../src/auth/access-stream.ts");
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("FROM users"))
          return {
            rows: [
              {
                id: USER,
                username: "a",
                email: null,
                disabled: !!opts.disabled,
                credentialVersion: 1,
              },
            ],
          };
        if (sql.includes("FROM user_tool_accounts")) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as pg.Pool;
    const req = request();
    req.principal!.credentialVersion = 1;
    if (opts.expiresAt !== undefined) req.webSession = { expiresAt: opts.expiresAt, via: "local" };
    const ctx = {
      pool,
      access: new AccessCache(pool, { now: opts.now }),
      auth: { authenticate: () => null },
      log: { info() {} },
    } as unknown as ServerContext;
    return streamAccessGuard(req, ctx);
  }

  it("keeps an active stream open with the current rules", async () => {
    const guard = await guardFor({ now: () => 0, expiresAt: 10 });
    expect(await guard.check()).toEqual([]);
  });

  it("closes when the session expires", async () => {
    let now = 0;
    const guard = await guardFor({ now: () => now, expiresAt: 10 });
    now = 10;
    expect(await guard.check()).toBeNull();
  });

  it("closes when the user is disabled", async () => {
    const guard = await guardFor({ now: () => 0, disabled: true });
    expect(await guard.check()).toBeNull();
  });
});
