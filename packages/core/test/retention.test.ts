import { describe, expect, it } from "vitest";
import {
  clampLookbackMs,
  clampToRetention,
  createMemoryEventSink,
  DEFAULT_RETENTION_DAYS,
  FixedWindowRetention,
  isOutsideRetention,
  MAX_RETENTION_DAYS,
  retentionPolicyFromEnv,
  sha256Hex,
} from "../src/index.ts";
import { deploymentInput } from "./fixtures.ts";

const DAY = 24 * 3600_000;
const NOW = new Date("2026-10-27T12:00:00.000Z");

describe("FixedWindowRetention", () => {
  it("defaults to 30 days and cuts off by occurredAt", () => {
    const p = new FixedWindowRetention();
    expect(p.days).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(p.maxWindowMs).toBe(30 * DAY);
    expect(p.cutoff("default", NOW).toISOString()).toBe("2026-09-27T12:00:00.000Z");
  });

  it("accepts 1..60 days only (60 is the open-source maximum)", () => {
    expect(MAX_RETENTION_DAYS).toBe(60);
    expect(new FixedWindowRetention(1).days).toBe(1);
    expect(new FixedWindowRetention(60).days).toBe(60);
    for (const bad of [0, 61, 90, 1.5, -1, Number.NaN]) {
      expect(() => new FixedWindowRetention(bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe("retentionPolicyFromEnv (AFE_EVENT_RETENTION_DAYS)", () => {
  it("defaults to 30 days when unset or empty", () => {
    expect(retentionPolicyFromEnv({}).days).toBe(30);
    expect(retentionPolicyFromEnv({ AFE_EVENT_RETENTION_DAYS: "" }).days).toBe(30);
  });

  it("reads whole days from 1 to 60", () => {
    expect(retentionPolicyFromEnv({ AFE_EVENT_RETENTION_DAYS: "1" }).days).toBe(1);
    expect(retentionPolicyFromEnv({ AFE_EVENT_RETENTION_DAYS: " 60 " }).days).toBe(60);
  });

  it("refuses values outside 1..60 with a clear error (no silent clamping)", () => {
    for (const bad of ["0", "61", "90", "365", "7d", "-5", "1.5", "abc"]) {
      expect(() => retentionPolicyFromEnv({ AFE_EVENT_RETENTION_DAYS: bad }), bad).toThrow(
        /AFE_EVENT_RETENTION_DAYS must be a whole number of days from 1 to 60/,
      );
    }
  });
});

describe("retention helpers", () => {
  const cutoff = new Date(NOW.getTime() - 30 * DAY);

  it("isOutsideRetention compares occurredAt with the cutoff", () => {
    expect(isOutsideRetention(new Date(cutoff.getTime() - 1), cutoff)).toBe(true);
    expect(isOutsideRetention(cutoff, cutoff)).toBe(false);
    expect(isOutsideRetention(NOW.toISOString(), cutoff)).toBe(false);
    expect(isOutsideRetention("2000-01-01T00:00:00Z", null)).toBe(false);
  });

  it("clampToRetention moves a window start up to the cutoff", () => {
    const old = new Date(NOW.getTime() - 90 * DAY);
    expect(clampToRetention(old, cutoff)).toEqual(cutoff);
    expect(clampToRetention(NOW, cutoff)).toBe(NOW);
    expect(clampToRetention(old, null)).toBe(old);
  });

  it("clampLookbackMs limits lookbacks to the longest window", () => {
    const p = new FixedWindowRetention(14);
    expect(clampLookbackMs(30 * DAY, p)).toEqual({ ms: 14 * DAY, clamped: true });
    expect(clampLookbackMs(DAY, p)).toEqual({ ms: DAY, clamped: false });
    expect(clampLookbackMs(1e15, { maxWindowMs: null })).toEqual({ ms: 1e15, clamped: false });
  });
});

describe("memory sink with retention", () => {
  it("drops events outside the window and stores the rest", async () => {
    const sink = createMemoryEventSink({
      retention: new FixedWindowRetention(30),
      now: () => NOW,
    });
    const old = await sink.ingest("t", {
      ...deploymentInput(),
      sourceEventId: "old",
      occurredAt: new Date(NOW.getTime() - 31 * DAY),
    });
    expect(old).toEqual({ status: "expired", inserted: false, event: null });
    const fresh = await sink.ingest("t", {
      ...deploymentInput(),
      sourceEventId: "fresh",
      occurredAt: new Date(NOW.getTime() - DAY),
    });
    expect(fresh.status).toBe("inserted");
    expect(fresh.event?.seq).toBe(1);
    expect(sink.events("t").map((e) => e.sourceEventId)).toEqual(["fresh"]);
  });

  it("is idempotent and keeps raw payload bytes and their sha256", async () => {
    const sink = createMemoryEventSink();
    const input = deploymentInput();
    const first = await sink.ingest("t", input);
    const again = await sink.ingest("t", input);
    expect(first.status).toBe("inserted");
    expect(again).toMatchObject({ status: "duplicate", inserted: false });
    expect(again.event).toEqual(first.event);
    const ref = first.event!.rawPayload!;
    const raw = sink.rawPayloads.get(ref.id)!;
    expect(sha256Hex(raw.body)).toBe(ref.sha256);
    expect(first.event).not.toHaveProperty("hash");
    expect(first.event).not.toHaveProperty("prevHash");
  });
});
