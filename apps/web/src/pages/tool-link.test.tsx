// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ReactNode } from "react";
import { ApiError, setFetch, toolLinkState } from "../api/client.ts";
import { Router } from "../router.tsx";
import { ToastProvider } from "../toast.tsx";
import { ArgoCdOperationsPage } from "./ArgoCdOperations.tsx";
import { GitHubOperationsPage } from "./GitHubOperations.tsx";
import { TerraformOperationsPage } from "./TerraformOperations.tsx";
import { VercelOperationsPage } from "./VercelOperations.tsx";

// AFE-118: without a linked tool account the pages show a calm empty state, not an error.
afterEach(cleanup);

const pages: [string, string, string, () => ReactNode][] = [
  ["vercel", "Vercel", "/api/actions/vercel/resources", () => <VercelOperationsPage />],
  ["terraform", "Terraform", "/api/actions/terraform/resources", () => <TerraformOperationsPage />],
  ["github", "GitHub", "/api/actions/github/resources?page=1", () => <GitHubOperationsPage />],
  ["argocd", "ArgoCD", "/api/actions/argocd/applications", () => <ArgoCdOperationsPage />],
];

function show(page: () => ReactNode, url: string, status: number, body: Record<string, unknown>) {
  setFetch(async (u) =>
    u === url
      ? Response.json(body, { status })
      : Response.json({ message: "unexpected" }, { status: 500 }),
  );
  render(
    <Router>
      <ToastProvider>{page()}</ToastProvider>
    </Router>,
  );
}

it.each(pages)(
  "%s: an unlinked account gets a link-your-account empty state",
  async (tool, name, url, page) => {
    show(page, url, 403, {
      error: "forbidden",
      reason: "tool_not_linked",
      tool,
      message: `Link your personal ${name} account in Profile.`,
    });
    expect(await screen.findByRole("heading", { name: `Link your ${name} account` })).toBeTruthy();
    const link = screen.getByRole("link", { name: `Link ${name} in Profile` });
    expect(link.getAttribute("href")).toBe("/profile");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/HTTP 403/)).toBeNull();
  },
);

it.each(pages)(
  "%s: a shared credential is told to sign in as a named user",
  async (tool, name, url, page) => {
    show(page, url, 403, {
      error: "forbidden",
      reason: "named_user_required",
      tool,
      message: "Sign in as a named Afe user.",
    });
    expect(
      await screen.findByRole("heading", { name: `Sign in as a named user to use ${name}` }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Profile" }).getAttribute("href")).toBe(
      "/profile",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it.each(pages)(
  "%s: a real permission error still shows as an error",
  async (_tool, name, url, page) => {
    show(page, url, 403, { message: `${name} source access is disabled for this user.` });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 403");
    expect(alert.textContent).toContain("source access is disabled");
  },
);

it("only recognises a 403 with a known reason and a tool", () => {
  const body = { reason: "tool_not_linked", tool: "vercel" };
  expect(toolLinkState(new ApiError(403, "forbidden", "x", body))).toEqual(body);
  expect(toolLinkState(new ApiError(401, "forbidden", "x", body))).toBeNull();
  expect(
    toolLinkState(new ApiError(403, "forbidden", "x", { reason: "rbac", tool: "vercel" })),
  ).toBeNull();
  expect(
    toolLinkState(new ApiError(403, "forbidden", "x", { reason: "tool_not_linked" })),
  ).toBeNull();
  expect(toolLinkState(new Error("x"))).toBeNull();
});
