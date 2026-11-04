// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { setFetch } from "../api/client.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mail = { enabled: true, configured: true, from: "afe@example.com", deliveries: [] };

beforeEach(() => {
  window.history.replaceState(null, "", "/account/settings");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("places Settings beside Profile and Users and moves email delivery out of Users", async () => {
  setFetch(async (url) => {
    if (url === "/api/session") return json({ principal: { roles: ["admin"] } });
    if (url === "/api/admin/users") return json({ users: [] });
    if (url === "/api/admin/email") return json(mail);
    throw new Error(`Unexpected request: ${url}`);
  });
  window.history.replaceState(null, "", "/users");
  render(<App />);
  const settings = await screen.findByRole("link", { name: "Settings" });
  const account = within(settings.closest("ul")!);
  expect(account.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Profile",
    "Users",
    "Settings",
  ]);
  expect(screen.queryByRole("heading", { name: "Email delivery" })).toBeNull();
  expect(screen.queryByLabelText("Test recipient")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Manage email delivery in Settings" }));
  expect(await screen.findByText("afe@example.com")).toBeTruthy();
  expect(settings.getAttribute("aria-current")).toBe("page");
  expect(window.location.pathname).toBe("/account/settings");
  expect(document.title).toBe("Settings · Afe");
});

it.each([false, true])(
  "blocks non-admin direct access without requesting email settings (managed: %s)",
  async (managedUser) => {
    const requested: string[] = [];
    setFetch(async (url) => {
      requested.push(url);
      if (url === "/api/session") return json({ principal: { roles: ["viewer"], managedUser } });
      if (url === "/api/profile") return json({ managedUser, tools: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);
    await screen.findByText("Administrator access required");
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByLabelText("Test recipient")).toBeNull();
    expect(requested).not.toContain("/api/admin/email");
  },
);

it("shows loading, retries failed loads, and explains disabled email without a test form", async () => {
  let finishLoad: (response: Response) => void = () => {};
  let loads = 0;
  setFetch(async (url) => {
    if (url === "/api/session") return json({ principal: { roles: ["admin"] } });
    if (url === "/api/admin/email") {
      if (++loads === 1)
        return new Promise<Response>((resolve) => {
          finishLoad = resolve;
        });
      return json({ enabled: false, configured: false, from: null, deliveries: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  render(<App />);
  await screen.findByText("Loading email delivery settings…");
  expect(screen.queryByText(/Email is disabled/)).toBeNull();
  finishLoad(json({ error: "temporarily_unavailable" }, 503));
  await screen.findByText("Email delivery settings could not be loaded (HTTP 503)");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText(/Email is disabled. An operator can configure SMTP/);
  expect(screen.queryByRole("button", { name: "Send test email" })).toBeNull();
});

it("retains recipient validation and draft after failure, queues a test, and refreshes delivery status", async () => {
  let finishSend: (response: Response) => void = () => {};
  const writes: unknown[] = [];
  let deliveries: { id: string; state: string; attempts: number }[] = [];
  setFetch(async (url, init) => {
    if (url === "/api/session") return json({ principal: { roles: ["admin"] } });
    if (url === "/api/admin/email") return json({ ...mail, deliveries });
    if (url === "/api/admin/email/test" && init?.method === "POST") {
      writes.push(JSON.parse(init.body as string));
      return new Promise<Response>((resolve) => {
        finishSend = resolve;
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  render(<App />);
  const recipient = (await screen.findByLabelText("Test recipient")) as HTMLInputElement;
  expect(recipient.required).toBe(true);
  expect(recipient.checkValidity()).toBe(false);
  fireEvent.change(recipient, { target: { value: "invalid-email" } });
  expect(recipient.checkValidity()).toBe(false);
  fireEvent.change(recipient, { target: { value: "test@example.com" } });
  expect(recipient.checkValidity()).toBe(true);
  await screen.findByText("No recent deliveries");
  fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
  expect(
    (screen.getByRole("button", { name: "Sending test email…" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  finishSend(json({ error: "queue_unavailable" }, 503));
  await screen.findByText("Test email was not queued (HTTP 503)");
  expect(recipient.value).toBe("test@example.com");
  fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
  deliveries = [{ id: "d1", state: "pending", attempts: 0 }];
  finishSend(json({ queued: true }, 202));
  await screen.findByText("Test email queued.");
  await screen.findByRole("cell", { name: "pending" });
  expect(writes).toEqual([{ email: "test@example.com" }, { email: "test@example.com" }]);
  deliveries = [{ id: "d1", state: "sent", attempts: 1 }];
  fireEvent.click(screen.getByRole("button", { name: "Refresh delivery status" }));
  await screen.findByRole("cell", { name: "sent" });
  await waitFor(() =>
    expect(screen.getByLabelText("Test recipient")).toHaveProperty("value", "test@example.com"),
  );
});
