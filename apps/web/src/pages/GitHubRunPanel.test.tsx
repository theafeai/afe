// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setFetch } from "../api/client.ts";
import type { WorkflowProgress } from "../api/github-runs.ts";
import { GitHubRunPanel } from "./GitHubRunPanel.tsx";

let snapshot: WorkflowProgress;
let requests: string[];
let status: number;
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  requests = [];
  status = 200;
  snapshot = {
    run: {
      id: 100,
      attempt: 1,
      name: "Deploy",
      status: "in_progress",
      conclusion: null,
      url: "https://github.com/acme/api/actions/runs/100/attempts/1",
    },
    jobs: [
      {
        id: 200,
        name: "deploy (node 22)",
        status: "in_progress",
        conclusion: null,
        startedAt: "2026-10-29T00:00:00Z",
        completedAt: null,
        steps: Array.from({ length: 10 }, (_, i) => ({
          number: i + 1,
          name: i === 4 ? "Deploy" : `Command ${i + 1}`,
          status: i < 4 ? "completed" : i === 4 ? "in_progress" : "queued",
          conclusion: i < 4 ? "success" : null,
          startedAt: i < 5 ? "2026-10-29T00:00:00Z" : null,
          completedAt: i < 4 ? "2026-10-29T00:00:05Z" : null,
        })),
      },
    ],
    partial: false,
    checkedAt: "2026-10-29T00:00:10Z",
    nextPollMs: 5000,
  };
  setFetch(async (url) => {
    requests.push(url);
    if (status !== 200) return json({ error: "not_found", message: "Event not found." }, status);
    if (url.endsWith("/log"))
      return json({ text: "deployment output <script>alert(1)</script>", jobId: 200, attempt: 1 });
    return json(structuredClone(snapshot));
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHub workflow progress panel", () => {
  it.each(["success", "failure"])(
    "shows ten steps, then logs after %s, and stops polling",
    async (conclusion) => {
      await act(async () => {
        render(<GitHubRunPanel eventId="event-1" />);
      });
      screen.getByText("5. Deploy");
      expect(
        within(screen.getByText("1. Command 1").closest("tr")!).getByText("succeeded"),
      ).toBeTruthy();
      expect(
        within(screen.getByText("5. Deploy").closest("tr")!).getByText("in progress"),
      ).toBeTruthy();
      expect(
        within(screen.getByText("10. Command 10").closest("tr")!).getByText("pending"),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /View logs/ })).toBeNull();
      snapshot.run.status = "completed";
      snapshot.run.conclusion = conclusion;
      snapshot.nextPollMs = null;
      snapshot.jobs[0]!.status = "completed";
      snapshot.jobs[0]!.conclusion = conclusion;
      snapshot.jobs[0]!.steps[4]!.status = "completed";
      snapshot.jobs[0]!.steps[4]!.conclusion = conclusion;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      fireEvent.click(screen.getByRole("button", { name: "View logs for deploy (node 22)" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByLabelText("Job log").textContent).toContain("<script>alert(1)</script>");
      expect(document.querySelector("script")).toBeNull();
      const count = requests.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(requests).toHaveLength(count);
    },
  );

  it("drops visible progress and stops polling when permission is revoked", async () => {
    await act(async () => {
      render(<GitHubRunPanel eventId="event-1" />);
    });
    screen.getByText("5. Deploy");
    status = 404;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByText("5. Deploy")).toBeNull();
    expect(screen.getByText("Event not found.")).toBeTruthy();
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(requests).toHaveLength(count);
  });

  it("handles a workflow with no jobs and lets users pause refreshes", async () => {
    snapshot.jobs = [];
    await act(async () => {
      render(<GitHubRunPanel eventId="event-1" />);
    });
    screen.getByText("No jobs reported yet");
    fireEvent.click(screen.getByRole("button", { name: "Pause updates" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(requests).toHaveLength(count);
    expect(screen.getByRole("button", { name: "Resume updates" })).toBeTruthy();
  });

  it("honours the source rate-limit deadline and resumes progress", async () => {
    setFetch(async (url) => {
      requests.push(url);
      return requests.length === 1
        ? json(
            {
              error: "github_rate_limited",
              message: "GitHub is rate limiting requests.",
              retryAfterMs: 120_000,
            },
            429,
          )
        : json(snapshot);
    });
    await act(async () => {
      render(<GitHubRunPanel eventId="event-1" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_999);
    });
    expect(requests).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(requests).toHaveLength(2);
    expect(screen.getByText("5. Deploy")).toBeTruthy();
  });
});
