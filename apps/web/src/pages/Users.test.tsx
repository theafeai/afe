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
