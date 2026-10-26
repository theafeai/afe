/**
 * A tiny History API router (no dependency). Paths are real URLs, not hashes,
 * because the server redirects to UI paths after install/OAuth callbacks
 * (e.g. `/connections/vercel/<id>/projects`) and serves `index.html` for them.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

export interface Location {
  pathname: string;
  search: string;
}

interface RouterValue {
  location: Location;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function current(): Location {
  return { pathname: window.location.pathname, search: window.location.search };
}

export function Router({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(current);

  useEffect(() => {
    const onPop = () => setLocation(current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback(
    (to: string, options?: { replace?: boolean }) => {
      const target = new URL(to, window.location.href);
      const next = target.pathname + target.search + target.hash;
      const now = window.location.pathname + window.location.search + window.location.hash;
      if (next !== now) {
        if (options?.replace) window.history.replaceState(null, "", next);
        else window.history.pushState(null, "", next);
      }
      setLocation(current());
      if (!options?.replace && target.pathname !== location.pathname) window.scrollTo(0, 0);
    },
    [location.pathname],
  );

  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouter(): RouterValue {
  const v = useContext(RouterContext);
  if (!v) throw new Error("useRouter outside <Router>");
  return v;
}

export const useLocation = () => useRouter().location;
export const useNavigate = () => useRouter().navigate;

/** The current query string, and a setter that replaces it (keeping history short). */
export function useSearchParams(): [
  URLSearchParams,
  (next: URLSearchParams, options?: { replace?: boolean }) => void,
] {
  const { location, navigate } = useRouter();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const set = useCallback(
    (next: URLSearchParams, options?: { replace?: boolean }) => {
      const q = next.toString();
      navigate(`${location.pathname}${q ? `?${q}` : ""}`, options);
    },
    [location.pathname, navigate],
  );
  return [params, set];
}

/**
 * Matches `pattern` (e.g. `/connections/vercel/:id/projects`) against a path.
 * Returns decoded params or null.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const trim = (s: string) => (s.length > 1 ? s.replace(/\/+$/, "") : s);
  const p = trim(pattern).split("/");
  const a = trim(pathname).split("/");
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const val = a[i]!;
    if (seg.startsWith(":")) {
      if (!val) return null;
      try {
        params[seg.slice(1)] = decodeURIComponent(val);
      } catch {
        return null;
      }
    } else if (seg !== val) return null;
  }
  return params;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** In-app link: plain `<a href>` (works with middle-click, copy link) plus client navigation. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const navigate = useNavigate();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      rest.target
    ) {
      return;
    }
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
