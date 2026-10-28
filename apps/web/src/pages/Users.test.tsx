// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../App.tsx";
import { setFetch } from "../api/client.ts";
afterEach(cleanup);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
it("lets admins create a user and dismiss their one-time credential", async () => {
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/users" && init?.method === "POST")
      return json({
        user: { id: "u1", username: "alice", disabled: false },
        token: "one-time-credential",
      });
    if (url === "/api/admin/users") return json({ users: [] });
    throw new Error("Unexpected API call");
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.click(screen.getByRole("button", { name: "Create user" }));
  expect(
    ((await screen.findByLabelText("Generated access credential")) as HTMLTextAreaElement).value,
  ).toBe("one-time-credential");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss credential" }));
  expect(screen.queryByLabelText("Generated access credential")).toBeNull();
});
it("hides unavailable tools, admin management, export and raw evidence for managed users", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({
        principal: { id: "local", roles: ["viewer"], kind: "session", managedUser: true },
      });
    if (url === "/api/profile")
      return json({
        managedUser: true,
        tools: [{ tool: "github", mode: "custom", linked: false, sourceEnabled: false }],
      });
    if (url === "/api/connections") return json({ connections: [] });
    if (url.startsWith("/api/events")) return json({ items: [], nextCursor: null, snapshotSeq: 0 });
    throw new Error("Unexpected API call");
  });
  window.history.replaceState(null, "", "/events");
  render(<App />);
  await screen.findByRole("heading", { name: "Events" });
  await waitFor(() => expect(screen.getByLabelText("GitHub")).toBeTruthy());
  expect(screen.queryByLabelText("ArgoCD")).toBeNull();
  expect(screen.queryByLabelText("Vercel")).toBeNull();
  expect(screen.queryByRole("link", { name: "Users" })).toBeNull();
  expect(screen.queryByText("Export")).toBeNull();
  expect(screen.queryByRole("button", { name: "Verify audit log" })).toBeNull();
});
it("profile shows assigned source login and keeps unassigned tools hidden", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({
        principal: { id: "local", roles: ["viewer"], kind: "session", managedUser: true },
      });
    if (url === "/api/profile")
      return json({
        managedUser: true,
        tools: [
          {
            tool: "github",
            mode: "source",
            linked: false,
            sourceEnabled: true,
            oauthAvailable: true,
          },
        ],
      });
    throw new Error("Unexpected API call");
  });
  window.history.replaceState(null, "", "/profile");
  render(<App />);
  expect(await screen.findByRole("button", { name: "Sign in with GitHub" })).toBeTruthy();
  expect(screen.queryByText("vercel")).toBeNull();
  expect(screen.queryByText("argocd")).toBeNull();
});
it("managed mapping is read-only and does not request tenant-wide rule previews", async () => {
  const requested: string[] = [];
  setFetch(async (url) => {
    requested.push(url);
    if (url === "/api/session")
      return json({
        principal: { id: "local", roles: ["viewer"], kind: "session", managedUser: true },
      });
    if (url === "/api/profile") return json({ managedUser: true, tools: [] });
    if (url === "/api/mapping")
      return json({
        readOnly: true,
        services: [{ id: "web", name: "Visible Web" }],
        environments: [{ id: "prod", name: "Production" }],
        rules: [],
        builtinRules: [],
      });
    throw new Error("Unexpected request");
  });
  window.history.replaceState(null, "", "/settings/mapping");
  render(<App />);
  expect(await screen.findByText("Visible Web")).toBeTruthy();
  expect(screen.getByText("Production")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Add service/ })).toBeNull();
  expect(requested).not.toContain("/api/mapping/preview");
});
it("managed environment landing page shows an access empty state without hidden-tool setup links", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({
        principal: { id: "local", roles: ["viewer"], kind: "session", managedUser: true },
      });
    if (url === "/api/profile") return json({ managedUser: true, tools: [] });
    if (url === "/api/connections") return json({ connections: [] });
    if (url === "/api/environments/state")
      return json({
        services: [],
        environments: [],
        cells: [],
        window: {
          from: "2026-10-01T00:00:00Z",
          to: "2026-10-28T00:00:00Z",
          events: 0,
          asOfSeq: 0,
          stale: false,
          truncated: false,
        },
      });
    if (url === "/api/drift/summary") return json({ open: 0, cells: [], targets: [] });
    throw new Error("Unexpected request");
  });
  window.history.replaceState(null, "", "/");
  render(<App />);
  expect(await screen.findByText("No permitted deployments")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "GitHub" })).toBeNull();
  expect(screen.queryByRole("link", { name: "ArgoCD" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Vercel" })).toBeNull();
});
