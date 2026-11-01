import { describe, expect, it } from "vitest";
import {
  permitsToolAction,
  permitsGitHubAction,
  TOOL_PERMISSION_MODES,
} from "./tool-permissions.ts";

describe("tool permissions", () => {
  const read = { resource: "org/private", action: "read" };
  const other = { resource: "org/other", action: "read" };
  it("denies missing policy even for a linked account", () => {
    expect(permitsToolAction(null, read, { verified: true, grants: [read] })).toBe(false);
  });
  it.each(TOOL_PERMISSION_MODES)("evaluates %s independently for source and custom", (mode) => {
    const policy = { mode, custom: [other] };
    const source = { verified: true, grants: [read] };
    expect(permitsToolAction(policy, read, source)).toBe(
      mode === "source" || mode === "source + custom",
    );
    expect(permitsToolAction(policy, other, source)).toBe(
      mode === "custom" || mode === "source + custom",
    );
    expect(permitsToolAction(policy, read, { ...source, verified: false })).toBe(false);
    expect(permitsToolAction(policy, { ...read, action: "write" }, source)).toBe(false);
    expect(permitsToolAction(policy, { resource: "org", action: "read" }, source)).toBe(false);
  });
});

it("inherits GitHub actions only in Source mode and applies exact restrictions first", () => {
  const action = "github.rerun" as const;
  const grant = { resource: "repository:acme/app", action };
  expect(permitsGitHubAction({ mode: "source", custom: [] }, "acme/app", action)).toBe(true);
  for (const mode of ["custom", "source + custom"] as const) {
    expect(permitsGitHubAction({ mode, custom: [] }, "acme/app", action)).toBe(false);
    expect(permitsGitHubAction({ mode, custom: [grant] }, "acme/app", action)).toBe(true);
    expect(
      permitsGitHubAction({ mode, custom: [grant], denied: [grant] }, "acme/app", action),
    ).toBe(false);
  }
  expect(
    permitsGitHubAction({ mode: "source", custom: [], denied: [grant] }, "acme/app", action),
  ).toBe(false);
  expect(
    permitsGitHubAction({ mode: "source", custom: [], denied: [grant] }, "acme/other", action),
  ).toBe(true);
  expect(
    permitsGitHubAction(
      { mode: "source", custom: [], denied: [grant] },
      "acme/app",
      "github.cancel",
    ),
  ).toBe(true);
  expect(permitsGitHubAction({ mode: "none", custom: [grant] }, "acme/app", action)).toBe(false);
});
