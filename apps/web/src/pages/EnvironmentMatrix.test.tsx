// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetch } from "../api/client.ts";
import type {
  EnvironmentStateResponse,
  HistoryItem,
  HistoryResponse,
  MatrixCell,
  PlacementSummary,
} from "../api/environments.ts";
import { App } from "../App.tsx";
import { certaintyOf, liveLabel } from "./environments-ui.tsx";

afterEach(() => cleanup());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const SHA_A = "4f2c9b8" + "a".repeat(33);
const SHA_B = "9e1d2c3" + "b".repeat(33);
const SHA_C = "77aa001" + "c".repeat(33);
const ev = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function placement(o: Partial<PlacementSummary>): PlacementSummary {
  return {
    eventId: ev(1),
    at: ago(2),
    source: "argocd",
    action: "argocd.sync.succeeded",
    kind: "deploy",
    how: "auto_sync",
    actor: null,
    deploymentIds: [],
    deploymentUrls: [],
    configRevision: null,
    images: [],
    commits: [],
    attribution: { status: "attributed", confidence: "probable" },
    notes: [],
    evidenceEventIds: [],
    gaps: [],
    ...o,
  };
}

function cell(
  service: string,
  environment: string,
  p: PlacementSummary,
  o: Partial<MatrixCell> = {},
  label = `${service}-${environment}`,
): MatrixCell {
  const target = {
    key: `${p.source}:${label}`,
    source: p.source,
    label,
    toolEnvironment: environment,
    mapping: null,
    current: p,
    since: p.at,
    contentSince: p.at,
    history: { placements: 1, byKind: { [p.kind]: 1 }, previous: null },
  };
  return {
    service,
    environment,
    unmapped: service === "_unmapped" || environment === "_unmapped",
    status: p.attribution.status,
    confidence: p.attribution.confidence,
    since: p.at,
    contentSince: p.at,
    consistent: true,
    gap: { flagged: false, evidenceInGap: false, possiblyStale: false },
    live: { ...p, targetKey: target.key, label },
    targets: [target],
    targetsOmitted: 0,
    historyUrl: `/api/environments/${service}/${environment}/history`,
    ...o,
  };
}

const GAP = {
  gapId: "g1",
  source: "argocd",
  connectionId: "c-argo",
  startedAt: ago(30),
  endedAt: ago(26),
  reason: "connection_error",
  relation: "evidence_in_gap" as const,
  eventId: ev(21),
};

function windowOf(o: Partial<EnvironmentStateResponse["window"]> = {}) {
  return {
    from: ago(30 * 24),
    to: ago(0),
    events: 1234,
    asOfSeq: 4182,
    stale: false,
    truncated: false,
    computedAt: ago(0),
    ...o,
  };
}

function matrix(o: Partial<EnvironmentStateResponse> = {}): EnvironmentStateResponse {
  return {
    asOf: ago(0),
    window: windowOf(),
    services: [
      { id: "shop-api", name: "Shop API", unmapped: false },
      { id: "web", name: "Web", unmapped: false },
      { id: "_unmapped", name: "Unmapped", unmapped: true },
    ],
    environments: [
      { id: "staging", name: "Staging", kind: "staging", order: 10, unmapped: false },
      { id: "production", name: "Production", kind: "production", order: 20, unmapped: false },
    ],
    cells: [
      cell(
        "shop-api",
        "staging",
        placement({
          eventId: ev(10),
          images: [{ ref: "ghcr.io/acme/shop-api:4f2c9b8", builds: [] }],
          commits: [
            {
              repository: "github.com/acme/shop",
              commitSha: SHA_A,
              confidence: "certain",
              via: "built by run 42 (same run)",
            },
          ],
          attribution: { status: "attributed", confidence: "certain" },
        }),
      ),
      cell(
        "shop-api",
        "production",
        placement({
          eventId: ev(11),
          kind: "promotion",
          commits: [
            {
              repository: "github.com/acme/shop",
              commitSha: SHA_A,
              confidence: "strong",
              via: "same image digest",
            },
          ],
          attribution: { status: "attributed", confidence: "strong" },
          gaps: [GAP],
        }),
        { gap: { flagged: true, evidenceInGap: true, possiblyStale: false } },
      ),
      cell(
        "web",
        "production",
        placement({
          eventId: ev(12),
          source: "vercel",
          action: "deployment.rolled_back",
          kind: "rollback",
          how: "rollback",
          actor: "alice",
          commits: [
            {
              repository: "github.com/acme/web",
              commitSha: SHA_B,
              confidence: "weak",
              via: "web:latest built by two runs (mutable tag)",
            },
            {
              repository: "github.com/acme/web",
              commitSha: SHA_C,
              confidence: "weak",
              via: "web:latest built by two runs (mutable tag)",
            },
          ],
          attribution: { status: "ambiguous", confidence: "weak" },
        }),
        {
          consistent: false,
          gap: { flagged: true, evidenceInGap: false, possiblyStale: true },
        },
      ),
      cell(
        "_unmapped",
        "production",
        placement({
          eventId: ev(13),
          kind: "manual",
          how: "manual",
          images: [{ ref: "ghcr.io/acme/billing:hotfix", builds: [] }],
          attribution: { status: "unknown", confidence: null },
          notes: ["ghcr.io/acme/billing:hotfix was not produced by any observed build"],
        }),
        {},
        "billing-prod",
      ),
    ],
    ...o,
  };
}

