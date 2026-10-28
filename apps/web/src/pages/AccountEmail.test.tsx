// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../App.tsx";
import { setFetch } from "../api/client.ts";
afterEach(cleanup);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
it("keeps link confirmation public, strips the fragment, and redeems only after Continue", async () => {
  const calls: string[] = [];
  setFetch(async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    if (url === "/api/session") return json({ error: "unauthorized" }, 401);
    if (url === "/api/account/redeem") {
      expect(JSON.parse(init!.body as string)).toEqual({ token: "one-time-link" });
      return json({ token: "new-access-credential" });
    }
    throw new Error("Unexpected call");
  });
  window.history.replaceState(null, "", "/account/accept#one-time-link");
  render(<App />);
  await screen.findByRole("button", { name: "Continue" });
  expect(window.location.hash).toBe("");
  expect(calls.some((c) => c.endsWith("/api/account/redeem"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    ((await screen.findByLabelText("New access credential")) as HTMLTextAreaElement).value,
  ).toBe("new-access-credential");
});
it("shows the same reset confirmation for any email without exposing account details", async () => {
  setFetch(async (url, init) => {
    if (url === "/api/session") return json({ error: "unauthorized" }, 401);
    expect(url).toBe("/api/account/reset");
    expect(JSON.parse(init!.body as string)).toEqual({ email: "alice@example.com" });
    return json({ ok: true }, 202);
  });
  window.history.replaceState(null, "", "/account/reset");
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Email address"), {
    target: { value: "alice@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Email reset link" }));
  expect(await screen.findByRole("status")).toBeTruthy();
});
it("lets administrators invite users without exposing a generated credential", async () => {
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/email")
      return json({ enabled: true, configured: true, from: "afe@example.com", deliveries: [] });
    if (url === "/api/admin/users") return json({ users: [] });
    if (url === "/api/admin/users/invite") {
      expect(JSON.parse(init!.body as string)).toEqual({
        username: "alice",
        email: "alice@example.com",
      });
      return json({ user: { id: "u1", username: "alice", email: "alice@example.com" } }, 201);
    }
    throw new Error("Unexpected call");
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.click(await screen.findByLabelText("Send an invitation by email"));
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "alice@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Invite user" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Invitation queued"),
  );
  expect(screen.queryByLabelText("Generated access credential")).toBeNull();
});
