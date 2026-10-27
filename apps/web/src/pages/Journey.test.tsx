// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalEvent } from "@afe/core/types";
import { setFetch } from "../api/client.ts";
import type {
  EnvironmentStateLite,
  EventSummary,
  Journey,
  JourneyResponse,
  JourneyStep,
  Stage,
} from "../api/journeys.ts";
import type { EventItem } from "../api/types.ts";
import { App } from "../App.tsx";
import { Router } from "../router.tsx";
import { JourneyContent } from "./Journey.tsx";
import { parseHighlight } from "./JourneyHighlight.tsx";
import { layoutJourney, prefersPlacementList, whereItWent } from "./journey-model.ts";

const SHA = "9fc2f90cd9141e5465fc758ba344fa6bbb95703e";
const LATER = "b".repeat(40);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function summary(n: number, action: string, source = "github", at = n): EventSummary {
  return {
    id: id(n),
    source,
    action,
    at: new Date(Date.UTC(2026, 9, 20, 9, at)).toISOString(),
    outcome: "succeeded",
    actor: "dana",
    trigger: "push",
    target: { type: "repository", id: "acme/shop", label: "acme/shop" },
    url: `/api/events/${id(n)}`,
  };
}

function step(n: number, action: string, stage: Stage, extra: Partial<JourneyStep> = {}) {
  return {
    eventId: id(n),
    stage,
    confidence: "certain" as const,
    via: [],
    event: summary(n, action, stage === "deploy" ? "argocd" : "github"),
    ...extra,
  };
}

function journey(patch: Partial<Journey> = {}): Journey {
  const steps: JourneyStep[] = [
    step(1, "ref.pushed", "change"),
    step(2, "workflow_run.completed", "ci"),
    step(3, "artifact.published", "artifact"),
    step(4, "argocd.sync.succeeded", "deploy", {
      confidence: "strong",
      reachedFrom: id(3),
      via: [{ kind: "same_image_digest", confidence: "strong", key: "digest:sha256:aa" }],
    }),
    step(5, "argocd.sync.succeeded", "deploy", {
      confidence: "weak",
      reachedFrom: id(1),
      via: [{ kind: "time_proximity", confidence: "weak", key: "repo:acme/shop" }],
    }),
  ];
  return {
    id: `github.com/acme/shop@${SHA}`,
    repository: "github.com/acme/shop",
    commitSha: SHA,
    ref: "refs/heads/main",
    startedAt: steps[0]!.event.at,
    root: steps[0]!.event,
    stages: (["change", "ci", "artifact", "deploy"] as Stage[]).map((stage) => ({
      stage,
      steps: steps.filter((s) => s.stage === stage).map((s) => s.eventId),
    })),
    steps,
    edges: [
      { from: id(3), to: id(4), confidence: "strong", evidence: steps[3]!.via },
      { from: id(1), to: id(5), confidence: "weak", evidence: steps[4]!.via },
    ],
    environments: [
      {
        environmentKey: "argocd:argocd/shop-api-staging",
        placementEventId: id(4),
        at: steps[3]!.event.at,
        confidence: "strong",
        current: true,
        via: "attribution",
        target: {
          key: "argocd:argocd/shop-api-staging",
          source: "argocd",
          label: "shop-api-staging",
        },
        service: "shop-api",
        environment: "staging",
        event: steps[3]!.event,
      },
    ],
    excluded: [
      {
        eventId: id(9),
        reason: "deployed images do not trace to this commit",
        event: summary(9, "argocd.sync.succeeded", "argocd"),
      },
    ],
    continuesAs: [
      {
        journeyId: `github.com/acme/shop@${LATER}`,
        repository: "github.com/acme/shop",
        commitSha: LATER,
        relation: "merged_as",
        eventId: id(8),
      },
    ],
    conflicts: [
      {
        kind: "tag_digest_mismatch",
        events: [id(3), id(5)],
        key: "image:ghcr.io/acme/shop-api:1.4",
        detail: "tag 1.4 seen with two digests",
      },
    ],
    gaps: [],
    truncated: false,
    containment: null,
    ...patch,
  };
}

const WINDOW = {
  from: "2026-09-27T00:00:00.000Z",
  to: "2026-10-27T00:00:00.000Z",
  events: 10,
  asOfSeq: 10,
  stale: false,
  truncated: false,
  computedAt: "2026-10-27T00:00:00.000Z",
};
const response = (j: Journey): JourneyResponse => ({ window: WINDOW, journey: j });