function historyItem(n: number, o: Partial<HistoryItem> = {}): HistoryItem {
  const p = placement({
    eventId: ev(100 + n),
    at: ago(2 + n * 24),
    kind: n === 1 ? "rollback" : "deploy",
    gaps: n === 0 ? [GAP] : [],
    commits: [
      {
        repository: "github.com/acme/shop",
        commitSha: n === 0 ? SHA_A : SHA_B,
        confidence: "certain",
        via: "built by run 42 (same run)",
      },
    ],
    attribution: { status: "attributed", confidence: "certain" },
  });
  return {
    target: { key: "argocd:shop-api-staging", source: "argocd", label: "shop-api-staging" },
    current: n === 0,
    change: n === 2 ? "first" : "new_content",
    previousEventId: null,
    placement: p,
    event: {
      id: p.eventId,
      source: "argocd",
      action: "argocd.sync.succeeded",
      at: p.at,
      outcome: "succeeded",
      actor: null,
      trigger: "auto_sync",
      target: { type: "application", id: "argocd/shop-api-staging", label: "shop-api-staging" },
      url: `/api/events/${p.eventId}`,
    },
    causes:
      n === 0
        ? [
            {
              event: {
                id: ev(200),
                source: "github",
                action: "pull_request.merged",
                at: ago(3),
                outcome: "succeeded",
                actor: "bob",
                trigger: "manual",
                target: { type: "repository", id: "acme/shop-deploy", label: "acme/shop-deploy" },
                url: `/api/events/${ev(200)}`,
              },
              stage: "config",
              confidence: "probable",
              evidence: [{ kind: "bump_reference", key: "commit:x" }],
            },
          ]
        : [],
    ...o,
  };
}

function history(items: HistoryItem[], nextCursor: string | null): HistoryResponse {
  return {
    service: { id: "shop-api", name: "Shop API", unmapped: false },
    environment: {
      id: "staging",
      name: "Staging",
      kind: "staging",
      order: 10,
      unmapped: false,
    },
    window: windowOf(),
    targets: [
      {
        key: "argocd:shop-api-staging",
        source: "argocd",
        label: "shop-api-staging",
        toolEnvironment: "staging",
        currentEventId: ev(100),
        placements: 3,
      },
    ],
    total: 3,
    items,
    nextCursor,
  };
}

let requests: string[];
let state: () => EnvironmentStateResponse;
let connections: unknown[];

beforeEach(() => {
  requests = [];
  state = () => matrix();
  connections = [];
  setFetch(async (url) => {
    requests.push(url);
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/session") {
      return json(200, {
        principal: { id: "p", tenantId: "default", roles: ["viewer"], kind: "token" },
      });
    }
    if (u.pathname === "/api/connections") return json(200, { connections });
    if (u.pathname === "/api/environments/state") return json(200, state());
    if (u.pathname === "/api/environments/shop-api/staging/history") {
      return u.searchParams.get("cursor") === "c2"
        ? json(200, history([historyItem(2)], null))
        : json(200, history([historyItem(0), historyItem(1)], "c2"));
    }
    return json(404, { error: "not_found" });
  });
  window.history.replaceState(null, "", "/");
});

