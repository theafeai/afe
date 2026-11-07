// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, afterEach, expect, it } from "vitest";
import { App } from "../App.tsx";
import { setFetch } from "../api/client.ts";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
const root = "/api/actions/terraform/connections/connection";
const view = {
  context: {
    connectionId: "connection",
    workspaceId: "ws-alpha",
    organization: "acme",
    serverUrl: "https://app.terraform.io",
  },
  name: "production",
  locked: false,
  url: "https://app.terraform.io/app/acme/workspaces/production",
  capabilities: [{ action: "terraform.plan", enabled: true, reason: null }],
  runs: [
    {
      id: "run-alpha",
      status: "planned",
      url: "https://app.terraform.io/app/acme/workspaces/production/runs/run-alpha",
      planId: "plan-alpha",
      applyId: "apply-alpha",
      changes: { additions: 2, changes: 1, destructions: 0 },
      capabilities: [
        { action: "terraform.apply", enabled: true, reason: null },
        {
          action: "terraform.cancel",
          enabled: false,
          reason: "Unavailable in the current source state.",
        },
      ],
      policies: [],
    },
  ],
  nextPage: null,
};
function fixture({
  execute,
  prepare,
  resources,
}: {
  execute?: (body: Record<string, unknown>) => Promise<Response>;
  prepare?: () => Promise<Response>;
  resources?: () => Promise<Response>;
} = {}) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  setFetch(async (url, init) => {
    if (url === "/api/session")
      return Response.json({
        principal: { id: "user", roles: ["viewer"], kind: "session", managedUser: true },
      });
    if (url === "/api/profile")
      return Response.json({
        managedUser: true,
        tools: [
          {
            tool: "terraform",
            mode: "source",
            sourceEnabled: true,
            sourceAvailable: true,
            linked: true,
            accountName: "alice",
          },
        ],
      });
    if (url === "/api/actions/terraform/resources")
      return resources
        ? resources()
        : Response.json({
            resources: [
              {
                connectionId: "connection",
                workspaceId: "ws-alpha",
                organization: "acme",
                name: "production",
              },
            ],
          });
    if (url === `${root}?page=1`) return Response.json(view);
    if (url === `${root}/requests`) return Response.json({ requests: [] });
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      posts.push({ url, body });
      if (url.endsWith("/prepare"))
        return prepare
          ? prepare()
          : Response.json({
              version: "a".repeat(64),
              summary: "Confirm apply · acme/production · run-alpha",
              sourceUrl: view.runs[0]!.url,
            });
      if (url.endsWith("/execute"))
        return execute
          ? execute(body)
          : Response.json(
              {
                state: "accepted",
                message:
                  "Terraform accepted the operation. Refresh source state to observe completion.",
              },
              { status: 202 },
            );
    }
    throw new Error(`Unexpected request ${url}`);
  });
  window.history.replaceState(null, "", "/terraform");
  render(<App />);
  return posts;
}
async function selectWorkspace() {
  fireEvent.change(await screen.findByLabelText("Remote workspace"), {
    target: { value: "connection" },
  });
  await screen.findByRole("button", { name: "Confirm apply" });
}
it("reviews the exact workspace/run and submits only from explicit confirmation, once", async () => {
  const posts = fixture();
  await selectWorkspace();
  expect((screen.getByRole("button", { name: "Cancel run" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
  const dialog = await screen.findByRole("dialog", { name: "Confirm apply" });
  await within(dialog).findByText("Confirm apply · acme/production · run-alpha");
  expect(posts.map((p) => p.url)).toEqual([`${root}/prepare`]);
  const confirm = within(dialog).getByRole("button", { name: "Confirm operation" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(posts.filter((p) => p.url.endsWith("/execute"))).toEqual([
    {
      url: `${root}/execute`,
      body: {
        operation: { action: "terraform.apply", runId: "run-alpha" },
        version: "a".repeat(64),
        requestId: expect.any(String),
        confirmed: true,
      },
    },
  ]);
});
it("can cancel review without sending a mutation", async () => {
  const posts = fixture();
  await selectWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Confirm apply · acme/production · run-alpha");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(posts).toHaveLength(1);
});
it("keeps uncertain outcomes in the dialog and prevents blind resubmission", async () => {
  const posts = fixture({
    execute: async () =>
      Response.json(
        { state: "unknown", message: "Inspect Terraform before recovery." },
        { status: 502 },
      ),
  });
  await selectWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Confirm apply · acme/production · run-alpha");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm operation" }));
  await within(dialog).findByText("Inspect Terraform before recovery.");
  expect(
    (within(dialog).getByRole("button", { name: "Confirm operation" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(posts.filter((p) => p.url.endsWith("/execute"))).toHaveLength(1);
});
it("shows preparation failure inside the dialog without an enabled confirmation", async () => {
  fixture({
    prepare: async () => Response.json({ message: "Terraform state changed." }, { status: 409 }),
  });
  await selectWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "Confirm apply" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Terraform state changed.");
  expect(
    (within(dialog).getByRole("button", { name: "Confirm operation" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("handles discovery loading, error and empty states without a false empty flash", async () => {
  let resolve!: (response: Response) => void;
  fixture({
    resources: () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  });
  expect(screen.queryByText("No accessible remote workspaces")).toBeNull();
  await screen.findByRole("status");
  resolve(Response.json({ resources: [] }));
  await screen.findByText("No accessible remote workspaces");
  cleanup();
  fixture({
    resources: async () =>
      Response.json({ message: "Link your personal Terraform token." }, { status: 403 }),
  });
  await screen.findByText("Link your personal Terraform token.");
  expect(screen.queryByText("No accessible remote workspaces")).toBeNull();
});
