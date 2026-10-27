import { useCallback, useEffect, useState } from "react";
import { api, ApiError, onUnauthorized } from "./api/client.ts";
import type { SessionInfo } from "./api/types.ts";
import { Empty } from "./components.tsx";
import {
  ConnectArgoCD,
  ConnectGitHub,
  ConnectVercel,
  VercelProjectsPage,
} from "./pages/Connect.tsx";
import { ConnectionDetail, Connections } from "./pages/Connections.tsx";
import { Deployments } from "./pages/Deployments.tsx";
import { EventDetailPage } from "./pages/EventDetail.tsx";
import { JourneyPage } from "./pages/Journey.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { MappingPage } from "./pages/Mapping.tsx";
import { Timeline } from "./pages/Timeline.tsx";
import { Link, matchPath, Router, useLocation, useNavigate } from "./router.tsx";

/**
 * Client routes. The server serves index.html for every path under these
 * roots (CLIENT_ROUTE_ROOTS in apps/server/src/web.ts), and redirects there
 * after install flows: GitHub → /connections/<id>?connected=github or
 * /connections/github?status|error=…; Vercel → /connections/vercel/<id>/projects.
 */
export function Routes() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (pathname === "/" || pathname === "") navigate("/events", { replace: true });
  }, [pathname, navigate]);

  let m: Record<string, string> | null;
  if (pathname === "/" || matchPath("/events", pathname)) return <Timeline />;
  if ((m = matchPath("/events/:id", pathname))) return <EventDetailPage key={m.id} id={m.id!} />;
  if (matchPath("/deployments", pathname)) return <Deployments />;
  if (matchPath("/journeys", pathname)) return <JourneyPage />;
  if (matchPath("/connections", pathname)) return <Connections />;
  if (matchPath("/settings/mapping", pathname)) return <MappingPage />;
  if (matchPath("/connections/github", pathname)) return <ConnectGitHub />;
  if (matchPath("/connections/argocd", pathname)) return <ConnectArgoCD />;
  if (matchPath("/connections/vercel", pathname)) return <ConnectVercel />;
  if ((m = matchPath("/connections/vercel/:id/projects", pathname)))
    return <VercelProjectsPage key={m.id} id={m.id!} />;
  if ((m = matchPath("/connections/:id", pathname)))
    return <ConnectionDetail key={m.id} id={m.id!} />;
  return (
    <div className="page">
      <Empty title="Page not found">
        <p>
          <Link to="/events">Go to the event timeline</Link>
        </p>
      </Empty>
    </div>
  );
}

const NAV = [
  { to: "/events", label: "Events" },
  { to: "/deployments", label: "Deployments" },
  { to: "/connections", label: "Connections" },
  { to: "/settings/mapping", label: "Mapping" },
];

function Nav({ session, onLogout }: { session: SessionInfo | null; onLogout: () => void }) {
  const { pathname } = useLocation();
  return (
    <header className="site-header">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Link to="/events" className="brand" aria-label="Afe home">
        Afe
      </Link>
      <nav aria-label="Main">
        <ul>
          {NAV.map((n) => {
            const active = pathname === n.to || pathname.startsWith(`${n.to}/`);
            return (
              <li key={n.to}>
                <Link to={n.to} aria-current={active ? "page" : undefined}>
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {session && (
        <div className="session">
          <span className="muted">
            {session.principal.roles.includes("admin") ? "Admin" : "Viewer (read-only)"}
          </span>
          {session.principal.kind === "session" && (
            <button type="button" className="btn" onClick={onLogout}>
              Sign out
            </button>
          )}
        </div>
      )}
    </header>
  );
}

/**
 * Session state (ADR 0006): the app asks `GET /api/session` once; when it, or
 * any later API call, answers 401 the login screen is shown. Until then the
 * app renders normally (no flash of the login screen for a signed-in user).
 */
type AuthState =
  { status: "unknown" } | { status: "anonymous" } | { status: "signed-in"; session: SessionInfo };

function Shell() {
  const [auth, setAuth] = useState<AuthState>({ status: "unknown" });
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const off = onUnauthorized(() => setAuth({ status: "anonymous" }));
    const ctrl = new AbortController();
    api
      .session(ctrl.signal)
      .then((session) => {
        // Ignore unexpected bodies (e.g. a proxy page); 401s are handled below.
        if (Array.isArray(session?.principal?.roles)) setAuth({ status: "signed-in", session });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setAuth({ status: "anonymous" });
      });
    return () => {
      off();
      ctrl.abort();
    };
  }, []);

  // Signed in already: the login URL just continues to the app.
  useEffect(() => {
    if (auth.status === "signed-in" && pathname === "/login") {
      navigate("/events", { replace: true });
    }
  }, [auth.status, pathname, navigate]);

  const logout = useCallback(() => {
    void api
      .logout()
      .catch(() => {})
      .finally(() => setAuth({ status: "anonymous" }));
  }, []);

  if (auth.status === "anonymous" || (auth.status === "unknown" && pathname === "/login")) {
    return (
      <main id="main" tabIndex={-1}>
        <LoginPage onLogin={(session) => setAuth({ status: "signed-in", session })} />
      </main>
    );
  }
  return (
    <>
      <Nav session={auth.status === "signed-in" ? auth.session : null} onLogout={logout} />
      <main id="main" tabIndex={-1}>
        <Routes />
      </main>
    </>
  );
}

export function App() {
  return (
    <Router>
      <Shell />
    </Router>
  );
}