/** The matrix cell of a service row (by row header) and column index. */
async function cellOf(service: string, col: number) {
  const header = await screen.findByRole("rowheader", { name: new RegExp(`^${service}`) });
  const row = header.closest("tr")!;
  return within(row).getAllByRole("gridcell")[col]!;
}

describe("Environment matrix (AFE-24)", () => {
  it("is the landing view with services as rows and environments as columns", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Environments", level: 1 })).toBeTruthy();
    const grid = await screen.findByRole("grid");
    const cols = within(grid)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(cols).toEqual(["Service", "Staging staging", "Production production"]);
    expect(
      within(grid)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["Shop API", "Web", expect.stringMatching(/^Unmapped/)]);
    expect(screen.getByRole("link", { name: "Environments" }).getAttribute("aria-current")).toBe(
      "page",
    );
    // The computation's freshness is stated.
    expect(screen.getByText("#4182")).toBeTruthy();
    expect(requests).toContain("/api/environments/state");
  });

  it("shows certain, ambiguous and unknown cells distinctly, with their evidence", async () => {
    render(<App />);
    const certain = await cellOf("Shop API", 0);
    expect(within(certain).getByText("4f2c9b8")).toBeTruthy();
    expect(within(certain).getByText("certain")).toBeTruthy();
    expect(within(certain).getByText("deploy")).toBeTruthy();
    expect(within(certain).getByText(/ago/).closest("time")!.getAttribute("title")).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/,
    );

    const ambiguous = await cellOf("Web", 1);
    expect(within(ambiguous).getByText("ambiguous")).toBeTruthy();
    expect(within(ambiguous).getByText("9e1d2c3 +1")).toBeTruthy();
    expect(within(ambiguous).getByText("rollback")).toBeTruthy();
    expect(within(ambiguous).getByText(/mutable tag/)).toBeTruthy();
    expect(within(ambiguous).getByText("targets differ")).toBeTruthy();

    const unknown = await cellOf("Unmapped", 1);
    expect(within(unknown).getByText("unknown")).toBeTruthy();
    expect(within(unknown).getByText("manual")).toBeTruthy();
    expect(within(unknown).getByText("billing:hotfix")).toBeTruthy();
    expect(within(unknown).getByText(/not produced by any observed build/)).toBeTruthy();
    expect(within(unknown).getByText(/billing-prod/)).toBeTruthy();

    // Empty cells say so.
    expect(within(await cellOf("Web", 0)).getByText("Nothing seen live")).toBeTruthy();
  });

  it("flags cells whose evidence is in an observation gap or that may be stale", async () => {
    render(<App />);
    const prod = await cellOf("Shop API", 1);
    expect(within(prod).getByText("evidence in a gap")).toBeTruthy();
    expect(within(prod).queryByText("possibly stale")).toBeNull();
    const web = await cellOf("Web", 1);
    expect(within(web).getByText("possibly stale")).toBeTruthy();
    const staging = await cellOf("Shop API", 0);
    expect(within(staging).queryByText(/evidence in a gap|possibly stale/)).toBeNull();
  });

  it("has an explicit Unmapped row that links to the mapping settings", async () => {
    render(<App />);
    const header = await screen.findByRole("rowheader", { name: /^Unmapped/ });
    expect(within(header).getByRole("link", { name: "Set up mapping" }).getAttribute("href")).toBe(
      "/settings/mapping",
    );
    expect(
      within(screen.getByRole("list", { name: "Summary" })).getByText(/unmapped/),
    ).toBeTruthy();
  });

  it("says when the computation does not reflect the newest events", async () => {
    state = () => matrix({ window: windowOf({ stale: true, truncated: true }) });
    render(<App />);
    expect(await screen.findByText(/Not up to date/)).toBeTruthy();
    expect(screen.getByText(/oldest were left out/)).toBeTruthy();
  });

  it("opens the placement history of a cell, paginated, with event and journey links", async () => {
    render(<App />);
    fireEvent.click(within(await cellOf("Shop API", 0)).getByRole("button"));
    const panel = await screen.findByRole("complementary", { name: "Shop API in Staging" });
    expect(window.location.search).toBe("?service=shop-api&environment=staging");
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2 }));

    const steps = await within(panel).findAllByRole("listitem", {}, { timeout: 2000 });
    expect(steps.length).toBeGreaterThan(0);
    expect(within(panel).getByText("live now")).toBeTruthy();
    expect(within(panel).getByText("2 of 3 placements, newest first")).toBeTruthy();
    expect(within(panel).getAllByText("rollback").length).toBe(1);

    const eventLinks = within(panel)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(eventLinks).toContain(`/events/${ev(100)}`);
    expect(eventLinks).toContain(`/events/${ev(200)}`);
    expect(eventLinks).toContain(`/journeys?repository=github.com%2Facme%2Fshop&commit=${SHA_A}`);
    expect(within(panel).getByText(/Linked earlier events \(1\)/)).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Load older placements" }));
    expect(await within(panel).findByText("3 of 3 placements, newest first")).toBeTruthy();
    expect(within(panel).getByText("first seen")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Load older placements" })).toBeNull();
    expect(requests.some((r) => r.includes("/history?limit=20&cursor=c2"))).toBe(true);

    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Shop API in Staging" })).toBeNull(),
    );
    expect(window.location.search).toBe("");
    expect(document.activeElement).toBe(within(await cellOf("Shop API", 0)).getByRole("button"));
  });

  it("opens the history from the URL and shows gap details", async () => {
    window.history.replaceState(null, "", "/?service=shop-api&environment=staging");
    render(<App />);
    const panel = await screen.findByRole("complementary", { name: "Shop API in Staging" });
    const gapLink = await within(panel).findByRole("link", { name: "Event in the gap" });
    expect(gapLink.getAttribute("href")).toBe(`/events/${ev(21)}`);
    expect(within(panel).getByText(/cannot reach the source/)).toBeTruthy();
    const selected = (await cellOf("Shop API", 0)).getAttribute("aria-selected");
    expect(selected).toBe("true");
  });

  it("moves between cells with the arrow keys (one tab stop)", async () => {
    render(<App />);
    const first = within(await cellOf("Shop API", 0)).getByRole("button");
    expect(first.tabIndex).toBe(0);
    expect(within(await cellOf("Shop API", 1)).getByRole("button").tabIndex).toBe(-1);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(within(await cellOf("Shop API", 1)).getByRole("button"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(await cellOf("Web", 1)).getByRole("button"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    // An empty cell is focusable too.
    expect(document.activeElement).toBe(await cellOf("Web", 0));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(within(await cellOf("Web", 1)).getByRole("button"));
  });

  it("explains how to connect tools and set up mapping when there is nothing yet", async () => {
    state = () => matrix({ cells: [], services: [], environments: [] });
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Connect your tools to see what is live where" }),
    ).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    for (const h of ["/connections/github", "/connections/argocd", "/connections/vercel"])
      expect(hrefs).toContain(h);
    expect(hrefs).toContain("/settings/mapping");
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("says nothing was deployed when tools are connected", async () => {
    state = () => matrix({ cells: [] });
    connections = [
      {
        id: "c1",
        source: "github",
        name: "acme",
        status: "active",
        health: { state: "healthy", openGap: null },
        alert: null,
      },
    ];
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Nothing was deployed in the last 30 days" }),
    ).toBeTruthy();
  });

  it("keeps the event timeline reachable at /events", async () => {
    window.history.replaceState(null, "", "/events");
    render(<App />);
    await waitFor(() => expect(requests.some((r) => r.startsWith("/api/events"))).toBe(true));
    expect(requests).not.toContain("/api/environments/state");
  });
});

describe("matrix labels", () => {
  it("prefers the commit, then the image, then the deployment id", () => {
    expect(
      liveLabel(
        placement({ commits: [], images: [{ digest: "sha256:" + "f".repeat(64), builds: [] }] }),
      ).text,
    ).toBe("sha256:ffffffffffff");
    expect(liveLabel(placement({ deploymentIds: ["vercel:dpl_abc123"] })).text).toBe("dpl_abc123");
    expect(liveLabel(placement({})).type).toBe("none");
  });

  it("never turns uncertainty into a confidence level", () => {
    expect(certaintyOf({ status: "ambiguous", confidence: "weak" }).label).toBe("ambiguous");
    expect(certaintyOf({ status: "unknown", confidence: null }).label).toBe("unknown");
    expect(certaintyOf({ status: "guess", confidence: "weak" }).label).toBe("weak guess");
    expect(certaintyOf({ status: "attributed", confidence: "strong" }).label).toBe("strong");
  });
});