afterEach(() => cleanup());

describe("journey diagram", () => {
  it("draws edges styled by confidence, conflicts distinctly, with evidence on focus", () => {
    render(
      <Router>
        <JourneyContent data={response(journey())} view="diagram" onView={() => {}} />
      </Router>,
    );
    expect(screen.getAllByTestId("journey-card")).toHaveLength(5);
    const edges = screen.getAllByTestId("journey-edge");
    expect(edges.map((e) => e.getAttribute("data-confidence")).sort()).toEqual([
      "conflict",
      "strong",
      "weak",
    ]);
    const strong = edges.find((e) => e.getAttribute("data-confidence") === "strong")!;
    expect(strong.getAttribute("aria-label")).toContain("same image digest: digest:sha256:aa");
    expect(strong.getAttribute("tabindex")).toBe("0");
    // Confidence label drawn on the edge.
    expect(within(strong).getByText("strong")).toBeTruthy();

    fireEvent.focus(strong);
    const inspector = screen.getByTestId("journey-inspector");
    expect(within(inspector).getByText(/same image digest: digest:sha256:aa/)).toBeTruthy();

    const conflict = edges.find((e) => e.getAttribute("data-confidence") === "conflict")!;
    fireEvent.focus(conflict);
    expect(within(inspector).getByText("tag 1.4 seen with two digests")).toBeTruthy();
    // Conflicts are also listed in text.
    expect(screen.getByRole("heading", { name: "Conflicting identifiers" })).toBeTruthy();
  });

  it("cards are keyboard-focusable links with a text summary; focus shows how they were reached", () => {
    render(
      <Router>
        <JourneyContent data={response(journey())} view="diagram" onView={() => {}} />
      </Router>,
    );
    const cards = screen.getAllByTestId("journey-card");
    const weak = cards.find((c) => c.getAttribute("href") === `/events/${id(5)}`)!;
    expect(weak.tagName).toBe("A");
    expect(weak.getAttribute("aria-label")).toContain("weak link");
    fireEvent.focus(weak);
    const inspector = screen.getByTestId("journey-inspector");
    expect(within(inspector).getByText(/close in time/)).toBeTruthy();
    // The commit's own events say so instead of a confidence.
    expect(within(cards[0]!).getByText("commit")).toBeTruthy();
  });

  it("routes edges that skip columns around the cards, not under them", () => {
    const layout = layoutJourney(journey(), 200);
    const skip = layout.edges.find((e) => e.edge.from === id(1) && !e.conflict)!;
    // Orthogonal path through gutters and a channel (L segments), not a single curve.
    expect(skip.d.split(" L ").length).toBeGreaterThan(3);
    expect(layout.edges.find((e) => e.edge.from === id(3))!.d).toContain(" C ");
  });

  it("offers a step list as the text alternative", () => {
    render(
      <Router>
        <JourneyContent data={response(journey())} view="list" onView={() => {}} />
      </Router>,
    );
    const list = document.querySelector(".step-list")!;
    expect(within(list as HTMLElement).getByRole("heading", { name: "Artifact" })).toBeTruthy();
    expect(within(list as HTMLElement).getAllByText(/reached from/)).toHaveLength(2);
  });
});

