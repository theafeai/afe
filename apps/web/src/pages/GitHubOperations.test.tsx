// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { GITHUB_OPERATIONS } from "@afe/core/github-operations";
import { setFetch } from "../api/client.ts";
import { Router } from "../router.tsx";
import { GitHubOperationsPage } from "./GitHubOperations.tsx";
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
const root = "/api/actions/github/repositories/acme/app";
function fixture({
  uncertain = false,
  workflowGrant = true,
  runError = false,
  logStatus = 200,
  logGrant = true,
  conclusion = "success",
  prepareStatus = 200,
  executeStatus = 202,
  holdMutation = false,
} = {}) {
  const mutations: Record<string, unknown>[] = [];
  setFetch(async (url, init) => {
    if (url.startsWith("/api/actions/github/resources"))
      return Response.json({
        items: [{ connectionId: "c", connectionName: "acme", repository: "acme/app" }],
        hasMore: false,
      });
    if (url === root + "/prepare") {
      if (prepareStatus !== 200)
        return Response.json({ message: "Source state unavailable" }, { status: prepareStatus });
      const { action, params } = JSON.parse(String(init?.body));
      return Response.json({
        action,
        version: "a".repeat(64),
        summary: `${action === "github.dispatch" ? "Dispatch workflow" : "Re-run all jobs"} · acme/app · ${params.runId ? `run:${params.runId} · attempt ${params.attempt}` : "workflow:42"}`,
        context: {
          connectionId: "c",
          repository: "acme/app",
          runId: params.runId,
          runAttempt: params.attempt,
        },
      });
    }
    if (url === root && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      mutations.push(body);
      if (holdMutation) return new Promise<Response>(() => {});
      if (executeStatus !== 202)
        return Response.json(
          { message: "Resource changed; refresh before retrying" },
          { status: executeStatus },
        );
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
          enabled:
            (workflowGrant || action !== "github.dispatch") &&
            (logGrant || action !== "github.logs_download"),
          reason:
            !logGrant && action === "github.logs_download"
              ? "Requires explicit log permission."
              : workflowGrant
                ? null
                : "Requires explicit dispatch permission.",
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
                conclusion,
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
              conclusion,
              html_url: `https://github.com/acme/app/actions/runs/${q.get("id")}`,
            },
          });
    if (view === "job_log")
      return logStatus === 200
        ? Response.json({ text: `Attempt ${q.get("attempt")} output <script>inert</script>` })
        : Response.json(
            {
              message:
                logStatus === 409
                  ? "Logs are still becoming available. Try again shortly."
                  : logStatus === 403
                    ? "Check Actions read permission."
                    : "Logs may be unavailable or expired.",
            },
            { status: logStatus },
          );
    if (view === "jobs")
      return Response.json({
        items: [
          {
            id: 201,
            name: "Build and deploy",
            status: "completed",
            conclusion,
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
  const confirm = await screen.findByRole("dialog", { name: "Dispatch workflow" });
  expect(mutations).toHaveLength(0);
  expect(within(confirm).getByText("acme/app")).toBeTruthy();
  fireEvent.click(within(confirm).getByRole("button", { name: "Dispatch workflow" }));
  fireEvent.click(within(confirm).getByRole("button", { name: "Dispatch workflow" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "Dispatch workflow" }));
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
    await within(details).findByText("Build and deploy");
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
  await within(details).findByText("Build and deploy");
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

it("loads every repository page, defaults automatically, remembers selection and rejects stale access", async () => {
  localStorage.clear();
  window.history.replaceState(null, "", "/github");
  let accessible = true;
  const pages: string[] = [];
  setFetch(async (url) => {
    const q = new URL(url, "http://afe.test").searchParams;
    if (url.startsWith("/api/actions/github/resources")) {
      pages.push(q.get("page")!);
      return Response.json({
        items:
          q.get("page") === "1"
            ? [{ connectionId: "c", connectionName: "acme", repository: "acme/app" }]
            : q.get("page") === "3" && accessible
              ? [{ connectionId: "c2", connectionName: "other", repository: "acme/api" }]
              : [],
        hasMore: q.get("page") !== "3",
      });
    }
    if (q.get("view") === "capabilities") return Response.json({ items: [] });
    return Response.json({
      items: [
        {
          id: 1,
          name: url.includes("acme/api") ? "API workflow" : "App workflow",
          state: "active",
        },
      ],
      page: 1,
      hasMore: false,
    });
  });
  const mount = () =>
    render(
      <Router>
        <GitHubOperationsPage />
      </Router>,
    );
  let view = mount();
  await screen.findByText("App workflow");
  expect(pages).toEqual(["1", "2", "3"]);
  fireEvent.click(screen.getByRole("button", { name: /^Repository/ }));
  fireEvent.click(screen.getByRole("button", { name: "Pin acme/api · other" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Pinned repositories" })).getByRole("button", {
      name: "acme/api · other",
    }),
  );
  await screen.findByText("API workflow");
  expect(screen.queryByText("App workflow")).toBeNull();
  expect(
    within(screen.getByRole("group", { name: "Pinned repositories" }))
      .getByRole("button", { name: "acme/api · other" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  view.unmount();
  view = mount();
  await screen.findByText("API workflow");
  expect(
    within(screen.getByRole("group", { name: "Pinned repositories" })).getByRole("button", {
      name: "acme/api · other",
    }),
  ).toBeTruthy();
  view.unmount();
  accessible = false;
  mount();
  await screen.findByText("App workflow");
  expect(screen.queryByRole("button", { name: "acme/api · other" })).toBeNull();
});

it("never renders inaccessible deep links and handles empty repositories", async () => {
  window.history.replaceState(null, "", "/github?connectionId=hidden&repository=secret/repo");
  const calls: string[] = [];
  setFetch(async (url) => {
    calls.push(url);
    return Response.json({ items: [], hasMore: false });
  });
  render(
    <Router>
      <GitHubOperationsPage />
    </Router>,
  );
  await screen.findByText("No accessible repositories");
  expect(calls).toEqual(["/api/actions/github/resources?page=1"]);
  expect(screen.queryByText("secret/repo")).toBeNull();
});

it("ignores a late workflow response after switching repository tabs", async () => {
  localStorage.clear();
  window.history.replaceState(null, "", "/github");
  let resolveOld!: (response: Response) => void;
  setFetch(async (url) => {
    if (url.startsWith("/api/actions/github/resources"))
      return Response.json({
        items: ["app", "api"].map((name) => ({
          connectionId: "c",
          connectionName: "acme",
          repository: `acme/${name}`,
        })),
        hasMore: false,
      });
    const q = new URL(url, "http://afe.test").searchParams;
    if (q.get("view") === "capabilities") return Response.json({ items: [] });
    if (url.includes("acme/app"))
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    return Response.json({
      items: [{ id: 42, name: "New workflow", state: "active" }],
      page: 1,
      hasMore: false,
    });
  });
  render(
    <Router>
      <GitHubOperationsPage />
    </Router>,
  );
  await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: /^Repository/ }));
  fireEvent.click(screen.getByRole("button", { name: "acme/api · acme" }));
  await screen.findByText("New workflow");
  await act(async () => {
    resolveOld(
      Response.json({
        items: [{ id: 42, name: "Old workflow", state: "active" }],
        page: 1,
        hasMore: false,
      }),
    );
  });
  await waitFor(() => expect(screen.queryByText("Old workflow")).toBeNull());
  expect(screen.getByText("New workflow")).toBeTruthy();
});

it("shows discovery loading and retry states before selecting a repository", async () => {
  window.history.replaceState(null, "", "/github");
  let fail = true;
  setFetch(async (url) => {
    if (url.startsWith("/api/actions/github/resources")) {
      if (fail)
        return Response.json({ message: "GitHub temporarily unavailable" }, { status: 503 });
      return Response.json({
        items: [{ connectionId: "c", connectionName: "acme", repository: "acme/app" }],
        hasMore: false,
      });
    }
    return Response.json({ items: [], page: 1, hasMore: false });
  });
  render(
    <Router>
      <GitHubOperationsPage />
    </Router>,
  );
  expect(screen.getByText("Loading GitHub repositories…")).toBeTruthy();
  await screen.findByText("GitHub temporarily unavailable");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("No workflows on this page");
  fireEvent.click(screen.getByRole("button", { name: /^Repository/ }));
  expect(screen.getByRole("button", { name: "acme/app · acme" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

async function openRunLogs() {
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  fireEvent.click(
    within((await screen.findByText("Deploy 102")).closest("li")!).getByRole("button", {
      name: "Open details",
    }),
  );
  const details = await screen.findByRole("region", { name: "Run 102" });
  const view = await within(details).findByRole("button", {
    name: "View logs for Build and deploy",
  });
  await waitFor(() => expect((view as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(view);
  return details;
}
it.each(["success", "failure"])(
  "opens %s logs beside job/steps and clears output when changing attempts",
  async (conclusion) => {
    fixture({ conclusion });
    const details = await openRunLogs();
    const output = await within(details).findByLabelText("Job log for Build and deploy");
    expect(output.textContent).toContain("Attempt 2 output <script>inert</script>");
    expect(document.querySelector("script")).toBeNull();
    expect(output.closest("li")?.textContent).toContain("Build");
    fireEvent.change(screen.getByLabelText("Inspect log/job attempt"), { target: { value: "1" } });
    await waitFor(() => expect(screen.queryByLabelText("Job log for Build and deploy")).toBeNull());
    const view = await within(details).findByRole("button", {
      name: "View logs for Build and deploy",
    });
    fireEvent.click(view);
    expect((await screen.findByLabelText("Job log for Build and deploy")).textContent).toContain(
      "Attempt 1 output",
    );
  },
);
it.each([409, 403, 404, 410, 502])(
  "shows explicit log error %s with retry inside the selected run",
  async (logStatus) => {
    fixture({ logStatus });
    const details = await openRunLogs();
    await within(details).findByRole("alert");
    expect(within(details).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(
      within(details).getByText(
        logStatus === 409
          ? "Logs not ready yet"
          : logStatus === 403
            ? "Log access denied"
            : "Job logs unavailable",
        { exact: false },
      ),
    ).toBeTruthy();
  },
);
it("explains missing log grants instead of silently omitting log access", async () => {
  fixture({ logGrant: false });
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  fireEvent.click(
    within((await screen.findByText("Deploy 101")).closest("li")!).getByRole("button", {
      name: "Open details",
    }),
  );
  await screen.findByText("Logs unavailable: Requires explicit log permission.");
  const view = screen.getByRole("button", { name: "View logs for Build and deploy" });
  expect((view as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById(view.getAttribute("aria-describedby")!)?.textContent).toBe(
    "Requires explicit log permission.",
  );
});

it("keeps the log toggle associated with output and collapses without losing the job", async () => {
  fixture();
  const details = await openRunLogs();
  const hide = within(details).getByRole("button", { name: "Hide logs for Build and deploy" });
  expect(hide.getAttribute("aria-expanded")).toBe("true");
  const output = document.getElementById(hide.getAttribute("aria-controls")!);
  expect(output?.getAttribute("aria-label")).toBe("Logs for Build and deploy, attempt 2");
  hide.focus();
  fireEvent.click(hide);
  const view = within(details).getByRole("button", { name: "View logs for Build and deploy" });
  expect(document.activeElement).toBe(view);
  expect(view.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: "Logs for Build and deploy, attempt 2" })).toBeNull();
  expect(within(details).getByText("Build")).toBeTruthy();
});

it("searches repository names, keeps pins separate from selection and remembers unpinning", async () => {
  localStorage.clear();
  window.history.replaceState(null, "", "/github");
  setFetch(async (url) => {
    if (url.startsWith("/api/actions/github/resources"))
      return Response.json({
        items: ["app", "api", "worker"].map((name) => ({
          connectionId: "c",
          connectionName: "acme",
          repository: `acme/${name}`,
        })),
        hasMore: false,
      });
    const q = new URL(url, "http://afe.test").searchParams;
    return Response.json({
      items:
        q.get("view") === "capabilities"
          ? []
          : [{ id: 1, name: `${url.split("?")[0]!.split("/").at(-1)} workflow`, state: "active" }],
      page: 1,
      hasMore: false,
    });
  });
  const mount = () =>
    render(
      <Router>
        <GitHubOperationsPage />
      </Router>,
    );
  let view = mount();
  await screen.findByText("app workflow");
  expect(screen.queryByRole("group", { name: "Pinned repositories" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Repository/ }));
  const search = screen.getByRole("searchbox", { name: "Search repositories" });
  fireEvent.change(search, { target: { value: " API " } });
  expect(screen.getByRole("status").textContent).toBe("1 of 3 repositories");
  expect(screen.queryByRole("button", { name: "acme/app · acme" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pin acme/api · acme" }));
  expect(screen.getByRole("button", { name: /^Repository/ }).textContent).toContain("acme/app");
  const tabs = screen.getByRole("group", { name: "Pinned repositories" });
  fireEvent.click(within(tabs).getByRole("button", { name: "acme/api · acme" }));
  await screen.findByText("api workflow");
  fireEvent.change(search, { target: { value: "missing" } });
  await screen.findByText("No matching repositories");
  expect(screen.getByText("api workflow")).toBeTruthy();
  fireEvent.change(search, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Unpin acme/api · acme" }));
  expect(screen.queryByRole("group", { name: "Pinned repositories" })).toBeNull();
  expect(screen.getByText("api workflow")).toBeTruthy();
  fireEvent.keyDown(search, { key: "Escape" });
  const trigger = screen.getByRole("button", { name: /^Repository/ });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("dialog", { name: "Choose a repository" })).toBeNull();
  view.unmount();
  view = mount();
  await screen.findByText("api workflow");
  expect(screen.queryByRole("group", { name: "Pinned repositories" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Repository/ }));
  expect(screen.getByRole("button", { name: "acme/api · acme" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it.each(["broken json", '{"unexpected":true}', '[null,1,"inaccessible"]'])(
  "ignores invalid pin preferences: %s",
  async (stored) => {
    localStorage.clear();
    localStorage.setItem("afe.github.repository:[null,null]:pins", stored);
    fixture();
    await screen.findByText("Deploy");
    expect(screen.queryByRole("group", { name: "Pinned repositories" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Repository/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pin acme/app · acme" }));
    expect(screen.getByRole("group", { name: "Pinned repositories" })).toBeTruthy();
  },
);
it("supports selection and pins when browser storage is unavailable", async () => {
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    fixture();
    await screen.findByText("Deploy");
    fireEvent.click(screen.getByRole("button", { name: /^Repository/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pin acme/app · acme" }));
    const tabs = screen.getByRole("group", { name: "Pinned repositories" });
    fireEvent.click(within(tabs).getByRole("button", { name: "acme/app · acme" }));
    expect(screen.getByText("Deploy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unpin acme/app · acme" }));
    expect(screen.queryByRole("group", { name: "Pinned repositories" })).toBeNull();
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

async function openRunOperation() {
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  const row = (await screen.findByText("Deploy 102")).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Open details" }));
  const trigger = await within(row).findByRole("button", { name: "Re-run all jobs" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Re-run all jobs" });
  await waitFor(() => expect(dialog.getAttribute("aria-busy")).toBe("false"));
  return { row, trigger, dialog };
}
it("overlays a selected run, restores its trigger and dismisses without execution", async () => {
  const mutations = fixture();
  const { row, trigger, dialog } = await openRunOperation();
  expect(dialog.parentElement).toBe(document.body);
  expect(row.contains(dialog)).toBe(false);
  expect(within(dialog).getAllByText("102").length).toBeGreaterThan(0);
  expect(within(dialog).getAllByText("2").length).toBeGreaterThan(0);
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(trigger);
  expect(screen.getByRole("region", { name: "Run 102" }).closest("li")).toBe(row);
  fireEvent.click(trigger);
  const again = await screen.findByRole("dialog", { name: "Re-run all jobs" });
  await waitFor(() => expect(again.getAttribute("aria-busy")).toBe("false"));
  fireEvent(again, new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(mutations).toHaveLength(0);
});
it("reviews debug input in the overlay and preserves prepared version and run context", async () => {
  const mutations = fixture();
  const { dialog } = await openRunOperation();
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "Enable debug logging for this re-run" }),
  );
  await waitFor(() => expect(dialog.getAttribute("aria-busy")).toBe("false"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Re-run all jobs" }));
  await screen.findByText("GitHub accepted the request.");
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({
    action: "github.rerun",
    params: { runId: 102, attempt: 2, enableDebugLogging: true },
    expectedVersion: "a".repeat(64),
    confirmed: true,
  });
});
it("keeps preparation failures and retry inside the dialog without enabling execution", async () => {
  const mutations = fixture({ prepareStatus: 503 });
  const { dialog } = await openRunOperation();
  expect(within(dialog).getByRole("alert").textContent).toContain("Source state unavailable");
  expect(
    (within(dialog).getByRole("button", { name: "Re-run all jobs" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry preparation" }));
  await within(dialog).findByRole("alert");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mutations).toHaveLength(0);
});
it("keeps execution errors in context and uses the same deliberate request on retry", async () => {
  const mutations = fixture({ executeStatus: 409 });
  const { dialog } = await openRunOperation();
  const confirm = within(dialog).getByRole("button", { name: "Re-run all jobs" });
  fireEvent.click(confirm);
  await within(dialog).findByRole("alert");
  expect(within(dialog).getByRole("alert").textContent).toContain("Resource changed");
  fireEvent.click(confirm);
  await waitFor(() => expect(mutations).toHaveLength(2));
  expect(mutations[0]!.requestId).toBe(mutations[1]!.requestId);
});
it("prevents duplicate execution and dismissal while the operation is in flight", async () => {
  const mutations = fixture({ holdMutation: true });
  const { dialog } = await openRunOperation();
  const confirm = within(dialog).getByRole("button", { name: "Re-run all jobs" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(within(dialog).getByRole("status").textContent).toBe("Submitting…");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(mutations).toHaveLength(1);
});
