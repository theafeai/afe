// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../App.tsx";
import { setFetch } from "../api/client.ts";
afterEach(cleanup);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
it("selects structured user rows and keeps management and status updates working", async () => {
  const longName = `generated_${"long_username_".repeat(6)}`;
  const users = [
    { id: "u1", username: "alice", disabled: false, email: "alice@example.com" },
    { id: "u2", username: longName, disabled: true },
  ];
  const writes: { url: string; method: string; body: unknown }[] = [];
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/email") return json({ enabled: false, configured: false });
    if (init?.method === "PATCH" || init?.method === "POST") {
      writes.push({ url, method: init.method, body: init.body && JSON.parse(String(init.body)) });
      if (init.method === "PATCH") users[1]!.disabled = false;
      return json({ token: "replacement-credential" });
    }
    if (url === "/api/admin/users") return json({ users });
    if (url.endsWith("/permissions")) return json({ tools: initialTools() });
    throw new Error(`Unexpected API call: ${url}`);
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  await screen.findByText("alice@example.com");
  const list = screen.getByRole("list", { name: "User accounts" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("alice@example.com")).toBeTruthy();
  const alice = within(list).getByRole("button", { name: "alice" });
  const generated = within(list).getByRole("button", { name: longName });
  expect(alice.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(alice);
  expect(alice.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(generated);
  expect(alice.getAttribute("aria-pressed")).toBe("false");
  expect(generated.getAttribute("aria-pressed")).toBe("true");
  expect(document.getElementById(generated.getAttribute("aria-controls")!)?.textContent).toContain(
    longName,
  );
  expect(within(generated).getByText("Disabled")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Enable user" }));
  const reloaded = await screen.findByRole("button", { name: longName });
  expect(reloaded.getAttribute("aria-pressed")).toBe("true");
  await waitFor(() =>
    expect(within(screen.getByRole("button", { name: longName })).getByText("Active")).toBeTruthy(),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Reset credential" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset credential" }));
  expect(
    ((await screen.findByLabelText("Generated access credential")) as HTMLTextAreaElement).value,
  ).toBe("replacement-credential");
  expect(
    screen.getByRole("heading", { name: `Save the credential for ${longName} now` }),
  ).toBeTruthy();
  expect(writes).toEqual([
    { url: "/api/admin/users/u2", method: "PATCH", body: { disabled: false } },
    { url: "/api/admin/users/u2/credentials", method: "POST", body: undefined },
  ]);
});

it("shows users loading, a retryable error, and an actionable empty state", async () => {
  let finishLoad: (response: Response) => void = () => {};
  let first = true;
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/email") return json({ enabled: false, configured: false });
    if (url === "/api/admin/users") {
      if (!first) return json({ users: [] });
      first = false;
      return new Promise<Response>((resolve) => {
        finishLoad = resolve;
      });
    }
    throw new Error(`Unexpected API call: ${url}`);
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  await screen.findByText("Loading users…");
  expect(screen.queryByText("No users yet")).toBeNull();
  finishLoad(new Response(JSON.stringify({ message: "Temporarily unavailable" }), { status: 500 }));
  await screen.findByText("Users could not be loaded (HTTP 500)");
  expect(screen.queryByText("No users yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("No users yet");
  expect(screen.getByText("Create a user above to give someone access to Afe.")).toBeTruthy();
});

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
  expect(screen.getByRole("heading", { name: "Save the credential for alice now" })).toBeTruthy();
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

const initialTools = () =>
  Object.fromEntries(
    ["github", "vercel", "argocd", "terraform"].map((tool) => [
      tool,
      {
        mode: tool === "github" ? "source + custom" : "none",
        denied:
          tool === "github"
            ? [{ resource: "repository:theafeai/afe", action: "github.delete_run" }]
            : [],
        custom:
          tool === "github"
            ? [
                { resource: "repository:theafeai/afe", action: "read" },
                { resource: "repository:theafeai/afe", action: "github.logs_download" },
              ]
            : [],
      },
    ]),
  );

const sourceTools = (mode: string, repository = "") => ({
  ...initialTools(),
  github: {
    mode,
    custom: [],
    denied: repository ? [{ resource: repository, action: "github.cancel" }] : [],
  },
});

it("keeps the selected identity and settings together when an older load finishes late", async () => {
  let finishAlice: (response: Response) => void = () => {};
  let aliceSignal: AbortSignal | undefined;
  let aliceLoads = 0;
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/email") return json({ enabled: false, configured: false });
    if (url === "/api/admin/users")
      return json({
        users: [
          { id: "u1", username: "alice", disabled: false },
          { id: "u2", username: "bob", disabled: false },
        ],
      });
    if (url === "/api/admin/users/u1/permissions") {
      if (++aliceLoads > 1) return json({ tools: sourceTools("none") });
      aliceSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        finishAlice = resolve;
      });
    }
    if (url === "/api/admin/users/u2/permissions")
      return json({ tools: sourceTools("source", "repository:bob/app") });
    throw new Error(`Unexpected API call: ${url}`);
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  await screen.findByText("Select a user");
  fireEvent.click(await screen.findByRole("button", { name: "alice" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "alice", level: 2 }));
  expect(screen.getByText("Loading tool permissions for alice…")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "bob" }));
  const restrictions = await screen.findByLabelText("GitHub action restrictions");
  expect(screen.getByRole("region", { name: "bob" })).toBeTruthy();
  expect((restrictions as HTMLTextAreaElement).value).toBe("repository:bob/app github.cancel");
  expect(aliceSignal?.aborted).toBe(true);
  await act(async () => {
    finishAlice(json({ tools: sourceTools("source", "repository:alice/stale") }));
  });
  expect(screen.getByRole("heading", { name: "bob", level: 2 })).toBeTruthy();
  expect((restrictions as HTMLTextAreaElement).value).toBe("repository:bob/app github.cancel");
  fireEvent.change(restrictions, { target: { value: "repository:bob/draft github.cancel" } });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "alice" }));
  const fresh = await screen.findByLabelText("GitHub action restrictions");
  expect((fresh as HTMLTextAreaElement).value).toBe("");
  expect(
    (screen.getByLabelText("Permission mode", { selector: "#mode-github" }) as HTMLSelectElement)
      .value,
  ).toBe("none");
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(screen.queryByRole("form", { name: "GitHub permissions for bob" })).toBeNull();
});

