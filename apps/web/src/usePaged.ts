import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "./api/types.ts";
import { useAsync } from "./components.tsx";

export interface Paged<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/** Cursor pages share the first request's parameters and lifetime. */
export function usePaged<T>(
  key: string,
  makeParams: () => URLSearchParams,
  fetchPage: (params: URLSearchParams, signal: AbortSignal) => Promise<Page<T>>,
  pageSize = 50,
): Paged<T> {
  const first = useAsync(
    async (signal) => {
      const params = makeParams();
      params.set("limit", String(pageSize));
      return { page: await fetchPage(params, signal), params };
    },
    [key, pageSize],
  );
  const [more, setMore] = useState<{
    base: typeof first.data;
    items: T[];
    cursor: string | null;
    loading: boolean;
    error: Error | null;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  // Refreshing or changing filters cancels pending pagination too, including
  // transports which do not honour abort (their results are checked below).
  useEffect(() => {
    if (first.loading)
      setMore((previous) => (previous?.loading ? { ...previous, loading: false } : previous));
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [key, pageSize, first.data, first.loading]);
  const current = first.data && more?.base === first.data ? more : null;
  const cursor = current ? current.cursor : (first.data?.page.nextCursor ?? null);
  const loadMore = useCallback(() => {
    if (!first.data || first.loading || !cursor || controller.current) return;
    const base = first.data;
    const c = new AbortController();
    controller.current = c;
    const params = new URLSearchParams(base.params);
    params.set("cursor", cursor);
    setMore((previous) => ({
      base,
      items: previous?.base === base ? previous.items : [],
      cursor,
      loading: true,
      error: null,
    }));
    fetchRef.current(params, c.signal).then(
      (page) => {
        if (c.signal.aborted) return;
        controller.current = null;
        setMore((previous) => ({
          base,
          items: [...(previous?.base === base ? previous.items : []), ...page.items],
          cursor: page.nextCursor,
          loading: false,
          error: null,
        }));
      },
      (error: unknown) => {
        if (c.signal.aborted) return;
        controller.current = null;
        setMore((previous) => ({
          base,
          items: previous?.base === base ? previous.items : [],
          cursor,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      },
    );
  }, [first.data, first.loading, cursor]);
  return {
    items: [...(first.data?.page.items ?? []), ...(current?.items ?? [])],
    loading: first.loading,
    loadingMore: current?.loading ?? false,
    error: first.error ?? current?.error ?? null,
    hasMore: cursor !== null && !first.loading,
    loadMore,
    reload: first.reload,
  };
}
