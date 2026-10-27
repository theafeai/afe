import { describe, expect, it } from "vitest";
import {
  buildStoredEvent,
  EventFilterError,
  eventMatchesFilter,
  filterFingerprint,
  normaliseEventFilter,
  parseEventFilterParams,
  parseEventInput,
} from "../src/index.ts";
import { deploymentInput, SHA } from "./fixtures.ts";

const event = buildStoredEvent({
  tenantId: "t",
  seq: 1,
  input: parseEventInput(deploymentInput()),
  rawPayload: null,
});

describe("event filter", () => {
  it("parses query params: repeated, comma-separated, aliases", () => {
    const f = parseEventFilterParams({
      source: ["vercel,github", "github"],
      action: "deployment.*",
      environment: "Production",
      from: "2026-10-01T00:00:00+02:00",
      seqTo: "10",
    });
    expect(f).toEqual({
      actions: ["deployment.*"],
      environments: ["production"],
      occurredFrom: "2026-09-30T22:00:00.000Z",
      seqTo: 10,
      sources: ["github", "vercel"],
    });
    expect(filterFingerprint(f)).toBe(
      filterFingerprint(
        parseEventFilterParams({
          seqTo: "10",
          environment: "production",
          source: "github,vercel",
          action: "deployment.*",
          occurredFrom: "2026-09-30T22:00:00Z",
        }),
      ),
    );
  });

  it("rejects unknown params, bad actions, bad shas and bad times", () => {
    expect(() => parseEventFilterParams({ sorce: "github" })).toThrow(EventFilterError);
    expect(() => parseEventFilterParams({ action: "deploy*" })).toThrow(EventFilterError);
    expect(() => parseEventFilterParams({ commitSha: "abc" })).toThrow(EventFilterError);
    expect(() => parseEventFilterParams({ from: "yesterday" })).toThrow(EventFilterError);
    expect(() =>
      parseEventFilterParams({ from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }),
    ).toThrow(EventFilterError);
    expect(parseEventFilterParams({ limit: "5" }, ["limit"])).toEqual({});
  });

  it("matches the documented semantics", () => {
    const m = (input: Parameters<typeof normaliseEventFilter>[0]) =>
      eventMatchesFilter(event, normaliseEventFilter(input));
    expect(m({})).toBe(true);
    expect(m({ actions: "deployment.*" })).toBe(true);
    expect(m({ actions: "deployment.status_updated" })).toBe(false);
    expect(m({ actors: "OCTOCAT" })).toBe(true);
    expect(m({ actors: "github-actions[bot]" })).toBe(true); // triggeredBy
    expect(m({ actorLogins: "Octocat" })).toBe(true);
    expect(m({ actorIds: "1" })).toBe(false);
    expect(m({ environments: "PRODUCTION" })).toBe(true);
    expect(m({ repositories: "https://github.com/acme/api.git" })).toBe(true);
    expect(m({ refs: "main" })).toBe(true);
    expect(m({ commitShas: SHA.slice(0, 7).toUpperCase() })).toBe(true);
    expect(m({ commitShas: SHA })).toBe(true);
    expect(m({ commitShas: "0".repeat(40) })).toBe(false);
    expect(m({ deploymentIds: "github:1234567" })).toBe(true);
    expect(m({ occurredFrom: "2026-10-01T10:00:00.123Z" })).toBe(true);
    expect(m({ occurredTo: "2026-10-01T10:00:00.123Z" })).toBe(false);
    expect(m({ observationMethods: ["poll", "reconciliation"] })).toBe(false);
    expect(m({ sources: "github", outcomes: "pending", triggerTypes: "upstream" })).toBe(true);
  });
});
