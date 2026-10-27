// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalEvent } from "@afe/core/types";
import { setFetch } from "../api/client.ts";
import type { ContainmentReport } from "../api/containment.ts";
import { App } from "../App.tsx";
import { containmentSubject } from "./ContainmentPanel.tsx";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const SHA = "a".repeat(40);
const ID = "00000000-0000-4000-8000-000000000001";
const PROD_EVENT = "00000000-0000-4000-8000-000000000099";

function event(correlation: CanonicalEvent["correlation"]): CanonicalEvent {
  return {
    schemaVersion: 1,
    id: ID,
    tenantId: "default",
    seq: 1,
    source: "github",
    sourceEventId: "pr:1",
    connectionId: "c-gh",
    action: "pull_request.merged",
    actor: { type: "user", login: "alice" },
    target: { type: "repository", id: "acme/web", repository: "acme/web" },
    trigger: { type: "manual" },
    outcome: "succeeded",
    occurredAt: "2026-10-20T10:00:00.000Z",
    observedAt: "2026-10-20T10:00:01.000Z",
    recordedAt: "2026-10-20T10:00:01.000Z",
    observation: { method: "webhook" },
    correlation,
    data: {},
    rawPayload: null,
  };
}

const report: ContainmentReport = {
  repository: "acme/web",
  commit: SHA,
  checkedAt: "2026-10-27T10:00:00.000Z",
  partial: true,
  notes: ["1 more environment(s) were not checked (at most 10 per request)"],
  environments: [
    {
      environment: "Production",
      environmentId: "production",
      source: "github",
      liveCommit: "b".repeat(40),
      liveSince: "2026-10-26T09:00:00.000Z",
      contained: true,
      reasonCode: "ancestor",
      reason: "the live commit is 3 commit(s) ahead and includes this commit",
      evidence: [PROD_EVENT],
      comparison: { status: "ahead", aheadBy: 3, behindBy: 0 },
      cached: false,
    },
    {
      environment: "Staging",
      environmentId: "staging",
      source: "argocd",
      liveCommit: "c".repeat(40),
      liveSince: "2026-10-26T08:00:00.000Z",
      contained: false,
      reasonCode: "not_yet_live",
      reason: "the live commit is 2 commit(s) behind this commit (older)",
      evidence: ["00000000-0000-4000-8000-000000000098"],
      comparison: { status: "behind", aheadBy: 0, behindBy: 2 },
      cached: true,
    },
    {
      environment: "canary-eu",
      environmentId: null,
      source: "github",
      liveCommit: "d".repeat(40),
      liveSince: "2026-10-26T07:00:00.000Z",
      contained: "unknown",
      reasonCode: "missing_permission",
      reason: "the GitHub App installation has not granted the optional contents: read permission",
      evidence: [],
      comparison: null,
      cached: false,
    },
  ],
};

let requests: string[];
let current: CanonicalEvent;
let containment: () => Response;

beforeEach(() => {
  requests = [];
  current = event({ repositories: ["github.com/acme/web"], commitShas: [SHA] });
  containment = () => json(200, report);
  setFetch(async (url) => {
    requests.push(url);
    if (url === "/api/session") {
      return json(200, {
        principal: { id: "p", tenantId: "default", roles: ["viewer"], kind: "token" },
      });
    }
    if (url === "/api/connections") return json(200, { connections: [] });
    if (url === `/api/events/${ID}`) {
      return json(200, {
        event: current,
        provenance: {
          source: "github",
          sourceEventId: "pr:1",
          method: "webhook",
          discoveredByReconciliation: false,
          deliveryId: null,
          jobId: null,
          connectionId: "c-gh",
          observedAt: current.observedAt,
          recordedAt: current.recordedAt,
        },
        rawPayload: null,
      });
    }
    if (url.startsWith("/api/containment?")) return containment();
    return json(404, { error: "not_found" });
  });
  window.history.replaceState(null, "", `/events/${ID}`);
});

afterEach(() => cleanup());

describe("Where is this commit live? (AFE-22)", () => {
  it("shows per environment whether the event's commit is live", async () => {
    render(<App />);
    const heading = await screen.findByRole("heading", { name: "Where is this commit live?" });
    const panel = heading.closest("section")!;
    expect(await within(panel).findByText("Included")).toBeTruthy();
    expect(within(panel).getByText("Not included")).toBeTruthy();
    expect(within(panel).getByText("Unknown")).toBeTruthy();
    expect(within(panel).getByText(/contents: read/)).toBeTruthy();
    expect(within(panel).getByText(/Partial answer/)).toBeTruthy();
    const prodRow = within(panel).getByText("Production").closest("tr")!;
    expect(within(prodRow).getByRole("link").getAttribute("href")).toBe(`/events/${PROD_EVENT}`);

    const call = requests.find((r) => r.startsWith("/api/containment?"))!;
    const q = new URLSearchParams(call.split("?")[1]);
    expect(q.get("repository")).toBe("acme/web");
    expect(q.get("commit")).toBe(SHA);
  });

  it("explains a repository Afe does not know", async () => {
    containment = () => json(404, { error: "not_found" });
    render(<App />);
    expect(await screen.findByText(/no recent deployments of this repository/)).toBeTruthy();
  });

  it("is not shown for events without a GitHub repository and commit", async () => {
    current = event({ repositories: ["gitlab.com/acme/web"], commitShas: [SHA] });
    render(<App />);
    await screen.findByText("pull_request.merged");
    expect(screen.queryByText("Where is this commit live?")).toBeNull();
    expect(requests.some((r) => r.startsWith("/api/containment"))).toBe(false);
  });

  it("picks the first GitHub repository and commit", () => {
    expect(
      containmentSubject({
        correlation: {
          repositories: ["gitlab.com/x/y", "github.com/acme/web"],
          commitShas: [SHA, "b".repeat(40)],
        },
      }),
    ).toEqual({ repository: "acme/web", commit: SHA });
    expect(containmentSubject({ correlation: { repositories: ["github.com/acme/web"] } })).toBe(
      null,
    );
  });
});