it("names the user in save feedback and keeps selection fixed until the save completes", async () => {
  let finishSave: (response: Response) => void = () => {};
  const writes: { url: string; body: unknown }[] = [];
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/email") return json({ enabled: false, configured: false });
    if (url === "/api/admin/users")
      return json({
        users: [
          { id: "u1", username: "alice", disabled: false },
          { id: "u2", username: "bob", disabled: false },
        ],
      });
    if (init?.method === "PUT") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      return new Promise<Response>((resolve) => {
        finishSave = resolve;
      });
    }
    if (url.endsWith("/permissions")) return json({ tools: sourceTools("none") });
    throw new Error(`Unexpected API call: ${url}`);
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "bob" }));
  const bobForm = await screen.findByRole("form", { name: "GitHub permissions for bob" });
  expect(within(bobForm).getByText("bob")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Save GitHub permissions" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Permission mode", { selector: "#mode-github" }), {
    target: { value: "source" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save GitHub permissions" }));
  expect(bobForm.getAttribute("aria-busy")).toBe("true");
  expect((screen.getByRole("button", { name: "alice" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "alice" }));
  expect(screen.getByRole("heading", { name: "bob", level: 2 })).toBeTruthy();
  finishSave(json({ ok: true }));
  await screen.findByText("Saved GitHub permissions for bob.");
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(bobForm.querySelector(".badge")?.textContent).toBe("Linked tool account");
  fireEvent.click(screen.getByRole("button", { name: "alice" }));
  const aliceForm = await screen.findByRole("form", { name: "GitHub permissions for alice" });
  fireEvent.change(screen.getByLabelText("Permission mode", { selector: "#mode-github" }), {
    target: { value: "source" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save GitHub permissions" }));
  finishSave(
    new Response(JSON.stringify({ message: "Permission update rejected" }), { status: 400 }),
  );
  await screen.findByText("GitHub permissions for alice were not saved (HTTP 400)");
  expect(within(aliceForm).getByText("Unsaved changes")).toBeTruthy();
  expect(
    (screen.getByLabelText("Permission mode", { selector: "#mode-github" }) as HTMLSelectElement)
      .value,
  ).toBe("source");
  expect(writes).toEqual([
    {
      url: "/api/admin/users/u2/permissions/github",
      body: { mode: "source", denied: [], custom: [] },
    },
    {
      url: "/api/admin/users/u1/permissions/github",
      body: { mode: "source", denied: [], custom: [] },
    },
  ]);
});

it("requires explicit review of blocked legacy policies and saves only inherited access", async () => {
  const writes: unknown[] = [];
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/users")
      return json({ users: [{ id: "u1", username: "alice", disabled: false }] });
    if (url === "/api/admin/email") return json({ enabled: false, configured: false });
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body as string));
      return json({ ok: true });
    }
    if (url.endsWith("/permissions")) return json({ tools: initialTools() });
    throw new Error(`Unexpected API call: ${url}`);
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "alice" }));
  const mode = await screen.findByLabelText("Permission mode", { selector: "#mode-github" });
  expect(screen.queryByLabelText("Resource grants")).toBeNull();
  expect(screen.getByText(/Existing source \+ custom policy is blocked/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Save GitHub permissions" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    [...(mode as HTMLSelectElement).options].filter((o) => !o.disabled).map((o) => o.value),
  ).toEqual(["none", "source"]);
  fireEvent.change(mode, { target: { value: "source" } });
  expect(screen.queryByLabelText("Resource grants", { selector: "#grants-github" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save GitHub permissions" }));
  await screen.findByText("Saved GitHub permissions for alice.");
  expect(writes).toEqual([
    {
      mode: "source",
      custom: [],
      denied: initialTools().github!.denied,
    },
  ]);
  expect(screen.getByRole("region", { name: "Notifications" }).textContent).toContain(
    "Saved GitHub permissions for alice.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
});

it("shows permission loading and retry, keeps failed drafts, and disables controls while saving", async () => {
  let failLoad = true;
  let finishSave: ((r: Response) => void) | undefined;
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/users")
      return json({ users: [{ id: "u1", username: "alice", disabled: false }] });
    if (url === "/api/admin/email") return json({ enabled: false, configured: false });
    if (init?.method === "PUT")
      return new Promise<Response>((resolve) => {
        finishSave = resolve;
      });
    if (url.endsWith("/permissions")) {
      if (failLoad) {
        failLoad = false;
        return new Response(JSON.stringify({ message: "Try loading again" }), { status: 500 });
      }
      return json({ tools: initialTools() });
    }
    throw new Error(`Unexpected API call: ${url}`);
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "alice" }));
  expect(screen.getByText("Loading tool permissions for alice…")).toBeTruthy();
  await screen.findByText("Tool permissions for alice could not be loaded (HTTP 500)");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const grants = (await screen.findByLabelText(
    "GitHub action restrictions",
  )) as HTMLTextAreaElement;
  fireEvent.change(screen.getByLabelText("Permission mode", { selector: "#mode-github" }), {
    target: { value: "source" },
  });
  fireEvent.change(grants, { target: { value: "repository:theafeai/afe github.cancel" } });
  fireEvent.click(screen.getByRole("button", { name: "Save GitHub permissions" }));
  expect(grants.closest("fieldset")!.disabled).toBe(true);
  finishSave!(new Response(JSON.stringify({ message: "Grant rejected" }), { status: 400 }));
  await screen.findByText("GitHub permissions for alice were not saved (HTTP 400)");
  expect(grants.value).toBe("repository:theafeai/afe github.cancel");
  expect(grants.closest("fieldset")!.disabled).toBe(false);
  fireEvent.change(grants, { target: { value: "" } });
  expect(grants.value).toBe("");
});

