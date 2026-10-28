// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setFetch } from "../api/client.ts";
import { ConnectTerraform } from "./ConnectTerraform.tsx";
import { Router } from "../router.tsx";

afterEach(cleanup);

it("creates a metadata-only connection and shows the scoped secret once", async () => {
  const requests: unknown[] = [];
  setFetch(async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        connection: { id: "connection", externalId: "identity" },
        secret: "reporter-secret",
        reportPath: "/agent/terraform/v1/identity/reports",
      }),
      { status: 201 },
    );
  });
  const view = render(
    <Router>
      <ConnectTerraform />
    </Router>,
  );
  fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "demo" } });
  fireEvent.change(screen.getByLabelText("Environment (optional)"), {
    target: { value: "development" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create reporter connection" }));
  expect(await screen.findByText("Save your reporter secret")).toBeTruthy();
  expect(requests).toEqual([
    { url: "/api/connections/terraform", body: { workspace: "demo", environment: "development" } },
  ]);
  expect((screen.getByLabelText("Reporter secret") as HTMLInputElement).type).toBe("password");
  expect(screen.getByRole("link", { name: /I saved the secret/ }).getAttribute("href")).toBe(
    "/connections/connection",
  );
  view.unmount();
  render(
    <Router>
      <ConnectTerraform />
    </Router>,
  );
  expect(screen.queryByLabelText("Reporter secret")).toBeNull();
});

it("keeps the form available on server rejection", async () => {
  setFetch(
    async () => new Response(JSON.stringify({ error: "invalid_connection" }), { status: 400 }),
  );
  render(
    <Router>
      <ConnectTerraform />
    </Router>,
  );
  fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "demo" } });
  fireEvent.click(screen.getByRole("button", { name: "Create reporter connection" }));
  expect(await screen.findByText(/Could not connect Terraform/)).toBeTruthy();
  expect(screen.getByLabelText("Workspace name")).toBeTruthy();
});
