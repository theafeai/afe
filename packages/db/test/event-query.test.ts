import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  eventMatchesFilter,
  normaliseEventFilter,
  type CanonicalEvent,
  type CanonicalEventInputLike,
  type EventFilterInput,
} from "@afe/core";
import {
  getLatestSeq,
  getRawPayload,
  ingestEvent,
  InvalidCursorError,
  listEvents,
  purgeEventsBefore,
  queryEvents,
  type EventOrder,
} from "../src/index.ts";
import { createTestPool } from "../src/testing.ts";

const SHAS = ["a".repeat(40), "b".repeat(40), "abcdef1".padEnd(40, "0")];
const ACTIONS = [
  "deployment.created",
  "deployment.status_updated",
  "workflow_run.completed",
  "argocd.sync.succeeded",
  "deployment.review_approved",
];
const SOURCES = ["github", "vercel", "argocd"];
const ENVS = ["Production", "staging", "preview"];
const METHODS = ["webhook", "poll", "reconciliation"] as const;
const TRIGGERS = ["push", "manual", "auto_sync", "api"] as const;
const OUTCOMES = ["succeeded", "failed", "pending"] as const;
const LOGINS = ["octocat", "Alice", "deploy-bot"];

export function seedInput(n: number, minute = n): CanonicalEventInputLike {
  const pick = <T>(xs: readonly T[], k = 1) => xs[(n * k) % xs.length]!;
  const env = pick(ENVS, 7);
  return {
    source: pick(SOURCES),
    sourceEventId: `obj:${n}`,
    connectionId: `conn_${n % 2}`,
    action: pick(ACTIONS, 3),
    actor: {
      type: n % 5 === 0 ? "bot" : "user",
      id: String(1000 + (n % 4)),
      login: pick(LOGINS, 5),
      onBehalfOf: n % 4 === 0 ? { type: "user", login: "Alice" } : null,
    },
    target: {
      type: "environment",
      id: `acme/api:${env}`,
      name: env,
      environment: n % 6 === 0 ? undefined : env,
      repository: n % 3 === 0 ? "https://github.com/Acme/API.git" : "acme/web",
      application: n % 4 === 1 ? "payments" : undefined,
      ref: n % 2 ? "refs/heads/main" : "refs/tags/v1.0.0",
    },
    trigger: { type: pick(TRIGGERS, 11) },
    outcome: pick(OUTCOMES, 13),
    // Several events share an occurredAt to exercise the seq tie-break.
    occurredAt: new Date(Date.UTC(2026, 9, 1, 10, Math.floor(minute / 2))),
    observedAt: new Date(Date.UTC(2026, 9, 1, 11)),
    observation: { method: pick(METHODS, 17) },
    correlation: {
      commitShas: [pick(SHAS, 19)],
      environments: n % 6 === 0 ? [env] : undefined,
      deploymentIds: [`github:${n}`],
    },
    data: {},
    rawPayload: { contentType: "application/json", body: `{"n":${n}}` },
  };
}

async function allEvents(pool: pg.Pool, tenant: string): Promise<CanonicalEvent[]> {
  return (await listEvents(pool, tenant, { limit: 1000 })).events;
}

function sortBy(events: CanonicalEvent[], order: EventOrder) {
  const s = [...events].sort((a, b) =>
    a.occurredAt === b.occurredAt ? a.seq - b.seq : a.occurredAt < b.occurredAt ? -1 : 1,
  );
  return order === "desc" ? s.reverse() : s;
}

async function pageAll(
  pool: pg.Pool,
  tenant: string,
  filterInput: EventFilterInput,
  order: EventOrder,
  limit: number,
  between?: (page: number) => Promise<void>,
) {
  const filter = normaliseEventFilter(filterInput);
  const out: CanonicalEvent[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const res = await queryEvents(pool, tenant, { filter, order, limit, cursor });
    out.push(...res.events);
    cursor = res.nextCursor;
    if (between) await between(page);
    page += 1;
  } while (cursor);
  return out;
}

