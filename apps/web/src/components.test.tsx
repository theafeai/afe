// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionWithHealth } from "./api/types.ts";
import { setFetch } from "./api/client.ts";
import { GapBanners, ToolLegend } from "./components.tsx";
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

// AFE-119: "N tools connected" counts only tools Afe can observe now.
describe("ToolLegend", () => {
  const legend = () => screen.getByRole("region", { name: "Legend" });
  const item = (name: string) =>
    within(legend())
      .getAllByRole("listitem")
      .find((li) => li.textContent?.startsWith(name))!;

  it("does not count suspended or disconnected tools as connected", () => {
    render(
      <ToolLegend
        connections={[
          { source: "github", status: "suspended" },
          { source: "argocd", status: "suspended" },
          { source: "vercel", status: "disconnected" },
          { source: "terraform", status: "suspended" },
        ]}
      />,
    );
    expect(legend().textContent).toContain("no tools connected");
    expect(legend().textContent).not.toMatch(/\d tools? connected/);
    expect(item("GitHub").className).toContain("lg-off");
    expect(item("GitHub").textContent).toContain("suspended");
    expect(item("Vercel").textContent).toContain("disconnected");
  });

  it("counts tools with an active connection and lists the others after them", () => {
    render(
      <ToolLegend
        connections={[
          { source: "argocd", status: "suspended" },
          { source: "github", status: "suspended" },
          { source: "github", status: "active" },
          { source: "vercel", status: "revoked" },
          { source: "vercel", status: "pending" },
        ]}
      />,
    );
    expect(legend().textContent).toContain("1 tool connected");
    const items = within(legend()).getAllByRole("listitem");
    expect(items.map((li) => li.className.includes("lg-off"))).toEqual([false, true, true]);
    expect(items[0]!.textContent).toBe("GitHub");
    expect(item("Vercel").textContent).toContain("not observing");
  });

  it("loads statuses when the page passes only the tools on screen", async () => {
    setFetch(async () =>
      Response.json({
        connections: [
          conn("1", "github", "acme", false),
          { ...conn("2", "argocd", "argo", false), status: "suspended" },
        ],
      }),
    );
    render(<ToolLegend sources={["github", "argocd", "vercel"]} />);
    expect(await within(legend()).findByText("1 tool connected", { exact: false })).toBeTruthy();
    expect(item("ArgoCD").textContent).toContain("suspended");
    expect(item("Vercel").textContent).toContain("not connected");
  });
});
