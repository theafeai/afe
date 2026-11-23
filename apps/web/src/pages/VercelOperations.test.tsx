// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it } from "vitest";
import { VERCEL_OPERATIONS } from "@afe/core/vercel-operations";
import { setFetch } from "../api/client.ts";
import { Router } from "../router.tsx";
import { ToastProvider } from "../toast.tsx";
import { VercelOperationsPage } from "./VercelOperations.tsx";
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
const root = "/api/actions/vercel/connections/c/projects/prj_app";
function fixture({ empty = false, resourceError = false, uncertain = false, hold = false } = {}) {
  const mutations: Record<string, unknown>[] = [];
  setFetch(async (url, init) => {
    if (url === "/api/actions/vercel/resources")
      return resourceError
        ? Response.json({ message: "Link your Vercel account" }, { status: 403 })
        : Response.json({
            items: empty
              ? []
              : [{ connectionId: "c", projectId: "prj_app", name: "app", connectionName: "acme" }],
          });
    if (url.endsWith("/prepare")) {
      const intent = JSON.parse(String(init?.body));
      return Response.json({
        ...intent,
        fingerprint: "a".repeat(64),
        warning: "May change production traffic.",
        context: { connectionId: "c", projectId: "prj_app", deploymentId: "dpl_1" },
      });
    }
    if (url === root && init?.method === "POST") {
      mutations.push(JSON.parse(String(init.body)));
      if (hold) return new Promise<Response>(() => {});
      return Response.json({
        state: uncertain ? "unknown" : "accepted",
        message: uncertain
          ? "Outcome uncertain. Inspect Vercel before recovery."
          : "Vercel accepted the request.",
      });
    }
    return Response.json({
      context: { connectionId: "c", projectId: "prj_app" },
      project: {
        id: "prj_app",
        name: "app",
        productionId: "dpl_live",
        sourceUrl: "https://vercel.com/acme/app",
      },
      deployments: [
        {
          id: "dpl_1",
          state: "READY",
          target: "preview",
          createdAt: 100,
          sourceUrl: "https://vercel.com/acme/app/dpl_1",
        },
      ],
      deployment: url.includes("deploymentId")
        ? { id: "dpl_1", state: "READY", target: "preview" }
        : null,
      domains: [],
      settings: {},
      capabilities: VERCEL_OPERATIONS.map(([action, label]) => ({
        action,
        label,
        enabled: true,
        reason: null,
      })),
      history: [],
      next: null,
    });
  });
  render(
    <Router>
      <ToastProvider>
        <VercelOperationsPage />
      </ToastProvider>
    </Router>,
  );
  return mutations;
}
async function select() {
  await screen.findByLabelText("Project");
  fireEvent.change(screen.getByLabelText("Project"), { target: { value: "c:prj_app" } });
  await screen.findByRole("button", { name: "Select deployment" });
  fireEvent.click(screen.getByRole("button", { name: "Select deployment" }));
  await screen.findByText("Delivery operations");
}
it("requires review and explicit confirmation and suppresses duplicate clicks", async () => {
  const mutations = fixture({ hold: true });
  await select();
  fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
  const confirm = await screen.findByRole("button", { name: "Confirm operation" });
  expect(mutations).toHaveLength(0);
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(mutations).toHaveLength(1));
  expect(mutations[0]).toMatchObject({
    action: "vercel.redeploy",
    params: { deploymentId: "dpl_1", target: "preview" },
    confirmed: true,
    fingerprint: "a".repeat(64),
  });
  expect(confirm).toHaveProperty("disabled", true);
});
it("shows uncertain acceptance without treating it as completion", async () => {
  fixture({ uncertain: true });
  await select();
  fireEvent.click(screen.getByRole("button", { name: "Review operation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm operation" }));
  await screen.findByText("Outcome uncertain. Inspect Vercel before recovery.");
});
it("handles empty discovery and actionable linking errors", async () => {
  fixture({ empty: true });
  await screen.findByText("No Vercel projects available");
  cleanup();
  fixture({ resourceError: true });
  await screen.findByText("Link your Vercel account in Profile");
});
it("offers explicit project operation selection when enabling separate credentials", async () => {
  fixture();
  await select();
  fireEvent.click(screen.getByRole("button", { name: "Enable or replace action token" }));
  expect(screen.getByLabelText("Personal Vercel action token")).toHaveProperty("type", "password");
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByLabelText("Cancel deployment"));
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
});
