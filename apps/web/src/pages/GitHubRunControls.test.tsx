// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setFetch } from "../api/client.ts";
import { GitHubRunControls } from "./GitHubRunControls.tsx";
afterEach(cleanup);
it("confirms the repository/run/attempt and submits only once before showing acceptance", async () => {
  const mutations: unknown[] = [];
  setFetch(async (_url, init) => {
    if (init?.method === "POST") {
      mutations.push(JSON.parse(init.body as string));
      return Response.json(
        {
          requestId: "r",
          state: "accepted",
          message: "GitHub accepted the request. Refresh to observe the resulting run state.",
        },
        { status: 202 },
      );
    }
    return Response.json({
      context: { connectionId: "c", repository: "acme/app", runId: 123, runAttempt: 2 },
      status: "completed",
      conclusion: "failure",
      capabilities: [{ action: "github.rerun", enabled: true, reason: null }],
    });
  });
  render(<GitHubRunControls eventId="e" />);
  fireEvent.click(await screen.findByRole("button", { name: "Re-run all jobs" }));
  expect(mutations).toHaveLength(0);
  expect(screen.getByText(/Re-run all jobs for acme\/app, run 123, attempt 2/)).toBeTruthy();
  const confirm = screen.getByRole("button", { name: "Confirm re-run all jobs" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await screen.findByRole("status");
  expect(mutations).toEqual([
    { action: "github.rerun", expectedAttempt: 2, requestId: expect.any(String), confirmed: true },
  ]);
});
it("shows permission reasons and disables unavailable actions", async () => {
  setFetch(async () =>
    Response.json({
      context: { connectionId: "c", repository: "acme/app", runId: 123, runAttempt: 1 },
      status: "in_progress",
      conclusion: null,
      capabilities: [
        {
          action: "github.cancel",
          enabled: false,
          reason: "Ask your administrator for this repository action grant.",
        },
      ],
    }),
  );
  render(<GitHubRunControls eventId="e" />);
  const button = await screen.findByRole("button", { name: "Cancel run" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  expect(screen.getByText("Ask your administrator for this repository action grant.")).toBeTruthy();
});
