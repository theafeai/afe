// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { GITHUB_OPERATIONS } from "@afe/core/github-operations";
import { setFetch } from "../api/client.ts";
import { Router } from "../router.tsx";
import { GitHubOperationsPage } from "./GitHubOperations.tsx";
afterEach(cleanup);
const root = "/api/actions/github/repositories/acme/app";
function fixture({ uncertain = false, workflowGrant = true } = {}) {
  const mutations: Record<string, unknown>[] = [];
  setFetch(async (url, init) => {
    if (url.startsWith("/api/actions/github/resources"))
      return Response.json({
        items: [{ connectionId: "c", connectionName: "acme", repository: "acme/app" }],
        hasMore: false,
      });
    if (url === root + "/prepare")
      return Response.json({
        action: JSON.parse(String(init?.body)).action,
        version: "a".repeat(64),
        summary: "Dispatch workflow · acme/app · workflow:42",
        context: { connectionId: "c", repository: "acme/app" },
      });
    if (url === root && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      mutations.push(body);
      return Response.json(
        {
          requestId: body.requestId,
          action: body.action,
          state: uncertain ? "unknown" : "accepted",
          message: uncertain
            ? "Inspect the source state before recovery."
            : "GitHub accepted the request.",
        },
        { status: uncertain ? 502 : 202 },
      );
    }
    const q = new URL(url, "http://afe.test").searchParams;
    const view = q.get("view");
    if (view === "capabilities")
      return Response.json({
        items: GITHUB_OPERATIONS.map(([action, label, group, destructive]) => ({
          action,
          label,
          group,
          destructive,
          enabled: workflowGrant || action !== "github.dispatch",
          reason: workflowGrant ? null : "Requires explicit dispatch permission.",
        })),
      });
    if (view === "workflows")
      return Response.json({
        items: [{ id: 42, name: "Deploy", path: ".github/workflows/deploy.yml", state: "active" }],
        page: 1,
        hasMore: false,
      });
    if (view === "workflow_file")
      return Response.json({
        path: ".github/workflows/deploy.yml",
        sha: "a".repeat(40),
        dispatchable: true,
        inputs: [
          { name: "deploy", type: "boolean", required: true, description: "Deploy now" },
          {
            name: "region",
            type: "choice",
            required: true,
            description: "Region",
            options: ["east", "west"],
            default: "east",
          },
        ],
      });
    if (view === "history")
      return Response.json({
        items: [
          {
            requestId: "r",
            action: "github.dispatch",
            state: "unknown",
            message: "Inspect the source state before recovery.",
          },
        ],
        page: 1,
        hasMore: false,
      });
    if (view === "branches" || view === "tags")
      return Response.json({ items: [{ id: 1, name: "main" }], page: 1, hasMore: false });
    if (view === "environments")
      return Response.json({ items: [{ id: 9, name: "production" }], page: 1, hasMore: false });
    throw new Error(`Unexpected request ${url}`);
  });
  window.history.replaceState(null, "", "/github?connectionId=c&repository=acme%2Fapp");
  render(
    <Router>
      <GitHubOperationsPage />
    </Router>,
  );
  return mutations;
}
it("renders typed inputs and requires confirmation before one deliberate dispatch", async () => {
  const mutations = fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Open details" }));
  fireEvent.click(await screen.findByRole("button", { name: "Prepare dispatch" }));
  const confirm = await screen.findByRole("group", { name: "Confirm GitHub operation" });
  expect(mutations).toHaveLength(0);
  expect(within(confirm).getByText(/acme\/app/)).toBeTruthy();
  fireEvent.click(within(confirm).getByRole("button", { name: "Confirm operation" }));
  fireEvent.click(within(confirm).getByRole("button", { name: "Confirm operation" }));
  await screen.findByText("GitHub accepted the request.");
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({
    confirmed: true,
    params: { workflowId: 42, ref: "main", inputs: { deploy: false, region: "east" } },
  });
});
it("disables dispatch when the required grant is absent", async () => {
  fixture({ workflowGrant: false });
  fireEvent.click(await screen.findByRole("button", { name: "Open details" }));
  expect(
    ((await screen.findByRole("button", { name: "Prepare dispatch" })) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("retains uncertain outcomes in Afe and asks for explicit risk acknowledgement during recovery", async () => {
  fixture({ uncertain: true });
  fireEvent.click(await screen.findByRole("button", { name: "Open details" }));
  fireEvent.click(await screen.findByRole("button", { name: "Prepare dispatch" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm operation" }));
  await screen.findByText("unknown");
  fireEvent.click(screen.getByRole("button", { name: "Inspect request history" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review recovery" }));
  const recovery = screen.getByRole("button", {
    name: "Allow a new deliberate request",
  }) as HTMLButtonElement;
  expect(recovery.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the current source state/ }));
  await waitFor(() => expect(recovery.disabled).toBe(false));
});
