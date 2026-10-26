import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  filtersToApiParams,
  filtersToSearch,
  parseFilters,
} from "./filters.ts";

describe("filters <-> URL", () => {
  it("round-trips every UI filter through the query string", () => {
    const f = {
      ...EMPTY_FILTERS,
      sources: ["github", "vercel"],
      actor: "alice",
      targetField: "environment" as const,
      target: "production",
      trigger: "manual",
      method: "reconciliation",
      outcome: "failed",
      range: "24h" as const,
    };
    const q = filtersToSearch(f);
    expect(q.toString()).toBe(
      "source=github%2Cvercel&actor=alice&environment=production&trigger=manual&method=reconciliation&outcome=failed&range=24h",
    );
    expect(parseFilters(q)).toEqual({ ...f, extra: [] });
  });

  it("parses repeated and comma-separated sources", () => {
    const f = parseFilters(new URLSearchParams("source=github,argocd&source=vercel"));
    expect(f.sources).toEqual(["github", "argocd", "vercel"]);
  });

  it("keeps other API filters (from detail-page links) as extras and drops unknown params", () => {
    const f = parseFilters(
      new URLSearchParams(
        "connectionId=c1&commitSha=abc1234&bogus=1&targetName=web&repository=acme/api",
      ),
    );
    expect(f.targetField).toBe("targetName");
    expect(f.target).toBe("web");
    expect(f.extra).toEqual([
      ["connectionId", "c1"],
      ["commitSha", "abc1234"],
      ["repository", "acme/api"],
    ]);
    const back = filtersToSearch(f);
    expect(back.get("bogus")).toBeNull();
    expect(back.get("connectionId")).toBe("c1");
    expect(activeFilterCount(f)).toBe(4);
  });

  it("treats from/to as a custom range", () => {
    const f = parseFilters(new URLSearchParams("from=2026-10-01T00:00:00.000Z"));
    expect(f.range).toBe("custom");
    expect(filtersToApiParams(f).get("from")).toBe("2026-10-01T00:00:00.000Z");
    expect(filtersToApiParams(f).get("range")).toBeNull();
  });

  it("resolves relative presets to `from` at request time and never sends `range`", () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    const api = filtersToApiParams(parseFilters(new URLSearchParams("range=7d&actor=bob")), now);
    expect(api.get("from")).toBe("2026-10-19T12:00:00.000Z");
    expect(api.get("range")).toBeNull();
    expect(api.get("actor")).toBe("bob");
  });

  it("an empty query means no filters", () => {
    const f = parseFilters(new URLSearchParams(""));
    expect(f).toEqual(EMPTY_FILTERS);
    expect(filtersToSearch(f).toString()).toBe("");
    expect(activeFilterCount(f)).toBe(0);
  });
});
