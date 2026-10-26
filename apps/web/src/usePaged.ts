import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "./api/types.ts";

export interface Paged<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Cursor pagination (docs/api.md "Pagination"). The first page is fetched
 * whenever `key` changes; "load more" re-sends exactly the parameters of the
 * first page (a relative time range is resolved once, so the cursor's query
 * fingerprint stays the same) plus the cursor.
 */
export function usePaged<T>(
  key: string,
  makeParams: () => URLSearchParams,
  fetchPage: (params: URLSearchParams, signal: AbortSignal) => Promise<Page<T>>,
  pageSize = 50,
): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const params = useRef<URLSearchParams>(new URLSearchParams());
  const ctrl = useRef<AbortController | null>(null);
  const makeRef = useRef(makeParams);
  makeRef.current = makeParams;
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const p = makeRef.current();
    p.set("limit", String(pageSize));
    params.current = p;
    setLoading(true);
    setError(null);
    setItems([]);
    setCursor(null);
    fetchRef.current(p, c.signal).then(
      (page) => {
        if (c.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      },
      (err: unknown) => {
        if (c.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      },
    );
    return () => c.abort();
  }, [key, tick, pageSize]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const c = new AbortController();
    ctrl.current = c;
    const p = new URLSearchParams(params.current);
    p.set("cursor", cursor);
    setLoadingMore(true);
    setError(null);
    fetchRef.current(p, c.signal).then(
      (page) => {
        if (c.signal.aborted) return;
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
        setLoadingMore(false);
      },
      (err: unknown) => {
        if (c.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoadingMore(false);
      },
    );
  }, [cursor, loadingMore]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { items, loading, loadingMore, error, hasMore: cursor !== null, loadMore, reload };
}
