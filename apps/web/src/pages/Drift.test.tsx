// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetch } from "../api/client.ts";
import type { DriftFindingDetail, DriftFindingSummary } from "../api/drift.ts";
import { App } from "../App.tsx";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const ID = "00000000-0000-8000-8000-000000000001";
const EV1 = "00000000-0000-4000-8000-000000000011";
const EV2 = "00000000-0000-4000-8000-000000000012";

const summary: DriftFindingSummary = {
  id: ID,
  type: "manual_override",
  severity: "high",
  status: "open",
  title: "Manual image override on shop-api-production",
  explanation: "The ArgoCD Application's image overrides were changed outside Git.",
  target: {
    key: "argocd:argocd/shop-api-production",
    source: "argocd",
    label: "shop-api-production",
    toolEnvironment: "production",
  },
  service: { id: "shop-api", name: "Shop API" },
  environment: { id: "production", name: "Production" },
  firstSeenAt: "2026-10-22T02:10:00.000Z",
  lastSeenAt: "2026-10-22T02:11:00.000Z",
  resolvedAt: null,
  openingEventId: EV1,
  resolvedByEventId: null,
  evidenceCount: 2,
  url: `/api/drift/findings/${ID}`,
};

const detail: DriftFindingDetail = {
  ...summary,
  latestEventId: EV2,
  evidence: [
    {
      eventId: EV1,
      role: "override",
      at: summary.firstSeenAt,
      summary: "argocd.application.updated via cli by alice: set source.kustomize.images",
      available: false,
      url: null,
    },
    {
      eventId: EV2,
      role: "placement",
      at: summary.lastSeenAt,
      summary: "argocd.sync.succeeded (manual) while the override was set",
      available: true,
      url: `/api/events/${EV2}`,
    },
  ],
  evidenceOmitted: 0,
  eventsPurged: 1,
  details: {},
  journeys: [
    {
      repository: "github.com/acme/shop",
      commitSha: "a".repeat(40),
      url: `/api/journeys?repository=github.com%2Facme%2Fshop&commit=${"a".repeat(40)}`,
    },
  ],
  alert: {
    enabled: true,
    typeAlertsNow: true,
    openedNotifiedAt: "2026-10-22T02:12:00.000Z",
    resolvedNotifiedAt: null,
  },
  detectedAt: "2026-10-22T02:12:00.000Z",
  updatedAt: "2026-10-22T02:12:00.000Z",
};

let requests: string[];
let findings: DriftFindingSummary[];

beforeEach(() => {
  requests = [];
  findings = [summary];
  setFetch(async (url) => {
    requests.push(url);
    if (url === "/api/session")
      return json(200, {
        principal: { id: "p", tenantId: "default", roles: ["viewer"], kind: "token" },
      });
    if (url === "/api/connections") return json(200, { connections: [] });
    if (url === "/api/mapping")
      return json(200, {
        services: [{ id: "shop-api", name: "Shop API" }],
        environments: [{ id: "production", name: "Production" }],
      });
    if (url.startsWith("/api/drift/findings?"))
      return json(200, {
        evaluatedAt: "2026-10-27T00:00:00.000Z",
        counts: { open: findings.length, resolved: 0 },
        findings,
        nextCursor: null,
      });
    if (url === `/api/drift/findings/${ID}`) return json(200, { finding: detail });
    return json(404, { error: "not_found" });
  });
});

afterEach(() => cleanup());

describe("Drift page (AFE-26)", () => {
  it("lists open findings with severity, where and a nav link", async () => {
    window.history.replaceState(null, "", "/drift");
    render(<App />);
    const link = await screen.findByRole("link", { name: summary.title });
    const row = link.closest("tr")!;
    expect(within(row).getByText("High")).toBeTruthy();
    expect(within(row).getByText("Shop API")).toBeTruthy();
    expect(within(row).getByText("Open")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Drift" }).getAttribute("aria-current")).toBe("page");
    expect(requests).toContain("/api/drift/findings?status=open");
  });

  it("filters go to the API and the URL", async () => {
    window.history.replaceState(null, "", "/drift");
    render(<App />);
    await screen.findByRole("link", { name: summary.title });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "untracked_deploy" } });
    await screen.findByRole("link", { name: summary.title });
    expect(window.location.search).toBe("?type=untracked_deploy");
    expect(requests).toContain("/api/drift/findings?status=open&type=untracked_deploy");
  });

  it("shows an empty state", async () => {
    findings = [];
    window.history.replaceState(null, "", "/drift");
    render(<App />);
    expect(await screen.findByText("No drift found")).toBeTruthy();
  });

  it("shows a finding with evidence links, purged evidence and journey links", async () => {
    window.history.replaceState(null, "", `/drift/${ID}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: summary.title })).toBeTruthy();
    expect(screen.getByText(summary.explanation)).toBeTruthy();
    expect(screen.getByText("Event no longer retained")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View event" }).getAttribute("href")).toBe(
      `/events/${EV2}`,
    );
    expect(screen.getByText(/retention window/)).toBeTruthy();
    const journey = screen.getByRole("link", { name: /github\.com\/acme\/shop/ });
    expect(journey.getAttribute("href")).toMatch(/^\/journeys\?repository=/);
  });
});