describe("journey lists", () => {
  it("shows excluded steps with their reason and continues-as links to the next journey", () => {
    render(
      <Router>
        <JourneyContent data={response(journey())} view="diagram" onView={() => {}} />
      </Router>,
    );
    const excluded = screen.getByRole("heading", { name: "Excluded" }).closest("section")!;
    expect(within(excluded).getByText("deployed images do not trace to this commit")).toBeTruthy();
    const cont = screen.getByRole("heading", { name: "Continues as" }).closest("section")!;
    expect(within(cont).getByText(/Merged as/)).toBeTruthy();
    const link = within(cont).getByRole("link", { name: /acme\/shop@bbbbbbb/ });
    expect(link.getAttribute("href")).toBe(`/journeys?repository=acme%2Fshop&commit=${LATER}`);
  });

  it("switches to a list of placements for long-lived commits with many deploys", () => {
    const base = journey();
    const envs = Array.from({ length: 12 }, (_, i) => ({
      ...base.environments[0]!,
      environmentKey: `argocd:argocd/worker-r${i}`,
      placementEventId: id(100 + i),
      target: { key: `argocd:argocd/worker-r${i}`, source: "argocd", label: `worker-r${i}` },
      event: summary(100 + i, "argocd.sync.succeeded", "argocd", 10 + i),
    }));
    const j = journey({ environments: envs });
    expect(prefersPlacementList(j)).toBe(true);
    const onView: string[] = [];
    render(
      <Router>
        <JourneyContent data={response(j)} view={null} onView={(v) => onView.push(v)} />
      </Router>,
    );
    expect(screen.queryAllByTestId("journey-card")).toHaveLength(0);
    const table = screen.getByTestId("placement-list");
    expect(within(table).getAllByRole("row")).toHaveLength(13);
    expect(screen.getByText(/deployed 12 times/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    expect(onView).toEqual(["diagram"]);
  });
});

describe("where it went", () => {
  const state: EnvironmentStateLite = {
    window: WINDOW,
    services: [{ id: "shop-api", name: "Shop API", unmapped: false }],
    environments: [
      { id: "staging", name: "Staging", kind: "staging", order: 1, unmapped: false },
      { id: "production", name: "Production", kind: "production", order: 2, unmapped: false },
      { id: "dev", name: "Dev", kind: "development", order: 0, unmapped: false },
    ],
    cells: [
      {
        service: "shop-api",
        environment: "production",
        since: "2026-10-26T00:00:00.000Z",
        live: {
          eventId: id(50),
          at: "2026-10-26T00:00:00.000Z",
          label: "shop-api-production",
          commits: [{ commitSha: LATER, confidence: "strong", via: "digest" }],
          attribution: { status: "attributed", confidence: "strong" },
        },
        targets: [
          {
            key: "argocd:argocd/shop-api-production",
            label: "shop-api-production",
            source: "argocd",
          },
        ],
      },
      {
        service: "shop-api",
        environment: "dev",
        since: "2026-10-01T00:00:00.000Z",
        live: {
          eventId: id(51),
          at: "2026-10-01T00:00:00.000Z",
          label: "shop-api-dev",
          commits: [],
          attribution: { status: "unknown", confidence: null },
        },
        targets: [{ key: "argocd:argocd/shop-api-dev", label: "shop-api-dev", source: "argocd" }],
      },
    ],
  };

  it("says live now, not yet and unknown without containment", () => {
    const rows = whereItWent(journey(), state);
    const by = Object.fromEntries(rows.map((r) => [r.environment, r]));
    expect(by.staging!.status).toBe("live");
    // Deployed before the commit was first seen.
    expect(by.dev!.status).toBe("not_yet");
    // A later commit is live; without a containment check that is unknown.
    expect(by.production!.status).toBe("unknown");
    expect(by.production!.detail).toMatch(/Check containment/);
  });

  it("shows 'contained via later commit' honestly when containment was checked", () => {
    const base = journey();
    const j = journey({
      environments: [
        ...base.environments,
        {
          ...base.environments[0]!,
          environmentKey: "argocd:argocd/shop-api-production",
          placementEventId: id(50),
          via: "containment",
          current: true,
          confidence: "strong",
          environment: "production",
          target: {
            key: "argocd:argocd/shop-api-production",
            source: "argocd",
            label: "shop-api-production",
          },
        },
      ],
      containment: [
        {
          placementEventId: id(50),
          liveCommitSha: LATER,
          contained: true,
          reason: "the live commit is 3 commits ahead",
          environmentKey: "argocd:argocd/shop-api-production",
        },
        {
          placementEventId: id(51),
          liveCommitSha: "c".repeat(40),
          contained: false,
          reason: "diverged",
          environmentKey: "argocd:argocd/shop-api-dev",
        },
      ],
    });
    render(
      <Router>
        <JourneyContent
          data={response(j)}
          state={state}
          view="diagram"
          onView={() => {}}
          containmentRequested
          onContainment={() => {}}
        />
      </Router>,
    );
    const where = screen.getByRole("heading", { name: "Where it went" }).closest("section")!;
    const prod = within(where).getByText("Production").closest("li")!;
    expect(within(prod).getByText("Live now")).toBeTruthy();
    expect(within(prod).getByText(/Contained via later commit bbbbbbb/)).toBeTruthy();
    const dev = within(where).getByText("Dev").closest("li")!;
    expect(within(dev).getByText("Not yet")).toBeTruthy();
    expect(within(dev).getByText(/does not include it \(diverged\)/)).toBeTruthy();
  });

  it("marks a replaced placement as was live", () => {
    const base = journey();
    const j = journey({ environments: [{ ...base.environments[0]!, current: false }] });
    expect(whereItWent(j, null)[0]!.status).toBe("was_live");
  });
});

// --- Through the app: route, API calls, timeline highlight ----------------------

function eventItem(n: number, patch: Partial<CanonicalEvent>): EventItem {
  const event: CanonicalEvent = {
    schemaVersion: 1,
    id: id(n),
    tenantId: "default",
    seq: n,
    source: "github",
    sourceEventId: `x:${n}`,
    connectionId: "c-gh",
    action: "ref.pushed",
    actor: { type: "user", login: "dana" },
    target: { type: "ref", id: "acme/shop:main", repository: "acme/shop" },
    trigger: { type: "push" },
    outcome: "none",
    occurredAt: new Date(Date.UTC(2026, 9, 20, 9, n)).toISOString(),
    observedAt: "2026-10-20T10:00:01.000Z",
    recordedAt: "2026-10-20T10:00:01.000Z",
    observation: { method: "webhook" },
    correlation: {},
    data: {},
    rawPayload: null,
    ...patch,
  };
  return {
    event,
    provenance: {
      source: event.source,
      sourceEventId: event.sourceEventId,
      method: "webhook",
      discoveredByReconciliation: false,
      deliveryId: null,
      jobId: null,
      connectionId: event.connectionId,
      observedAt: event.observedAt,
      recordedAt: event.recordedAt,
    },
  };
}

describe("journey page and timeline highlight (app)", () => {
  let requests: string[] = [];
  let journeyStatus = 200;
  beforeEach(() => {
    requests = [];
    journeyStatus = 200;
    setFetch(async (url) => {
      requests.push(url);
      const u = new URL(url, "http://x");
      let body: unknown;
      if (u.pathname === "/api/journeys") {
        if (journeyStatus === 400)
          return new Response(
            JSON.stringify({
              error: "bad_request",
              message: "ambiguous commit prefix",
              candidates: [SHA, `${SHA.slice(0, 7)}${"e".repeat(33)}`],
            }),
            { status: 400 },
          );
        body = response(journey());
      } else if (u.pathname === "/api/connections") body = { connections: [] };
      else if (u.pathname === "/api/events") {
        body = {
          items: [
            // On the journey (a step) and with a commit: gets a "View journey" action.
            eventItem(1, {
              correlation: { commitShas: [SHA], repositories: ["github.com/acme/shop"] },
            }),
            // Excluded by the journey.
            eventItem(9, { source: "argocd", action: "argocd.sync.succeeded" }),
            // Unrelated, other commit: dimmed, offers "Highlight journey".
            eventItem(20, {
              action: "workflow_run.completed",
              correlation: { commitShas: [LATER], repositories: ["github.com/acme/shop"] },
            }),
          ],
          nextCursor: null,
          snapshotSeq: 3,
        };
      } else return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });

  it("loads the journey for a short SHA from the URL", async () => {
    window.history.replaceState(null, "", "/journeys?repository=acme/shop&commit=9FC2F90");
    render(<App />);
    expect(await screen.findByRole("heading", { name: /Journey of/ })).toBeTruthy();
    expect(requests).toContain("/api/journeys?repository=acme%2Fshop&commit=9fc2f90");
    // Containment is opt-in (GitHub compare calls).
    fireEvent.click(screen.getByRole("button", { name: "Check later commits" }));
    await waitFor(() =>
      expect(requests).toContain(
        "/api/journeys?repository=acme%2Fshop&commit=9fc2f90&include=containment",
      ),
    );
    expect(window.location.search).toContain("containment=1");
  });

  it("lists candidates for an ambiguous prefix", async () => {
    journeyStatus = 400;
    window.history.replaceState(null, "", "/journeys?repository=acme/shop&commit=9fc2f90");
    render(<App />);
    expect(await screen.findByText(/matches several commits/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /^9fc2f90/ })).toHaveLength(2);
  });

  it("highlights the journey's events on the timeline and dims the rest", async () => {
    window.history.replaceState(null, "", `/events?journey=acme/shop@${SHA.slice(0, 7)}`);
    render(<App />);
    const banner = await screen.findByTestId("highlight-banner");
    await waitFor(() => expect(within(banner).getByText(/related events/)).toBeTruthy());
    expect(within(banner).getByText(/1 ruled out/)).toBeTruthy();

    const on = screen.getByText("ref.pushed").closest("li")!;
    expect(on.className).toContain("row-hl-on");
    expect(within(on).getByRole("link", { name: "View journey" }).getAttribute("href")).toBe(
      `/journeys?repository=acme%2Fshop&commit=${SHA}`,
    );
    expect(screen.getByText("argocd.sync.succeeded").closest("li")!.className).toContain(
      "row-hl-excluded",
    );
    const other = screen.getByText("workflow_run.completed").closest("li")!;
    expect(other.className).toContain("row-hl-dim");

    // Selecting another commit is URL-driven.
    await act(async () => {
      fireEvent.click(within(other).getByRole("button", { name: "Highlight journey" }));
    });
    expect(new URLSearchParams(window.location.search).get("journey")).toBe(`acme/shop@${LATER}`);
    expect(requests.some((r) => r.includes(`commit=${LATER}`))).toBe(true);

    // Clearing removes the parameter and the dimming.
    fireEvent.click(screen.getByRole("button", { name: "Clear highlight" }));
    expect(window.location.search).not.toContain("journey=");
    await waitFor(() =>
      expect(screen.getByText("workflow_run.completed").closest("li")!.className).not.toContain(
        "row-hl",
      ),
    );
  });

  it("keeps the highlight when filters change", async () => {
    window.history.replaceState(null, "", `/events?journey=acme/shop@${SHA}`);
    render(<App />);
    await screen.findByTestId("highlight-banner");
    fireEvent.click(await screen.findByRole("button", { name: "Show its time span" }));
    const q = new URLSearchParams(window.location.search);
    expect(q.get("journey")).toBe(`acme/shop@${SHA}`);
    expect(q.get("from")).toBe("2026-10-20T09:00:00.000Z");
    expect(q.get("to")).toBe("2026-10-20T09:10:00.000Z");
  });

  it("parses highlight values", () => {
    expect(parseHighlight("acme/shop@ABCDEF1")).toEqual({
      repository: "acme/shop",
      commit: "abcdef1",
    });
    expect(parseHighlight("acme/shop")).toBeNull();
    expect(parseHighlight("acme/shop@xyz")).toBeNull();
  });
});

describe("event detail journey links", () => {
  it("links the event's commit and the commits its placement is attributed to", async () => {
    const item = eventItem(4, {
      source: "argocd",
      action: "argocd.sync.succeeded",
      correlation: { commitShas: ["d".repeat(40)], repositories: ["github.com/acme/shop-deploy"] },
    });
    setFetch(async (url) => {
      const u = new URL(url, "http://x");
      let body: unknown;
      if (u.pathname === `/api/events/${id(4)}`) body = { ...item, rawPayload: null };
      else if (u.pathname === `/api/events/${id(4)}/links`)
        body = {
          eventId: id(4),
          inWindow: true,
          window: WINDOW,
          total: 3,
          links: [],
          conflicts: [],
          placement: {
            target: { key: "argocd:argocd/shop-api-staging", source: "argocd", label: "x" },
            current: true,
            eventId: id(4),
            at: "2026-10-20T09:04:00.000Z",
            kind: "deploy",
            commits: [
              {
                repository: "github.com/acme/shop",
                commitSha: SHA,
                confidence: "probable",
                via: "tag match",
              },
            ],
            attribution: { status: "attributed", confidence: "probable" },
            notes: [],
          },
        };
      else return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    });
    window.history.replaceState(null, "", `/events/${id(4)}`);
    render(<App />);
    const panel = (await screen.findByRole("heading", { name: "Journey" })).closest("section")!;
    expect(within(panel).getByRole("link", { name: "view journey" }).getAttribute("href")).toBe(
      `/journeys?repository=acme%2Fshop-deploy&commit=${"d".repeat(40)}`,
    );
    const attributed = await within(panel).findByRole("link", { name: /acme\/shop@9fc2f90/ });
    expect(attributed.getAttribute("href")).toBe(`/journeys?repository=acme%2Fshop&commit=${SHA}`);
    expect(within(panel).getByText(/Live content/)).toBeTruthy();
    expect(within(panel).getByText("probable")).toBeTruthy();
  });
});