describe("event query", () => {
  let pool: pg.Pool;
  const tenant = "q1";
  const other = "q2";
  let seeded: CanonicalEvent[];

  beforeAll(async () => {
    pool = await createTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1), ($2, $2)", [tenant, other]);
    for (let n = 1; n <= 40; n++) await ingestEvent(pool, tenant, seedInput(n));
    for (let n = 1; n <= 5; n++) await ingestEvent(pool, other, seedInput(n));
    seeded = await allEvents(pool, tenant);
  });
  afterAll(async () => {
    await pool.end();
  });

  const FILTERS: EventFilterInput[] = [
    {},
    { sources: "github" },
    { sources: ["github", "argocd"], outcomes: "failed" },
    { actions: "deployment.*" },
    { actions: ["deployment.*", "argocd.sync.*"], environments: "PRODUCTION" },
    { actions: "deployment.created" },
    { actors: "alice" },
    { actorLogins: "OCTOCAT", triggerTypes: ["manual", "push"] },
    { actorIds: "1001", actorTypes: "user" },
    { environments: "production" },
    { repositories: "acme/api" },
    { repositories: "github.com/acme/api" },
    { applications: "payments", observationMethods: "reconciliation" },
    { refs: "main" },
    { refs: "v1.0.0", connectionIds: "conn_0" },
    { commitShas: "abcdef1" },
    { commitShas: "A".repeat(40) },
    { deploymentIds: ["github:3", "github:4"] },
    { targetNames: "staging", outcomes: ["succeeded", "pending"] },
    { occurredFrom: "2026-10-01T10:05:00Z", occurredTo: "2026-10-01T10:12:00Z" },
    { seqFrom: 5, seqTo: 9 },
    { sourceEventIds: "obj:7" },
    { observationMethods: "reconciliation", sources: "vercel", actions: "deployment.*" },
  ];

  it.each(FILTERS.map((f) => [JSON.stringify(f), f] as const))(
    "SQL selects exactly what eventMatchesFilter selects: %s",
    async (_name, input) => {
      const filter = normaliseEventFilter(input);
      const expected = sortBy(
        seeded.filter((e) => eventMatchesFilter(e, filter)),
        "desc",
      ).map((e) => e.seq);
      const res = await queryEvents(pool, tenant, { filter, limit: 1000 });
      expect(res.events.map((e) => e.seq)).toEqual(expected);
      expect(res.nextCursor).toBeNull();
    },
  );

  it("filter set is not trivial", () => {
    const counts = FILTERS.map(
      (f) => seeded.filter((e) => eventMatchesFilter(e, normaliseEventFilter(f))).length,
    );
    expect(counts.filter((c) => c > 0 && c < seeded.length).length).toBeGreaterThan(15);
  });

  it.each(["asc", "desc"] as const)(
    "paginates in %s order without gaps or duplicates",
    async (order) => {
      const paged = await pageAll(pool, tenant, { actions: "deployment.*" }, order, 3);
      const expected = sortBy(
        seeded.filter((e) => e.action.startsWith("deployment.")),
        order,
      );
      expect(paged.map((e) => e.seq)).toEqual(expected.map((e) => e.seq));
    },
  );

  it("pages are stable under concurrent inserts", async () => {
    const t = "q3";
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1)", [t]);
    for (let n = 1; n <= 20; n++) await ingestEvent(pool, t, seedInput(n));
    const before = await allEvents(pool, t);
    let extra = 100;
    const paged = await pageAll(pool, t, {}, "desc", 4, async () => {
      // Late arrivals: older, newer and same-time occurredAt as the page boundary.
      for (const minute of [0, 15, 60]) await ingestEvent(pool, t, seedInput(extra++, minute));
    });
    expect(paged.map((e) => e.seq)).toEqual(sortBy(before, "desc").map((e) => e.seq));
    expect(new Set(paged.map((e) => e.id)).size).toBe(paged.length);
    // A new traversal sees the new events.
    expect((await pageAll(pool, t, {}, "desc", 50)).length).toBe(20 + (extra - 100));
  });

  it("rejects cursors from another query and garbage cursors", async () => {
    const res = await queryEvents(pool, tenant, { limit: 2 });
    expect(res.nextCursor).toBeTruthy();
    await expect(
      queryEvents(pool, tenant, { limit: 2, order: "asc", cursor: res.nextCursor }),
    ).rejects.toThrow(InvalidCursorError);
    await expect(
      queryEvents(pool, tenant, {
        limit: 2,
        filter: normaliseEventFilter({ sources: "github" }),
        cursor: res.nextCursor,
      }),
    ).rejects.toThrow(InvalidCursorError);
    await expect(queryEvents(pool, tenant, { cursor: "!!!" })).rejects.toThrow(InvalidCursorError);
    const forged = Buffer.from(JSON.stringify({ v: 1, o: "x", s: 1, h: 1, k: "k" })).toString(
      "base64url",
    );
    await expect(queryEvents(pool, tenant, { cursor: forged })).rejects.toThrow(InvalidCursorError);
  });

  it("is tenant-scoped", async () => {
    const res = await queryEvents(pool, other, { limit: 1000 });
    expect(res.events).toHaveLength(5);
    expect(res.events.every((e) => e.tenantId === other)).toBe(true);
    const own = seeded[0]!;
    expect(await getRawPayload(pool, other, own.rawPayload!.id)).toBeNull();
    const raw = await getRawPayload(pool, tenant, own.rawPayload!.id);
    expect(raw!.sha256).toBe(own.rawPayload!.sha256);
    expect((await queryEvents(pool, "nobody", {})).events).toEqual([]);
    expect(await getLatestSeq(pool, "nobody")).toBe(0);
  });

  it("a traversal keeps working when retention purges events between pages", async () => {
    const t = "q4";
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, $1)", [t]);
    for (let n = 1; n <= 12; n++) await ingestEvent(pool, t, seedInput(n));
    const all = sortBy(await allEvents(pool, t), "asc");
    const first = await queryEvents(pool, t, { order: "asc", limit: 4 });
    expect(first.snapshotSeq).toBe(12);
    // Purge the 6 oldest events (by occurredAt) while the client is paging.
    const cutoff = new Date(all[6]!.occurredAt);
    const purged = await purgeEventsBefore(pool, t, cutoff);
    const expectedRest = all.slice(4).filter((e) => e.occurredAt >= all[6]!.occurredAt);
    expect(purged.events).toBe(all.filter((e) => e.occurredAt < all[6]!.occurredAt).length);
    const rest: CanonicalEvent[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await queryEvents(pool, t, { order: "asc", limit: 4, cursor });
      expect(page.snapshotSeq).toBe(12);
      rest.push(...page.events);
      cursor = page.nextCursor;
    }
    expect(rest.map((e) => e.seq)).toEqual(expectedRest.map((e) => e.seq));
    expect(await getLatestSeq(pool, t)).toBe(12);
  });
});
