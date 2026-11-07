// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import { ARGOCD_OPERATIONS } from "@afe/core/argocd-catalog";
import { setFetch } from "../api/client.ts";
import { Router } from "../router.tsx";
import { ToastProvider } from "../toast.tsx";
import { ArgoCdOperationsPage } from "./ArgoCdOperations.tsx";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
function fixture({
  enabled = true,
  prepareStatus = 200,
  executeStatus = 202,
  empty = false,
  listStatus = 200,
  hold = false,
} = {}) {
  const executions: Record<string, unknown>[] = [],
    preparations: Record<string, unknown>[] = [];
  setFetch(async (url, init) => {
    const u = new URL(url, "http://afe.test");
    if (u.pathname.endsWith("/applications"))
      return Response.json(
        {
          items: empty
            ? []
            : [
                {
                  connectionId: "c",
                  connectionName: "Production",
                  application: "web",
                  appNamespace: "argocd",
                  transport: "direct",
                },
              ],
        },
        { status: listStatus },
      );
    if (u.pathname.endsWith("/prepare")) {
      const body = JSON.parse(String(init?.body));
      preparations.push(body);
      return Response.json(
        prepareStatus === 200
          ? {
              action: body.action,
              version: "a".repeat(64),
              summary: "Sync application: argocd/web.",
              context: {},
            }
          : { message: "Source state changed" },
        { status: prepareStatus },
      );
    }
    if (u.pathname.endsWith("/execute")) {
      const body = JSON.parse(String(init?.body));
      executions.push(body);
      if (hold) return new Promise<Response>(() => {});
      return Response.json(
        {
          requestId: body.requestId,
          action: body.action,
          state: executeStatus === 202 ? "accepted" : "unknown",
          message:
            executeStatus === 202
              ? "ArgoCD accepted the request."
              : "Response uncertain. Inspect source before recovery.",
        },
        { status: executeStatus },
      );
    }
    if (u.pathname.endsWith("/history")) return Response.json({ items: [] });
    if (u.pathname.endsWith("/diff"))
      return Response.json({ items: [], message: "Resource summary only." });
    if (u.pathname.endsWith("/resource-actions"))
      return Response.json({ items: [{ name: "restart", enabled: true }] });
    return Response.json({
      context: { uid: "uid", operationId: null },
      sourceUrl: "https://argocd.test/applications/argocd/web",
      sync: "OutOfSync",
      health: "Healthy",
      revision: "abc123",
      operation: "Succeeded",
      actionsEnabled: enabled,
      history: [{ id: 1, revision: "old" }],
      resources: [
        {
          group: "apps",
          kind: "Deployment",
          name: "web",
          namespace: "prod",
          status: "Synced",
          health: "Healthy",
        },
      ],
      capabilities: ARGOCD_OPERATIONS.map(([action, label, , destructive]) => ({
        action,
        label,
        destructive,
        enabled,
        reason: enabled ? null : "Enable actions first.",
      })),
    });
  });
  render(
    <Router>
      <ToastProvider>
        <ArgoCdOperationsPage />
      </ToastProvider>
    </Router>,
  );
  return { executions, preparations };
}
it("requires review and explicit confirmation, preserving revision/resource/options selection", async () => {
  const { executions, preparations } = fixture();
  await screen.findByRole("button", { name: "Review operation" });
  fireEvent.change(screen.getByLabelText("Revision (single source, optional)"), {
    target: { value: "release-1" },
  });
  fireEvent.click(screen.getByLabelText("Deployment · prod/web"));
  fireEvent.click(screen.getByLabelText("PruneLast=true"));
  fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Confirm operation" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(executions).toHaveLength(0);
  expect(preparations[0]).toMatchObject({
    params: {
      revision: "release-1",
      resources: [{ name: "web" }],
      syncOptions: ["PruneLast=true"],
    },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm operation" }));
  await screen.findByText(/ArgoCD accepted the request/);
  expect(executions).toHaveLength(1);
  expect(executions[0]).toMatchObject({ confirmed: true, version: "a".repeat(64) });
});
it("cancel and failed preparation never dispatch", async () => {
  const { executions } = fixture({ prepareStatus: 409 });
  fireEvent.click(await screen.findByRole("button", { name: "Review operation" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Source state changed");
  expect(
    within(dialog).getByRole("button", { name: "Confirm operation" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBe(null);
  expect(executions).toHaveLength(0);
});
it("blocks duplicate clicks and dismissal during a mutation", async () => {
  const { executions } = fixture({ hold: true });
  fireEvent.click(await screen.findByRole("button", { name: "Review operation" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Confirm operation" });
  await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(executions).toHaveLength(1);
  expect(screen.getByRole("dialog")).toBe(dialog);
});
it("shows uncertain acceptance as a retained callout without automatic retry", async () => {
  const { executions } = fixture({ executeStatus: 502 });
  fireEvent.click(await screen.findByRole("button", { name: "Review operation" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Confirm operation" });
  await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  fireEvent.click(confirm);
  await screen.findByText(/Response uncertain/);
  expect(executions).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBe(null);
});
it("keeps observation-only accounts disabled until explicit consent", async () => {
  fixture({ enabled: false });
  const review = await screen.findByRole("button", { name: "Review operation" });
  expect(review.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Enable actions" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/personal ArgoCD credential/)).toBeTruthy();
});
it("handles empty application state", async () => {
  fixture({ empty: true });
  await screen.findByText("No applications available");
  expect(screen.getByRole("link", { name: "Open Profile" })).toBeTruthy();
});
it("handles permission errors with retry", async () => {
  fixture({ listStatus: 403 });
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Review operation" })).toBe(null);
});
