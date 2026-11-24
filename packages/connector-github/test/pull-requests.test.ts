/**
 * `pull_requests: read` in the default App manifest.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryEventSink } from "@afe/core";
import { Secret } from "@afe/core/security";
import {
  GitHubAppClient,
  OPTIONAL_PERMISSION_NOTICES,
  OPTIONAL_SUBSCRIBED_EVENTS,
  REQUESTED_OPTIONAL_PERMISSIONS,
  SUBSCRIBED_EVENTS,
  buildAppManifest,
  checkPermissions,
  createMemoryPollStateStore,
  githubRawPayload,
  mapWebhookDelivery,
  reconcileRepository,
} from "../src/index.ts";
import { FakeGitHubApi } from "./fake-repo-api.ts";
import { testKeyPair } from "./fixtures.ts";
import { loadWebhook } from "./fixtures/webhooks.ts";
import { NOW, REPO, orgActivity, pullRequestRepoEvent } from "./reconcile-scenario.ts";

/** Any request for pull request files, diffs or patches (path or media type). */
const FORBIDDEN_PATH = /\/pulls\/\d+\/files|\/pulls\/\d+\.(diff|patch)$|\.(diff|patch)$/;
const FORBIDDEN_ACCEPT = /vnd\.github(\.v3)?\.(diff|patch)/;

describe("default manifest", () => {
  it("requests pull_requests: read, keeps contents optional and stays read-only", () => {
    const m = buildAppManifest({ publicUrl: "https://afe.example.com" });
    expect(m.default_permissions).toMatchObject({ pull_requests: "read" });
    expect(m.default_permissions).not.toHaveProperty("contents");
    expect(new Set(Object.values(m.default_permissions))).toEqual(new Set(["read"]));
    expect(REQUESTED_OPTIONAL_PERMISSIONS).not.toHaveProperty("contents");
  });

  it("subscribes to pull_request only, not reviews or comments", () => {
    const m = buildAppManifest({ publicUrl: "https://afe.example.com" });
    expect(m.default_events).toContain("pull_request");
    for (const e of ["pull_request_review", "pull_request_review_comment", "pull_request_target"])
      expect(m.default_events).not.toContain(e);
    expect(m.default_events).toEqual([...SUBSCRIBED_EVENTS, ...OPTIONAL_SUBSCRIBED_EVENTS]);
    expect(m.default_events).not.toContain("push");
  });

  it("existing installs without the permission get the upgrade notice and stay ok", () => {
    const check = checkPermissions({
      actions: "read",
      deployments: "read",
      environments: "read",
      metadata: "read",
      packages: "read",
      attestations: "read",
    });
    expect(check.ok).toBe(true);
    expect(check.optionalNotices).toEqual([
      { permission: "pull_requests", message: OPTIONAL_PERMISSION_NOTICES.pull_requests },
    ]);
    const text = OPTIONAL_PERMISSION_NOTICES.pull_requests!;
    expect(text).toContain("Pull requests: read");
    expect(text).toMatch(/never reads pull request files, diffs or patches/);
    expect(text).toMatch(/does not store pull request bodies/);
    expect(text).toMatch(/no write access/);
    // Installs that granted it see no notice; contents never gets one (not requested).
    expect(checkPermissions({ metadata: "read", pull_requests: "read" }).optionalNotices).toBe(
      undefined,
    );
  });
});

describe("pull_request events", () => {
  it("are mapped with the body stripped from the raw payload and from data", () => {
    const f = loadWebhook("pull_request.opened");
    const rawBody = JSON.stringify(f.payload);
    expect(rawBody).toContain('"body"');
    const r = mapWebhookDelivery({
      event: f.event,
      payload: f.payload,
      rawBody,
      deliveryId: "11111111-2222-3333-4444-555555555555",
      receivedAt: "2026-10-26T10:05:00.000Z",
      connectionId: "conn-1",
    });
    expect(r.status).toBe("mapped");
    if (r.status !== "mapped") return;
    for (const e of r.events) {
      const raw = String(e.rawPayload?.body ?? "");
      expect(raw).not.toContain("Implements login");
      expect(raw).not.toContain("bob@example.com");
      expect(JSON.stringify(e.data)).not.toContain("Implements login");
    }
    expect(githubRawPayload(rawBody, f.payload).stripped).toContain("pull_request.body");
  });
});

describe("Afe never requests pull request files, diffs or patches (R1.4 style)", () => {
  it("reconciliation with pull_requests granted issues no such request", async () => {
    const api = new FakeGitHubApi();
    const { privatePem } = testKeyPair();
    const app = new GitHubAppClient(
      { appId: "77", privateKey: new Secret(privatePem) },
      { fetch: api.fetch, sleep: async () => {}, clock: () => NOW.getTime() },
    );
    const repo = orgActivity(api);
    repo.events.push(pullRequestRepoEvent());
    await reconcileRepository(
      {
        client: app.installation(4242, { tenantId: "default" }),
        sink: createMemoryEventSink(),
        state: createMemoryPollStateStore(),
        recorded: async () => new Set(),
      },
      {
        tenantId: "default",
        connectionId: "conn-1",
        repository: REPO,
        mode: "reconciliation",
        from: new Date(NOW.getTime() - 24 * 3600_000),
        to: NOW,
        conditional: true,
        pullRequests: true,
        pushes: true,
        now: NOW,
      },
    );
    expect(api.apiRequests.length).toBeGreaterThan(0);
    for (const r of api.apiRequests) {
      expect(r.method).toBe("GET");
      expect(r.path).not.toMatch(FORBIDDEN_PATH);
      expect(String(r.headers.accept ?? "")).not.toMatch(FORBIDDEN_ACCEPT);
    }
  });

  it("no GitHub client or server source builds such a request", () => {
    const roots = [
      new URL("../src/", import.meta.url),
      new URL("../../../apps/server/src/connectors/", import.meta.url),
      new URL("../../../apps/server/src/actions/", import.meta.url),
    ];
    const files = roots.flatMap((root) =>
      readdirSync(root)
        .filter((f) => f.endsWith(".ts") && (root.pathname.endsWith("/src/") || /github/.test(f)))
        .map((f) => new URL(f, root)),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file.pathname).not.toMatch(/\/pulls\/[^"'`\n]*\/files/);
      expect(text, file.pathname).not.toMatch(/pulls\/\$\{[^}]+\}\.(diff|patch)/);
      expect(text, file.pathname).not.toMatch(FORBIDDEN_ACCEPT);
    }
  });
});
