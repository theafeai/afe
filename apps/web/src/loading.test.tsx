// @vitest-environment jsdom
import { StrictMode, useLayoutEffect } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ApiError } from "./api/client.ts";
import type { Page } from "./api/types.ts";
import { useAsync } from "./components.tsx";
import { usePaged } from "./usePaged.ts";

afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("never commits a previous resource under the new identity, including ignored aborts", async () => {
  const requests: ReturnType<typeof deferred<string>>[] = [];
  const commits: { key: string; data: string | null; loading: boolean }[] = [];
  const { result, rerender } = renderHook(
    ({ resource }) => {
      const state = useAsync(() => {
        const request = deferred<string>();
        requests.push(request);
        return request.promise;
      }, [resource]);
      useLayoutEffect(() => {
        commits.push({ key: resource, data: state.data, loading: state.loading });
      });
      return state;
    },
    { initialProps: { resource: "a" }, wrapper: StrictMode },
  );
  await act(async () => requests.at(-1)!.resolve("A"));
  expect(result.current.data).toBe("A");
  rerender({ resource: "b" });
  expect(result.current).toMatchObject({ data: null, loading: true, error: null });
  rerender({ resource: "c" });
  await act(async () => requests.at(-2)!.resolve("B"));
  expect(result.current.data).toBeNull();
  await act(async () => requests.at(-1)!.resolve("C"));
  expect(result.current.data).toBe("C");
  expect(
    commits
      .filter((c) => c.key === "b" || c.key === "c")
      .some((c) => c.data === "A" || c.data === "B"),
  ).toBe(false);
});

it("retains same-resource data on refresh and transient error, but clears revoked data", async () => {
  let request = deferred<string>();
  const { result, rerender } = renderHook(
    ({ refresh }) => useAsync(() => request.promise, ["a"], refresh),
    { initialProps: { refresh: 0 } },
  );
  await act(async () => request.resolve("valid"));
  request = deferred<string>();
  rerender({ refresh: 1 });
  expect(result.current).toMatchObject({ data: "valid", loading: true });
  await act(async () => request.reject(new Error("Offline")));
  expect(result.current).toMatchObject({
    data: "valid",
    loading: false,
    error: { message: "Offline" },
  });
  request = deferred<string>();
  act(() => result.current.reload());
  await act(async () => request.reject(new ApiError(403, "forbidden", "Revoked")));
  expect(result.current).toMatchObject({
    data: null,
    loading: false,
    error: { message: "Revoked" },
  });
});

it("distinguishes unresolved data from an empty result", async () => {
  const request = deferred<string[]>();
  const { result } = renderHook(() => useAsync(() => request.promise, []));
  expect(result.current).toMatchObject({ data: null, loading: true });
  await act(async () => request.resolve([]));
  expect(result.current).toMatchObject({ data: [], loading: false, error: null });
});

it("cancels pagination on filter changes and refresh, and does not leak old items or cursors", async () => {
  const requests: {
    params: URLSearchParams;
    signal: AbortSignal;
    request: ReturnType<typeof deferred<Page<string>>>;
  }[] = [];
  const fetchPage = (params: URLSearchParams, signal: AbortSignal) => {
    const request = deferred<Page<string>>();
    requests.push({ params, signal, request });
    return request.promise;
  };
  const page = (items: string[], nextCursor: string | null): Page<string> => ({
    items,
    nextCursor,
    snapshotSeq: 1,
  });
  const { result, rerender } = renderHook(
    ({ key }) => usePaged(key, () => new URLSearchParams({ source: key }), fetchPage),
    { initialProps: { key: "a" } },
  );
  await act(async () => requests[0]!.request.resolve(page(["a1"], "cursor-a")));
  act(() => {
    result.current.loadMore();
    result.current.loadMore();
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]!.params.get("source")).toBe("a");
  expect(requests[1]!.params.get("cursor")).toBe("cursor-a");
  rerender({ key: "b" });
  expect(requests[1]!.signal.aborted).toBe(true);
  expect(result.current).toMatchObject({
    items: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
  });
  await act(async () => requests[1]!.request.resolve(page(["old a"], "wrong")));
  await act(async () => requests[2]!.request.resolve(page(["b1"], "cursor-b")));
  expect(result.current.items).toEqual(["b1"]);
  act(() => result.current.loadMore());
  act(() => result.current.reload());
  expect(requests[3]!.signal.aborted).toBe(true);
  expect(result.current).toMatchObject({ items: ["b1"], loading: true, loadingMore: false });
  await act(async () => requests[3]!.request.resolve(page(["old b"], "wrong")));
  await act(async () => requests[4]!.request.resolve(page(["fresh b"], null)));
  expect(result.current).toMatchObject({
    items: ["fresh b"],
    loading: false,
    loadingMore: false,
    hasMore: false,
  });
});
