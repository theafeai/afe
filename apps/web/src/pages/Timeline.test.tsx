// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalEvent } from "@afe/core/types";
import { setFetch } from "../api/client.ts";
import type { ConnectionWithHealth, EventItem } from "../api/types.ts";
import { App } from "../App.tsx";

function ev(seq: number, patch: Partial<CanonicalEvent>): EventItem {
  const event: CanonicalEvent = {
    schemaVersion: 1,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    tenantId: "default",
    seq,
    source: "github",
    sourceEventId: `x:${seq}`,
    connectionId: "c-gh",
    action: "deployment.created",
    actor: { type: "user", login: "alice" },
    target: { type: "environment", id: "env1", name: "acme/api", environment: "production" },
    trigger: { type: "push" },
    outcome: "succeeded",
    occurredAt: "2026-10-20T10:00:00.000Z",
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
      method: event.observation.method,
      discoveredByReconciliation: event.observation.method === "reconciliation",
      deliveryId: null,
      jobId: null,
      connectionId: event.connectionId,
      observedAt: event.observedAt,
      recordedAt: event.recordedAt,
    },
  };
}

const connection: ConnectionWithHealth = {
  id: "c-argo",
  source: "argocd",
  externalId: "https://argocd.example.com",
  name: "prod-argocd",
  status: "active",
  statusReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  health: {
    state: "unreachable",
    lastSuccessAt: "2026-10-20T08:00:00.000Z",
    lastAttemptAt: null,
    lastFailureAt: null,
    lastErrorReason: "unreachable",
    lastError: null,
    consecutiveFailures: 3,
    nextAttemptAt: null,
    openGap: { id: "g1", startedAt: "2026-10-20T08:00:00.000Z", reason: "connection_error" },
    lastBackfill: null,
  },
  alert: null,
};

let requests: string[] = [];
const pages: Record<string, { items: EventItem[]; nextCursor: string | null }> = {};

beforeEach(() => {
  requests = [];
  setFetch(async (url) => {
    requests.push(url);
    const u = new URL(url, "http://x");
    let body: unknown;
    if (u.pathname === "/api/connections") body = { connections: [connection] };
    else if (u.pathname === "/api/events") {
      const p = pages[u.searchParams.get("cursor") ?? "first"] ?? { items: [], nextCursor: null };
      body = { ...p, snapshotSeq: 10 };
    } else return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  pages.first = {
    items: [
      ev(3, {
        source: "afe",
        action: "observation_gap.opened",
        connectionId: "c-argo",
        target: { type: "connection", id: "c-argo", name: "prod-argocd" },
        observation: { method: "internal" },
        outcome: "none",
        occurredAt: "2026-10-20T11:00:00.000Z",
        data: {
          gap: {
            gapId: "g1",
            connectionId: "c-argo",
            source: "argocd",
            startedAt: "2026-10-20T08:00:00.000Z",
            reason: "connection_error",
          },
        },
      }),
      ev(2, { observation: { method: "reconciliation" }, action: "deployment.status_updated" }),
      ev(1, { occurredAt: "2026-10-19T09:00:00.000Z" }),
    ],
    nextCursor: "c2",
  };
  pages.c2 = {
    items: [ev(0, { occurredAt: "2026-10-18T09:00:00.000Z", action: "workflow_run.completed" })],
    nextCursor: null,
  };
  window.history.replaceState(null, "", "/events?range=7d");
});

afterEach(() => cleanup());

describe("Timeline", () => {
  it("shows open observation gaps, gap events and reconciled events distinctly", async () => {
    render(<App />);
    expect(await screen.findByText(/Data may be missing from ArgoCD/)).toBeTruthy();
    const gapRow = (await screen.findByText(/Observation gap opened/)).closest("li")!;
    expect(gapRow.className).toContain("row-gap-opened");
    expect(within(gapRow).getByText(/may be missing/)).toBeTruthy();

    const reconciled = screen.getByText("deployment.status_updated").closest("li")!;
    expect(reconciled.className).toContain("row-reconciliation");
    expect(within(reconciled).getByText("reconciled")).toBeTruthy();
    expect(within(reconciled).getByText(/Found by reconciliation/)).toBeTruthy();

    const plain = screen.getByText("deployment.created").closest("li")!;
    expect(plain.className).not.toContain("row-reconciliation");
    // Grouped by day: two day headings for the first page.
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });

  it("loads more with the cursor and the same resolved time range", async () => {
    render(<App />);
    await screen.findByText("deployment.created");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("workflow_run.completed")).toBeTruthy();
    const ev = requests.filter((r) => r.startsWith("/api/events"));
    const first = new URL(ev[0]!, "http://x").searchParams;
    const second = new URL(ev[1]!, "http://x").searchParams;
    expect(first.get("from")).toBeTruthy();
    expect(second.get("from")).toBe(first.get("from"));
    expect(second.get("cursor")).toBe("c2");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("syncs filter changes to the URL and refetches", async () => {
    render(<App />);
    await screen.findByText("deployment.created");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Trigger"), { target: { value: "manual" } });
    });
    expect(window.location.search).toBe("?trigger=manual&range=7d");
    fireEvent.click(screen.getByLabelText("ArgoCD"));
    expect(new URLSearchParams(window.location.search).get("source")).toBe("argocd");
    const actor = screen.getByLabelText("Actor");
    fireEvent.change(actor, { target: { value: "bob" } });
    fireEvent.blur(actor);
    expect(new URLSearchParams(window.location.search).get("actor")).toBe("bob");
    await waitFor(() => {
      const last = new URL(requests.filter((r) => r.startsWith("/api/events")).at(-1)!, "http://x");
      expect(last.searchParams.get("actor")).toBe("bob");
      expect(last.searchParams.get("trigger")).toBe("manual");
      expect(last.searchParams.get("source")).toBe("argocd");
    });
    // No export or audit verification in the open-source UI (ADR 0008).
    expect(screen.queryByText("Export")).toBeNull();
    expect(screen.queryByRole("button", { name: /verify/i })).toBeNull();
  });

  it("shows an error with retry when the API fails", async () => {
    setFetch(async (url) => {
      requests.push(url);
      if (url.startsWith("/api/connections"))
        return new Response('{"connections":[]}', { status: 200 });
      return new Response(
        JSON.stringify({ error: "bad_request", message: "cursor does not match" }),
        {
          status: 400,
        },
      );
    });
    render(<App />);
    expect(await screen.findByText("cursor does not match")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("explains what to do when nothing is connected", async () => {
    setFetch(
      async (url) =>
        new Response(
          JSON.stringify(
            url.startsWith("/api/connections")
              ? { connections: [] }
              : { items: [], nextCursor: null, snapshotSeq: 0 },
          ),
          { status: 200 },
        ),
    );
    window.history.replaceState(null, "", "/events");
    render(<App />);
    expect(await screen.findByText("Nothing recorded yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Connect GitHub, ArgoCD or Vercel/ })).toBeTruthy();
  });
});
