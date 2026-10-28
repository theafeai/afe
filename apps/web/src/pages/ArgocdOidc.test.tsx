// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../App.tsx";
import { ArgocdOidcSettings } from "./ArgocdOidc.tsx";
import { setFetch } from "../api/client.ts";
afterEach(cleanup);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
it("offers only configured ArgoCD SSO connections and keeps personal-token fallback", async () => {
  setFetch(async (url) => {
    if (url === "/api/session")
      return json({
        principal: { id: "local", roles: ["viewer"], kind: "session", managedUser: true },
      });
    if (url === "/api/profile")
      return json({
        managedUser: true,
        tools: [
          {
            tool: "argocd",
            mode: "source",
            linked: false,
            oauthAvailable: true,
            sourceEnabled: true,
            oidcConnections: [{ id: "production", name: "Production ArgoCD" }],
          },
        ],
      });
    throw new Error("Unexpected call");
  });
  window.history.replaceState(null, "", "/profile");
  render(<App />);
  expect(await screen.findByRole("button", { name: "Sign in with ArgoCD" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Production ArgoCD" })).toBeTruthy();
  expect(screen.getByLabelText("Your tool access token")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in with Vercel" })).toBeNull();
});
it("saves OIDC settings without reading back a client secret", async () => {
  const writes: unknown[] = [];
  setFetch(async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body as string));
      return json({ ok: true });
    }
    return json({
      config: null,
      clientSecretConfigured: false,
      callbackUrl: "https://afe.example/api/profile/tools/argocd/callback",
    });
  });
  render(<ArgocdOidcSettings id="c1" />);
  fireEvent.change(await screen.findByLabelText("OIDC issuer"), {
    target: { value: "https://issuer.example" },
  });
  fireEvent.change(screen.getByLabelText("OIDC client ID"), { target: { value: "afe-client" } });
  fireEvent.click(screen.getByRole("button", { name: "Save SSO settings" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    issuer: "https://issuer.example",
    clientId: "afe-client",
    authMethod: "none",
    scopes: ["openid", "profile", "email", "groups"],
    caPem: "",
  });
  expect(screen.queryByLabelText("Client secret")).toBeNull();
});
