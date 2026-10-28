import { describe, expect, it } from "vitest";
import { permitsToolAction, TOOL_PERMISSION_MODES } from "./tool-permissions.ts";

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
