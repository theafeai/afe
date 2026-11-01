// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Router } from "./router.tsx";
import { ToastProvider, useToast, type Toast, type ToastInput } from "./toast.tsx";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Trigger({ toast: input }: { toast: ToastInput | string }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast(input)}>
      Show
    </button>
  );
}

function setup(input: ToastInput | string, onToast?: (t: Toast) => void) {
  render(
    <Router>
      <ToastProvider onToast={onToast}>
        <Trigger toast={input} />
      </ToastProvider>
    </Router>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
}

it("announces a confirmation in the notifications region and dismisses it after a while", () => {
  setup("Settings saved.");
  const region = screen.getByRole("region", { name: "Notifications" });
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(screen.getByRole("status").textContent).toBe("Done: Settings saved.");
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("status")).toBeNull();
});

it("waits while the pointer is over the toast", () => {
  setup("Settings saved.");
  fireEvent.mouseEnter(screen.getByRole("status"));
  act(() => vi.advanceTimersByTime(20000));
  expect(screen.getByRole("status")).toBeTruthy();
  fireEvent.mouseLeave(screen.getByRole("status"));
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("status")).toBeNull();
});

it("keeps errors until they are dismissed", () => {
  setup({ kind: "error", message: "Could not save." });
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByRole("alert").textContent).toContain("Could not save.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows a repeated message once and reports every toast to the host", () => {
  const seen: Toast[] = [];
  setup({ message: "Saved.", action: { label: "Back", to: "/connections" } }, (t) => seen.push(t));
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/connections");
  expect(seen.map((t) => [t.kind, t.message])).toEqual([
    ["ok", "Saved."],
    ["ok", "Saved."],
  ]);
});

it("does nothing outside a provider", () => {
  render(<Trigger toast="Saved." />);
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(screen.queryByRole("status")).toBeNull();
});
