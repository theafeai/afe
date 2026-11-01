// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import { useLocation, Router } from "../router.tsx";
import { AccessContext } from "../access.tsx";
import { setFetch } from "../api/client.ts";
import type { ConnectionWithHealth, SessionInfo } from "../api/types.ts";
import { ConnectionDetail, Connections } from "./Connections.tsx";
import { DisconnectAction } from "./DisconnectAction.tsx";

beforeAll(() => {
  // jsdom has no native dialog implementation; browser behavior is checked separately.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/connections");
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const connection = (source = "github"): ConnectionWithHealth => ({
  id: "c1",
  name: "production",
  source,
  externalId: "1",
  status: "active",
  statusReason: null,
  createdAt: null,
  health: {
    state: "healthy",
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastErrorReason: null,
    lastError: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    openGap: null,
    lastBackfill: null,
  },
  alert: null,
});

it.each(["github", "argocd", "vercel", "terraform"])(
  "warns and cancels without disconnecting %s",
  (source) => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return json(200, {});
    });
    render(
      <DisconnectAction
        connection={connection(source)}
        onDone={() => {
          throw new Error("Cancelled");
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect production" }));
    expect(screen.getByRole("dialog", { name: /production/ })).toBeTruthy();
    expect(screen.getByText(/Recorded events remain/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toBe(0);
  },
);

it("shows failures in the dialog, prevents duplicate requests, then removes the connection and confirms success", async () => {
  let attempts = 0;
  let disconnected = false;
  let finish: ((r: Response) => void) | undefined;
  setFetch(async (url, init) => {
    if (init?.method === "DELETE") {
      expect(url).toBe("/api/connections/github/c1");
      attempts++;
      if (attempts === 1) return json(500, { message: "Temporary failure" });
      return new Promise<Response>((resolve) => {
        finish = (r) => {
          disconnected = true;
          resolve(r);
        };
      });
    }
    return json(200, {
      connections: disconnected ? [] : [connection()],
    });
  });
  render(
    <Router>
      <Connections />
    </Router>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect production" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect connection" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect connection" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnecting…" }));
  expect(attempts).toBe(2);
  finish!(json(200, { note: "The GitHub App remains installed." }));
  expect(await screen.findByText(/production.*disconnected/)).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Disconnect production" })).toBeNull(),
  );
  expect(screen.queryByRole("link", { name: "production" })).toBeNull();
  expect(await screen.findByText("No tools connected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("No tools connected")).toBeTruthy();
});

it("hides disconnect actions from viewers", async () => {
  setFetch(async () => json(200, { connections: [connection()] }));
  const session = {
    principal: { id: "viewer", roles: ["viewer"], kind: "session", tenantId: "default" },
  } as SessionInfo;
  render(
    <AccessContext.Provider value={{ session, profile: null }}>
      <Router>
        <Connections />
      </Router>
    </AccessContext.Provider>,
  );
  await screen.findByText("production");
  expect(screen.queryByRole("button", { name: /Disconnect/ })).toBeNull();
});

it.each(["github", "argocd", "vercel", "terraform"])(
  "confirms only the selected %s connection",
  async (source) => {
    let notice = "";
    setFetch(async (url, init) => {
      expect(url).toBe(`/api/connections/${source}/c1`);
      expect(init?.method).toBe("DELETE");
      return json(200, { note: "Source cleanup instructions." });
    });
    render(
      <DisconnectAction
        connection={connection(source)}
        onDone={(note) => {
          notice = note;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect production" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect connection" }));
    await waitFor(() => expect(notice).toContain("production” disconnected."));
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

function ConnectionRoutes() {
  const location = useLocation();
  return location.pathname === "/connections/c1" ? <ConnectionDetail id="c1" /> : <Connections />;
}

it.each(["github", "argocd", "vercel", "terraform"])(
  "redirects a successful %s detail disconnect with confirmation; failures stay on detail",
  async (source) => {
    window.history.replaceState(null, "", "/connections/c1");
    const c = connection(source);
    let disconnected = false;
    let fail = true;
    setFetch(async (url, init) => {
      if (init?.method === "DELETE") {
        if (fail) return json(500, { message: "Temporary failure" });
        disconnected = true;
        return json(200, { note: "Recorded events remain." });
      }
      if (url.endsWith("/health")) return json(200, { connection: c, gaps: [], alerts: [] });
      return json(200, { connections: disconnected ? [] : [c] });
    });
    render(
      <Router>
        <ConnectionRoutes />
      </Router>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect production" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect connection" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(window.location.pathname).toBe("/connections/c1");
    expect(screen.queryByText(/production.*disconnected/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Disconnect connection" }));
    expect(await screen.findByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(window.location.pathname).toBe("/connections");
    expect(screen.getByText(/production.*disconnected/)).toBeTruthy();
    expect(await screen.findByText("No tools connected")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "production" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/production.*disconnected/)).toBeNull();
    expect(window.location.search).toBe("");
  },
);
