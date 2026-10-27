// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetch } from "../api/client.ts";
import type { MappingState, PreviewResult, RuleView } from "../api/mapping.ts";
import { App } from "../App.tsx";

afterEach(() => cleanup());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function rule(id: string, o: Partial<RuleView>): RuleView {
  return {
    id,
    kind: "service",
    field: "github.repository",
    match: "exact",
    pattern: "acme/web",
    caseSensitive: false,
    priority: 10,
    targetId: "web",
    enabled: true,
    note: null,
    inactiveReason: null,
    ...o,
  };
}

function initialState(): MappingState {
  return {
    revision: 3,
    customised: true,
    services: [
      { id: "web", name: "Web", description: null },
      { id: "api", name: "API", description: null },
    ],
    environments: [
      { id: "production", name: "Production", order: 10, kind: "production" },
      { id: "staging", name: "Staging", order: 20, kind: "staging" },
    ],
    rules: [
      rule("r1", {}),
      rule("r2", { pattern: "acme/api", targetId: "api", priority: 20 }),
      rule("r3", {
        kind: "environment",
        field: "argocd.namespace",
        match: "glob",
        pattern: "*-prod",
        targetId: "production",
      }),
    ],
    builtinRules: [
      rule("builtin:vercel-target-production", {
        kind: "environment",
        field: "vercel.target",
        pattern: "production",
        targetId: "production",
        builtIn: true,
      }),
    ],
    fields: ["github.environment", "github.repository", "argocd.namespace", "argocd.label:<key>"],
    environmentKinds: ["production", "staging", "preview", "development", "other"],
  };
}

const placement = (service: string | null, environment: string | null) => ({
  service: service ? { id: service.toLowerCase(), name: service } : null,
  environment: environment
    ? { id: environment.toLowerCase(), name: environment, kind: "production", order: 10 }
    : null,
  confidence: service && environment ? "configured" : service || environment ? "partial" : "unmapped",
  matchedRuleIds: [],
  unmapped: [...(service ? [] : ["service"]), ...(environment ? [] : ["environment"])],
});

function previewResult(changed: boolean): PreviewResult {
  return {
    sampleSize: 3,
    summary: {
      current: { configured: 1, default: 0, partial: 1, unmapped: 1 },
      proposed: { configured: 2, default: 0, partial: 1, unmapped: 0 },
      changed: changed ? 1 : 0,
    },
    inactive: [],
    items: [
      {
        eventId: "e1",
        when: "2026-10-20T10:00:00.000Z",
        source: "argocd",
        action: "argocd.sync.succeeded",
        label: "payments",
        observations: { "argocd.application": ["payments"] },
        current: placement(null, "Production") as PreviewResult["items"][0]["current"],
        proposed: placement(changed ? "API" : null, "Production") as PreviewResult["items"][0]["current"],
        changed,
      },
    ],
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let calls: Call[];
let state: MappingState;

beforeEach(() => {
  calls = [];
  state = initialState();
  setFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === "/api/session") {
      return json(200, { principal: { id: "p", tenantId: "default", roles: ["admin"], kind: "token" } });
    }
    if (url === "/api/mapping" && method === "GET") return json(200, state);
    if (url === "/api/mapping/unmapped") {
      return json(200, {
        sampleSize: 3,
        values: [
          {
            source: "argocd",
            field: "argocd.application",
            value: "payments",
            count: 4,
            lastSeen: "2026-10-20T10:00:00.000Z",
            missing: ["service"],
            exampleEventId: "e1",
          },
        ],
      });
    }
    if (url === "/api/mapping/preview") return json(200, previewResult(Boolean(body?.rules)));
    if (url === "/api/mapping/services" && method === "POST") {
      state.services.push({ id: "shop", name: body.name, description: null });
      return json(201, { service: state.services.at(-1) });
    }
    if (url === "/api/mapping/rules" && method === "POST") {
      state.rules.push(rule("r9", { ...body, priority: 30 }));
      return json(201, { rule: state.rules.at(-1) });
    }
    if (url === "/api/mapping/rules/reorder") return json(200, { rules: [] });
    if (url.startsWith("/api/mapping/rules/") && method === "DELETE") {
      state.rules = state.rules.filter((r) => !url.endsWith(r.id));
      return json(200, { ok: true });
    }
    return json(404, { error: "not_found" });
  });
  window.history.replaceState(null, "", "/settings/mapping");
});

