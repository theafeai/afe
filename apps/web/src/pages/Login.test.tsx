// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { api, setFetch } from "../api/client.ts";
import { App } from "../App.tsx";
import { safeNext } from "./Login.tsx";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const session = (roles: ("admin" | "viewer")[] = ["admin"]) => ({
  principal: { id: "admin-token:1", tenantId: "default", roles, kind: "session", name: null },
  csrfToken: "csrf-1",
  expiresAt: "2026-10-28T00:00:00.000Z",
});

afterEach(() => {
  cleanup();
  document.cookie = "afe_csrf=; max-age=0; path=/";
});

describe("login", () => {
  it("shows the login screen on 401, signs in with the token and loads the app", async () => {
    let signedIn = false;
    const calls: { method: string; url: string; body?: string }[] = [];
    setFetch(async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, ...(init?.body ? { body: String(init.body) } : {}) });
      if (url === "/api/session" && method === "POST") {
        signedIn = true;
        return json(201, session());
      }
      if (!signedIn)
        return json(401, { error: "unauthorized", message: "Authentication required." });
      if (url === "/api/session") return json(200, session());
      if (url.startsWith("/api/connections")) return json(200, { connections: [] });
      return json(200, { items: [], nextCursor: null, snapshotSeq: 0 });
    });
    window.history.replaceState(null, "", "/events");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in to Afe" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: " tok-123 " } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toBe('{"token":"tok-123"}');
    // The token is never kept in browser storage.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith("/api/events") && c.method === "GET")).toBe(true),
    );
  });

  it("returns to the login screen when the session ends, and signs out", async () => {
    let expired = false;
    let loggedOut = false;
    setFetch(async (url, init) => {
      if (url === "/api/session" && init?.method === "DELETE") {
        loggedOut = true;
        return json(200, { ok: true });
      }
      if (url === "/api/session") return json(200, session(["viewer"]));
      if (expired) return json(401, { error: "unauthorized" });
      if (url.startsWith("/api/connections")) return json(200, { connections: [] });
      return json(200, { items: [], nextCursor: null, snapshotSeq: 0 });
    });
    window.history.replaceState(null, "", "/connections");
    render(<App />);
    expect(await screen.findByText("Viewer (read-only)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to Afe" })).toBeTruthy();
    expect(loggedOut).toBe(true);

    cleanup();
    render(<App />);
    expect(await screen.findByText("Viewer (read-only)")).toBeTruthy();
    expired = true;
    await api.connections().catch(() => {});
    expect(await screen.findByRole("heading", { name: "Sign in to Afe" })).toBeTruthy();
  });

  it("sends the CSRF token from the cookie on mutating requests only", async () => {
    const seen: { method: string; csrf: string | undefined }[] = [];
    setFetch(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ method: init?.method ?? "GET", csrf: headers["x-afe-csrf"] });
      return json(200, { connections: [] });
    });
    document.cookie = "afe_csrf=csrf-abc; path=/";
    await api.connections();
    await api.argocdDisconnect("c1").catch(() => {});
    expect(seen).toEqual([
      { method: "GET", csrf: undefined },
      { method: "DELETE", csrf: "csrf-abc" },
    ]);
  });

  it("only follows same-origin next paths", () => {
    expect(safeNext("/api/connections/github/setup?installation_id=1")).toBe(
      "/api/connections/github/setup?installation_id=1",
    );
    expect(safeNext("/events")).toBe("/events");
    for (const bad of [null, "", "//evil.example", "https://evil.example", "/\\evil", "events"]) {
      expect(safeNext(bad), String(bad)).toBeNull();
    }
  });
});
