// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, setFetch } from "../api/client.ts";
import { App } from "../App.tsx";
import { matchPath } from "../router.tsx";
import { argocdErrorMessage } from "./Connect.tsx";

afterEach(() => cleanup());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("routes", () => {
  it("match the paths the server redirects to after install flows", () => {
    expect(
      matchPath("/connections/vercel/:id/projects", "/connections/vercel/abc/projects"),
    ).toEqual({
      id: "abc",
    });
    expect(matchPath("/connections/:id", "/connections/abc/")).toEqual({ id: "abc" });
    expect(matchPath("/events/:id", "/events")).toBeNull();
  });
});

describe("ArgoCD connect", () => {
  it("explains a write-capable token and TLS failures", () => {
    expect(
      argocdErrorMessage(
        new ApiError(422, "token_not_read_only", "the token can modify ArgoCD", {
          writeCapabilities: ["applications/sync on */*"],
        }),
      ),
    ).toMatch(/applications\/sync on \*\/\*/);
    expect(
      argocdErrorMessage(
        new ApiError(422, "connection_failed", "certificate error", { kind: "tls" }),
      ),
    ).toMatch(/CA certificate/);
  });

  it("posts the form and redirects with a confirmation", async () => {
    const posts: unknown[] = [];
    setFetch(async (url, init) => {
      if (url === "/api/session")
        return json(200, { principal: { id: "test", roles: ["admin"], kind: "session" } });
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(201, {
          connection: {
            id: "c1",
            name: "argocd.example.com",
            source: "argocd",
            status: "active",
            config: {},
          },
          server: { version: "v2.12.0" },
          account: { username: "afe", issuer: null },
          applicationCount: 3,
          readOnlyCheck: {
            status: "verified",
            writeCapabilities: [],
            sensitiveReadCapabilities: [],
            objectsChecked: [],
          },
          warnings: [],
        });
      }
      return json(200, { connections: [] });
    });
    window.history.replaceState(null, "", "/connections/argocd");
    render(<App />);
    await screen.findByLabelText("Server URL");
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://argocd.example.com" },
    });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and connect" }));
    expect(await screen.findByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(screen.getByText(/ArgoCD connection.*added/)).toBeTruthy();
    expect(window.location.pathname).toBe("/connections");
    expect(posts).toEqual([{ url: "https://argocd.example.com", token: "tok-secret" }]);
    expect(screen.queryByLabelText("API token")).toBeNull();
  });
});

describe("Vercel project selection", () => {
  it("loads projects and saves the chosen ids", async () => {
    const puts: unknown[] = [];
    setFetch(async (_url, init) => {
      if (_url === "/api/session")
        return json(200, { principal: { id: "test", roles: ["admin"], kind: "session" } });
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return json(200, { selection: { mode: "selected", projectIds: ["prj_web"] } });
      }
      return json(200, {
        selection: { mode: "none" },
        projects: [
          { id: "prj_web", name: "web", framework: "nextjs", updatedAt: 1, selected: false },
          { id: "prj_api", name: "api", framework: null, updatedAt: 1, selected: false },
        ],
      });
    });
    window.history.replaceState(null, "", "/connections/vercel/c9/projects");
    render(<App />);
    expect(await screen.findByText("no projects")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Only the projects I select"));
    fireEvent.click(screen.getByLabelText(/^web/));
    fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
    expect(await screen.findByText(/Afe now observes 1 selected project\./)).toBeTruthy();
    expect(puts).toEqual([{ projectIds: ["prj_web"] }]);
  });
});

const newConnection = {
  id: "c9",
  name: "new connection",
  source: "vercel",
  status: "active",
  config: {},
  health: { state: "unknown", lastSuccessAt: null, openGap: null },
};

it.each(["token", "integration"])(
  "redirects new Vercel %s setup only after saving successfully",
  async (flow) => {
    let fail = true;
    let finish: ((response: Response) => void) | undefined;
    setFetch(async (url, init) => {
      if (url === "/api/session")
        return json(200, { principal: { id: "test", roles: ["admin"], kind: "session" } });
      if (init?.method === "PUT") {
        if (fail) return json(500, { message: "Try saving again" });
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      if (url === "/api/connections") return json(200, { connections: [newConnection] });
      return json(200, { selection: { mode: "none" }, projects: [] });
    });
    window.history.replaceState(null, "", `/connections/vercel/c9/projects?new=${flow}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Save selection" }));
    expect(await screen.findByText("Try saving again")).toBeTruthy();
    expect(window.location.pathname).toBe("/connections/vercel/c9/projects");
    expect(screen.queryByText(/Vercel connection added/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
    expect(window.location.pathname).toBe("/connections/vercel/c9/projects");
    finish!(json(200, { selection: { mode: "none" } }));
    expect(await screen.findByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "new connection" })).toBeTruthy();
    const notice = screen.getByText("Vercel connection added. Afe now observes no projects.");
    expect(notice.querySelector("a")).toBeNull();
    expect(window.location.pathname).toBe("/connections");
    expect(window.location.search).toBe("");
  },
);

it("keeps failed ArgoCD setup on the form with an actionable error", async () => {
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return json(200, { principal: { id: "test", roles: ["admin"], kind: "session" } });
    if (init?.method === "POST")
      return json(422, { error: "connection_failed", message: "Certificate error", kind: "tls" });
    return json(200, { connections: [] });
  });
  window.history.replaceState(null, "", "/connections/argocd");
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Server URL"), {
    target: { value: "https://argocd.example.com" },
  });
  fireEvent.change(screen.getByLabelText("API token"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Check and connect" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("CA certificate"),
  );
  await waitFor(() => expect(window.location.pathname).toBe("/connections/argocd"));
  expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe(
    "https://argocd.example.com",
  );
});
