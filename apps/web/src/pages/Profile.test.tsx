// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../App.tsx";
import { setFetch } from "../api/client.ts";

afterEach(cleanup);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("lets administrators link GitHub directly and then manage operation grants", async () => {
  let linked = false;
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/profile/tools/github/token") {
      expect(JSON.parse(init!.body as string)).toEqual({ token: "fixture-personal-token" });
      linked = true;
      return json({ ok: true });
    }
    if (url === "/api/profile")
      return json({
        managedUser: linked,
        administratorGitHub: { username: linked ? "github-admin-fixture" : null },
        tools: [
          {
            tool: "github",
            mode: "source",
            linked,
            accountName: linked ? "octocat" : null,
            sourceEnabled: true,
            sourceAvailable: true,
            oauthAvailable: false,
          },
        ],
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/profile");
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Personal access token"), {
    target: { value: "fixture-personal-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Link account" }));
  await screen.findByText(/Linked as octocat/);
  expect(screen.getAllByRole("link", { name: "Users" })[0]!.getAttribute("href")).toBe("/users");
  expect(screen.getByText("github-admin-fixture")).toBeTruthy();
  expect((screen.getByLabelText("Personal access token") as HTMLInputElement).value).toBe("");
  expect(screen.queryByText(/No tools are assigned/)).toBeNull();
});

it("does not send static viewers to administrator settings", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({ principal: { id: "viewer", roles: ["viewer"], kind: "session" } });
    if (url === "/api/profile") return json({ managedUser: false, tools: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/profile");
  render(<App />);
  await screen.findByText(/Ask your administrator to create a named user/);
  expect(screen.queryByRole("link", { name: "Open Users" })).toBeNull();
});

it("keeps the unassigned-tools state for managed users", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({
        principal: { id: "local", roles: ["viewer"], kind: "session", managedUser: true },
      });
    if (url === "/api/profile") return json({ managedUser: true, tools: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/profile");
  render(<App />);
  await screen.findByText(/No tools are assigned/);
  expect(screen.queryByRole("heading", { name: "A personal user account is required" })).toBeNull();
});

it("shows a failed profile request without misleading account setup guidance", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/profile") return json({ message: "Profile unavailable" }, 500);
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/profile");
  render(<App />);
  await screen.findByText("Profile unavailable");
  expect(screen.queryByText(/No tools are assigned/)).toBeNull();
  expect(screen.queryByRole("link", { name: "Open Users" })).toBeNull();
});

it("shows token rejections and keeps the GitHub token guidance tied to the field", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/profile/tools/github/token")
      return json({ message: "GitHub rejected the token" }, 400);
    if (url === "/api/profile")
      return json({
        managedUser: true,
        tools: [
          {
            tool: "github",
            mode: "source",
            linked: false,
            accountName: null,
            sourceEnabled: true,
            sourceAvailable: true,
            oauthAvailable: false,
          },
        ],
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/profile");
  render(<App />);
  const input = (await screen.findByLabelText("Personal access token")) as HTMLInputElement;
  expect(screen.getByRole("heading", { name: "GitHub" })).toBeTruthy();
  const help = document.getElementById(input.getAttribute("aria-describedby")!);
  expect(help?.textContent).toMatch(/Actions read and write/);
  fireEvent.change(input, { target: { value: "fixture-bad-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Link account" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /Account not linked.*GitHub rejected the token/,
  );
  expect(screen.queryByRole("status", { name: /linked/ })).toBeNull();
});

it("offers GitHub sign-in without workflow editing consent", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/profile")
      return json({
        managedUser: true,
        tools: [
          {
            tool: "github",
            mode: "source",
            linked: false,
            sourceEnabled: true,
            sourceAvailable: true,
            oauthAvailable: true,
          },
        ],
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/profile");
  render(<App />);
  await screen.findByRole("button", { name: "Sign in with GitHub" });
  expect(screen.queryByRole("checkbox", { name: /workflow/i })).toBeNull();
  expect(screen.getByText(/Contents read for workflow definitions/)).toBeTruthy();
});