describe("Mapping settings page", () => {
  it("lists services, environments, rules and built-ins, linked from the nav", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Environment and service mapping" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mapping" }).getAttribute("aria-current")).toBe("page");
    const services = screen.getByRole("region", { name: "Services" });
    expect(within(services).getByText("Web")).toBeTruthy();
    const envRules = screen.getByRole("region", { name: "Environment rules" });
    expect(within(envRules).getByText("*-prod")).toBeTruthy();
    expect(screen.getByText(/Built-in defaults \(1 of 1 on\)/)).toBeTruthy();
    expect(await screen.findByText(/Of 3 recent deployment events/)).toBeTruthy();
  });

  it("adds a service and reloads", async () => {
    render(<App />);
    await screen.findByText("acme/api");
    fireEvent.change(screen.getByLabelText("Service name"), { target: { value: "Shop" } });
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    expect(await screen.findByText("Service “Shop” added.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/mapping/services")?.body).toEqual({
      name: "Shop",
      description: null,
    });
    expect(await screen.findByText("Shop")).toBeTruthy();
  });

  it("previews a new rule live and saves it", async () => {
    render(<App />);
    await screen.findByText("acme/api");
    fireEvent.click(screen.getByRole("button", { name: "Add service rule" }));
    fireEvent.change(screen.getByLabelText("Field"), { target: { value: "argocd.label:<key>" } });
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "team" } });
    fireEvent.change(screen.getByLabelText("Match"), { target: { value: "glob" } });
    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "pay*" } });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "api" } });
    expect(await screen.findByText("1 of 3 recent deployment events would change.")).toBeTruthy();
    const preview = calls.filter((c) => c.url === "/api/mapping/preview" && c.body).at(-1)!;
    const sent = (preview.body as { rules: { id?: string; field: string; pattern: string }[] }).rules;
    expect(sent.map((r) => r.id ?? "new")).toEqual(["r1", "r2", "r3", "new"]);
    expect(sent.at(-1)).toMatchObject({ field: "argocd.label:team", pattern: "pay*" });
    expect(sent[0]).not.toHaveProperty("inactiveReason");

    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(await screen.findByText("Rule added.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/mapping/rules")?.body).toEqual({
      kind: "service",
      field: "argocd.label:team",
      match: "glob",
      pattern: "pay*",
      caseSensitive: false,
      targetId: "api",
      enabled: true,
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "New rule" })).toBeNull());
  });

  it("reorders and deletes rules", async () => {
    render(<App />);
    await screen.findByText("acme/api");
    const svcRules = screen.getByRole("region", { name: "Service rules" });
    fireEvent.click(within(svcRules).getByRole("button", { name: "Move rule 2 up" }));
    await screen.findByText("Rule order saved.");
    expect(calls.find((c) => c.url === "/api/mapping/rules/reorder")?.body).toEqual({
      kind: "service",
      ids: ["r2", "r1"],
    });
    fireEvent.click(within(svcRules).getByRole("button", { name: "Delete rule acme/api" }));
    await screen.findByText("Rule deleted.");
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/mapping/rules/r2")).toBe(true);
  });

  it("creates a rule from an unmapped value", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Create rule from argocd.application payments" }),
    );
    expect(screen.getByRole("heading", { name: "New rule" })).toBeTruthy();
    expect((screen.getByLabelText("Pattern") as HTMLInputElement).value).toBe("payments");
    expect((screen.getByLabelText("Assigns") as HTMLSelectElement).value).toBe("service");
  });
});
