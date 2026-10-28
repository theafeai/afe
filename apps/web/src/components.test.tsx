// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionWithHealth } from "./api/types.ts";
import { GapBanners } from "./components.tsx";
import { Router } from "./router.tsx";

function conn(id: string, source: string, name: string, gap: boolean): ConnectionWithHealth {
  return {
    id,
    source,
    externalId: id,
    name,
    status: "active",
    statusReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    health: {
      state: gap ? "unreachable" : "healthy",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastErrorReason: null,
      lastError: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
      openGap: gap
        ? { id: `g-${id}`, startedAt: "2026-10-20T08:00:00.000Z", reason: "auth_failed" }
        : null,
      lastBackfill: null,
    },
    alert: null,
  };
}

afterEach(() => cleanup());

describe("GapBanners", () => {
  it("renders nothing when every connection is observed", () => {
    const { container } = render(
      <Router>
        <GapBanners connections={[conn("a", "github", "acme", false)]} />
      </Router>,
    );
    expect(container.textContent).toBe("");
  });

  it("lists every unobserved connection in one panel, with a link to each", () => {
    render(
      <Router>
        <GapBanners
          connections={[
            conn("a", "github", "acme", true),
            conn("b", "argocd", "prod", true),
            conn("c", "vercel", "web", false),
          ]}
        />
      </Router>,
    );
    const panel = screen.getByRole("region", { name: "Open observation gaps" });
    expect(within(panel).getAllByRole("status")).toHaveLength(1);
    expect(within(panel).getByText(/Data may be missing from 2 connections/)).toBeTruthy();
    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(/Data may be missing from GitHub/)).toBeTruthy();
    expect(within(rows[0]!).getByText(/credentials rejected/)).toBeTruthy();
    expect(within(rows[1]!).getByRole("link", { name: "Details" }).getAttribute("href")).toBe(
      "/connections/b",
    );
  });
});
