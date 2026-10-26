// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("posts the form, clears the token and shows the read-only check", async () => {
    const posts: unknown[] = [];
    setFetch(async (url, init) => {
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
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://argocd.example.com" },
    });
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and connect" }));
    expect(await screen.findByText("Read-only check passed.")).toBeTruthy();
    expect(posts).toEqual([{ url: "https://argocd.example.com", token: "tok-secret" }]);
    expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe("");
  });
});

describe("Vercel project selection", () => {
  it("loads projects and saves the chosen ids", async () => {
    const puts: unknown[] = [];
    setFetch(async (_url, init) => {
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
