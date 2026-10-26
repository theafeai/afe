import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  EventValidationError,
  isKnownAction,
  isObservationGapEvent,
  observationGapClosed,
  observationGapOpened,
  parseEventInput,
  repositoryKey,
  safeParseEventInput,
  sourceEventId,
} from "../src/index.ts";
import { deploymentInput, SHA } from "./fixtures.ts";

describe("parseEventInput", () => {
  it("accepts and normalises a valid event", () => {
    const e = parseEventInput(deploymentInput());
    expect(e.occurredAt).toBe("2026-10-01T10:00:00.123Z");
    expect(e.observedAt).toBe("2026-10-01T10:00:01.500Z");
    // nulls removed from structured fields
    expect(e.actor).toEqual({
      type: "user",
      id: "583231",
      login: "octocat",
      name: "The Octocat",
      triggeredBy: { type: "bot", id: "41898282", login: "github-actions[bot]" },
    });
    // correlation keys de-duplicated, sorted and lower-cased where case-insensitive
    expect(e.correlation).toEqual({
      commitShas: [SHA],
      refs: ["refs/heads/main"],
      repositories: ["github.com/acme/api"],
      environments: ["production"],
      deploymentIds: ["github:1234567"],
    });
    expect(e.connectionId).toBe("conn_gh_1");
    expect(e.rawPayload?.contentType).toBe("application/json");
  });

  it("defaults outcome, correlation, data, connectionId and rawPayload", () => {
    const {
      outcome: _o,
      correlation: _c,
      data: _d,
      connectionId: _i,
      rawPayload: _r,
      ...rest
    } = deploymentInput();
    const e = parseEventInput(rest);
    expect(e.outcome).toBe("unknown");
    expect(e.correlation).toEqual({});
    expect(e.data).toEqual({});
    expect(e.connectionId).toBeNull();
    expect(e.rawPayload).toBeNull();
  });

  it("represents events discovered by reconciliation", () => {
    const e = parseEventInput(
      deploymentInput({ observation: { method: "reconciliation", jobId: "job-1" } }),
    );
    expect(e.observation).toEqual({ method: "reconciliation", jobId: "job-1" });
  });

  it.each([
    ["unknown top-level field", { extra: 1 }],
    ["bad source", { source: "GitHub" }],
    ["bad action", { action: "Deployment Created" }],
    ["empty sourceEventId", { sourceEventId: "" }],
    ["too long sourceEventId", { sourceEventId: "x".repeat(513) }],
    ["bad timestamp", { occurredAt: "yesterday" }],
    ["timestamp without offset", { occurredAt: "2026-10-01T10:00:00" }],
    ["bad outcome", { outcome: "ok" }],
    ["bad trigger", { trigger: { type: "magic" } }],
    ["bad observation method", { observation: { method: "carrier_pigeon" } }],
    ["user without id or login", { actor: { type: "user", name: "Someone" } }],
    ["unknown actor field", { actor: { type: "system", role: "x" } }],
    ["short commit sha", { correlation: { commitShas: ["abc123"] } }],
    ["bad digest", { correlation: { imageDigests: ["latest"] } }],
    ["unknown correlation key", { correlation: { tickets: ["X-1"] } }],
    ["NUL in data", { data: { s: "a\u0000b" } }],
    ["lone surrogate in target", { target: { type: "repository", id: "a\ud800" } }],
    ["non-JSON data", { data: { n: Infinity } }],
  ])("rejects %s", (_name, override) => {
    const r = safeParseEventInput({ ...deploymentInput(), ...override });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBeInstanceOf(EventValidationError);
  });

  it("throws EventValidationError with issues", () => {
    try {
      parseEventInput({ ...deploymentInput(), outcome: "ok" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EventValidationError);
      expect((err as EventValidationError).issues[0]?.path).toEqual(["outcome"]);
    }
  });

  it("accepts system/unknown actors without identifiers", () => {
    expect(() => parseEventInput(deploymentInput({ actor: { type: "unknown" } }))).not.toThrow();
  });
});

describe("observation gaps", () => {
  const base = {
    gapId: "gap-1",
    connectionId: "conn_gh_1",
    source: "github",
    startedAt: "2026-10-01T10:00:00Z",
    reason: "auth_failed",
    observedAt: "2026-10-01T10:05:00Z",
  } as const;

  it("builds valid opened/closed events", () => {
    const opened = parseEventInput(observationGapOpened(base));
    expect(opened.action).toBe(ACTIONS.OBSERVATION_GAP_OPENED);
    expect(opened.source).toBe("afe");
    expect(opened.sourceEventId).toBe("observation_gap:gap-1:opened");
    expect(opened.occurredAt).toBe("2026-10-01T10:00:00.000Z");
    expect(opened.target).toEqual({ type: "connection", id: "conn_gh_1" });
    expect(opened.data).toEqual({
      gap: {
        gapId: "gap-1",
        connectionId: "conn_gh_1",
        source: "github",
        startedAt: "2026-10-01T10:00:00.000Z",
        reason: "auth_failed",
      },
    });
    expect(isObservationGapEvent(opened)).toBe(true);

    const closed = parseEventInput(
      observationGapClosed({ ...base, endedAt: "2026-10-01T11:00:00Z" }),
    );
    expect(closed.sourceEventId).toBe("observation_gap:gap-1:closed");
    expect(closed.occurredAt).toBe("2026-10-01T11:00:00.000Z");
    expect((closed.data.gap as { endedAt: string }).endedAt).toBe("2026-10-01T11:00:00.000Z");
  });

  it("rejects closed gaps without endedAt or ending before they start", () => {
    const closed = observationGapClosed({ ...base, endedAt: "2026-10-01T09:00:00Z" });
    expect(safeParseEventInput(closed).success).toBe(false);
    const noEnd = { ...closed, data: { gap: { ...(closed.data!.gap as object), endedAt: null } } };
    expect(safeParseEventInput(noEnd).success).toBe(false);
  });

  it("rejects gap events with malformed gap data or a non-afe source", () => {
    const opened = observationGapOpened(base);
    expect(safeParseEventInput({ ...opened, data: {} }).success).toBe(false);
    expect(safeParseEventInput({ ...opened, source: "github" }).success).toBe(false);
    expect(
      safeParseEventInput({
        ...opened,
        data: { gap: { ...(opened.data!.gap as object), reason: "bad luck" } },
      }).success,
    ).toBe(false);
  });
});

describe("helpers", () => {
  it("sourceEventId escapes separators so different parts never collide", () => {
    expect(sourceEventId("deployment", 123, "created")).toBe("deployment:123:created");
    expect(sourceEventId("a:b", "c")).not.toBe(sourceEventId("a", "b:c"));
    expect(sourceEventId("app", "ns/name", "50%")).toBe("app:ns/name:50%25");
  });

  it.each([
    ["https://github.com/Acme/API.git", "github.com/acme/api"],
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    ["ssh://git@gitlab.example.com:2222/team/app", "gitlab.example.com/team/app"],
    ["Acme/Api", "github.com/acme/api"],
    ["https://user:secret@github.com/acme/api/", "github.com/acme/api"],
  ])("repositoryKey(%s)", (input, expected) => {
    expect(repositoryKey(input)).toBe(expected);
  });

  it("knows the vocabulary", () => {
    expect(isKnownAction("argocd.sync.succeeded")).toBe(true);
    expect(isKnownAction("vercel.something.new")).toBe(false);
  });
});
