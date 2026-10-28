import { expect, it, vi } from "vitest";
import { parseOperation, workflowInputs, validateDispatch } from "../src/operations.ts";
import { GitHubHttp } from "../src/http.ts";
it("uses YAML 1.2 on keys and validates typed dispatch values including false and zero", () => {
  const w = workflowInputs(
    "on:\n  workflow_dispatch:\n    inputs:\n      enabled:\n        type: boolean\n        required: true\n      count:\n        type: number\n        required: true\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n",
  );
  expect(w.dispatchable).toBe(true);
  expect(validateDispatch(w.inputs, { enabled: false, count: 0 })).toEqual({
    enabled: false,
    count: 0,
  });
  expect(() => validateDispatch(w.inputs, { enabled: "false", count: 0 })).toThrow();
});
it("rejects malformed or expanding YAML and unknown workflow operation properties", () => {
  expect(() => workflowInputs("on: workflow_dispatch\njobs: []")).toThrow();
  expect(() => workflowInputs("jobs: {}\njobs: {}")).toThrow();
  expect(() =>
    parseOperation("github.workflow_save", {
      path: "../../private.txt",
      branch: "main",
      content: "secret",
      message: "Edit",
    }),
  ).toThrow();
  expect(() =>
    parseOperation("github.rerun", { runId: 123, attempt: 1, token: "do-not-accept" }),
  ).toThrow();
});
it("never retries mutating methods even when a transport has retries configured", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
  const http = new GitHubHttp({ fetch, maxRetries: 2, sleep: async () => {} });
  for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
    fetch.mockClear();
    await expect(
      http.request({ method, path: "/repos/acme/app/actions/runs/1/cancel" }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  fetch.mockClear();
  await expect(http.request({ method: "GET", path: "/repos/acme/app" })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
});
