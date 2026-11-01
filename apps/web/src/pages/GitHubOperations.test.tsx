// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { GITHUB_OPERATIONS } from "@afe/core/github-operations";
import { setFetch } from "../api/client.ts";
import { Router } from "../router.tsx";
import { GitHubOperationsPage } from "./GitHubOperations.tsx";
afterEach(cleanup);
const root = "/api/actions/github/repositories/acme/app";
function fixture({ uncertain = false, workflowGrant = true, runError = false } = {}) {
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
    if (view === "runs")
      return Response.json({
        items:
          q.get("page") === "2"
            ? []
            : [101, 102, 103].map((id) => ({
                id,
                name: `Deploy ${id}`,
                status: "completed",
                conclusion: "success",
                run_attempt: 2,
                head_branch: "main",
              })),
        page: Number(q.get("page") ?? 1),
        hasMore: q.get("page") !== "2",
      });
    if (view === "run")
      return runError
        ? Response.json({ message: "Run details unavailable" }, { status: 503 })
        : Response.json({
            item: {
              id: Number(q.get("id")),
              run_attempt: 2,
              status: "completed",
              conclusion: "success",
              html_url: `https://github.com/acme/app/actions/runs/${q.get("id")}`,
            },
          });
    if (view === "jobs")
      return Response.json({
        items: [
          {
            id: 201,
            name: "Build and deploy",
            status: "completed",
            conclusion: "success",
            steps: [{ number: 1, name: "Build", status: "completed", conclusion: "success" }],
          },
        ],
        page: 1,
        hasMore: false,
      });
    if (view === "pending") return Response.json({ items: [], page: 1, hasMore: false });
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

it("expands run details directly after the selected row and moves or closes them in place", async () => {
  fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  await screen.findByText("Deploy 101");
  for (const id of [101, 102, 103]) {
    const row = screen.getByText(`Deploy ${id}`).closest("li")!;
    const open = within(row).getByRole("button", { name: "Open details" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    const details = await screen.findByRole("region", { name: `Run ${id}` });
    expect(screen.getAllByRole("region", { name: /^Run \d+$/ })).toHaveLength(1);
    expect(row.firstElementChild?.nextElementSibling?.contains(details)).toBe(true);
    if (id < 103) expect(row.nextElementSibling?.textContent).toContain(`Deploy ${id + 1}`);
    else expect(row.nextElementSibling).toBeNull();
    const close = within(row).getByRole("button", { name: "Hide details" });
    expect(close.getAttribute("aria-expanded")).toBe("true");
    expect(close.getAttribute("aria-controls")).toBe(details.parentElement?.id);
    await within(details).findByText(/Build and deploy/);
    expect(
      within(details).getByRole("link", { name: "Open source run" }).getAttribute("href"),
    ).toBe(`https://github.com/acme/app/actions/runs/${id}`);
    expect(within(details).getByRole("button", { name: "Re-run all jobs" })).toBeTruthy();
    expect(
      within(details)
        .getByRole("link", { name: /Download this attempt/ })
        .getAttribute("href"),
    ).toContain(`id=${id}&attempt=2`);
  }
  fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
  expect(screen.queryByRole("region", { name: /^Run \d+$/ })).toBeNull();
});
it("clears inline run details when changing pages or views", async () => {
  fixture();
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  fireEvent.click(
    within((await screen.findByText("Deploy 101")).closest("li")!).getByRole("button", {
      name: "Open details",
    }),
  );
  await screen.findByRole("region", { name: "Run 101" });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("No runs on this page");
  expect(screen.queryByRole("region", { name: /^Run \d+$/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  fireEvent.click(
    within((await screen.findByText("Deploy 101")).closest("li")!).getByRole("button", {
      name: "Open details",
    }),
  );
  await screen.findByRole("region", { name: "Run 101" });
  fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
  await screen.findByText("Deploy");
  expect(screen.queryByRole("region", { name: /^Run \d+$/ })).toBeNull();
});
it("keeps detail errors and job content beside the selected run", async () => {
  fixture({ runError: true });
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  fireEvent.click(
    within((await screen.findByText("Deploy 102")).closest("li")!).getByRole("button", {
      name: "Open details",
    }),
  );
  const details = await screen.findByRole("region", { name: "Run 102" });
  await within(details).findByText(/Run details unavailable/);
  await within(details).findByText(/Build and deploy/);
  expect(screen.getByText("Deploy 102").closest("li")?.contains(details)).toBe(true);
});

it("expands details directly beneath the selected row and collapses them again", async () => {
  fixture();
  const open = await screen.findByRole("button", { name: "Open details" });
  expect(open.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(open);
  const row = open.closest("li")!;
  const hide = within(row).getByRole("button", { name: "Hide details" });
  expect(hide.getAttribute("aria-expanded")).toBe("true");
  expect(await within(row).findByRole("button", { name: "Prepare dispatch" })).toBeTruthy();
  fireEvent.click(hide);
  expect(screen.queryByRole("button", { name: "Prepare dispatch" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open details" })).toBeTruthy();
});