it("lets administrators layer optional GitHub restrictions on Source without duplicate grants", async () => {
  let saved: unknown;
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json({ principal: { id: "admin", roles: ["admin"], kind: "session" } });
    if (url === "/api/admin/email")
      return json({ enabled: false, configured: false, deliveries: [] });
    if (url === "/api/admin/users")
      return json({ users: [{ id: "u1", username: "alice", disabled: false }] });
    if (url === "/api/admin/users/u1/permissions")
      return json({
        tools: Object.fromEntries(
          ["github", "vercel", "argocd", "terraform"].map((tool) => [
            tool,
            {
              mode: tool === "github" ? "source" : "none",
              custom: [],
              denied:
                tool === "github"
                  ? [{ resource: "repository:acme/app", action: "github.delete_run" }]
                  : [],
            },
          ]),
        ),
      });
    if (url === "/api/admin/users/u1/permissions/github" && init?.method === "PUT") {
      saved = JSON.parse(String(init.body));
      return json({ ok: true });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "alice" }));
  const field = await screen.findByLabelText("GitHub action restrictions");
  expect((field as HTMLTextAreaElement).value).toBe("repository:acme/app github.delete_run");
  fireEvent.change(field, { target: { value: "repository:acme/app github.environment_delete" } });
  fireEvent.click(screen.getByRole("button", { name: "Save GitHub permissions" }));
  await screen.findByText("Saved GitHub permissions for alice.");
  expect(saved).toEqual({
    mode: "source",
    custom: [],
    denied: [{ resource: "repository:acme/app", action: "github.environment_delete" }],
  });
});
