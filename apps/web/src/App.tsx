import { AccessContext, useAccess, type ProfileInfo } from "./access.tsx";
import { UsersPage } from "./pages/Users.tsx";
import { ProfilePage } from "./pages/Profile.tsx";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, onUnauthorized, request } from "./api/client.ts";
import type { SessionInfo } from "./api/types.ts";
import { Empty, ErrorBox } from "./components.tsx";
import { BrandMark, icons } from "./icons.tsx";
import {
  ConnectArgoCD,
  ConnectGitHub,
  ConnectVercel,
  VercelProjectsPage,
} from "./pages/Connect.tsx";
import { ConnectionDetail, Connections } from "./pages/Connections.tsx";
import { ConnectTerraform } from "./pages/ConnectTerraform.tsx";
import { Deployments } from "./pages/Deployments.tsx";
import { EnvironmentMatrix } from "./pages/EnvironmentMatrix.tsx";
import { DriftFindingPage, DriftPage } from "./pages/Drift.tsx";
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
  const { admin } = useAccess();
  if (pathname === "/users") return <UsersPage />;
  if (pathname === "/profile") return <ProfilePage />;
  if (!admin && /^\/connections\/(github|vercel|argocd|terraform)(\/|$)/.test(pathname))
    return <div className="page">This view is unavailable for this account.</div>;

  let m: Record<string, string> | null;
  if (pathname === "/" || pathname === "") return <EnvironmentMatrix />;
  if (matchPath("/events", pathname)) return <Timeline />;
  if ((m = matchPath("/events/:id", pathname))) return <EventDetailPage key={m.id} id={m.id!} />;
  if (matchPath("/deployments", pathname)) return <Deployments />;
  if (matchPath("/journeys", pathname)) return <JourneyPage />;
  if (matchPath("/drift", pathname)) return <DriftPage />;
  if ((m = matchPath("/drift/:id", pathname))) return <DriftFindingPage key={m.id} id={m.id!} />;
  if (matchPath("/connections", pathname)) return <Connections />;
  if (matchPath("/settings/mapping", pathname)) return <MappingPage />;
  if (matchPath("/connections/github", pathname)) return <ConnectGitHub />;
  if (matchPath("/connections/argocd", pathname)) return <ConnectArgoCD />;
  if (matchPath("/connections/vercel", pathname)) return <ConnectVercel />;
  if (matchPath("/connections/terraform", pathname)) return <ConnectTerraform />;
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
  { to: "/", label: "Environments", icon: icons.environments, group: "observe" },
  { to: "/events", label: "Events", icon: icons.events, group: "observe" },
  { to: "/deployments", label: "Deployments", icon: icons.deployments, group: "observe" },
  { to: "/drift", label: "Drift", icon: icons.drift, group: "observe" },
  { to: "/connections", label: "Connections", icon: icons.connections, group: "setup" },
  { to: "/settings/mapping", label: "Mapping", icon: icons.mapping, group: "setup" },
] as const;

const NAV_GROUPS = [
  { id: "observe", label: "Observe" },
  { id: "setup", label: "Setup" },
] as const;

function NavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const { pathname } = useLocation();
  const active = pathname === to || pathname.startsWith(`${to}/`);
  return (
    <li>
      <Link to={to} aria-current={active ? "page" : undefined}>
        {icon}
        {label}
      </Link>
    </li>
  );
}

function Nav({ session, onLogout }: { session: SessionInfo | null; onLogout: () => void }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const admin = session?.principal.roles.includes("admin") ?? false;
  const name = session?.principal.name ?? (admin ? "Administrator" : "Viewer");
  return (
    <header className={open ? "sidebar open" : "sidebar"}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="sidebar-top">
        <Link to="/" className="brand" aria-label="Afe home">
          <BrandMark />
          afe
        </Link>
        <button
          type="button"
          className="btn btn-ghost btn-icon nav-toggle"
          aria-expanded={open}
          aria-controls="main-nav"
          aria-label="Menu"
          onClick={() => setOpen((o) => !o)}
        >
          {icons.menu}
        </button>
      </div>
      <nav aria-label="Main" id="main-nav">
        {NAV_GROUPS.map((g) => {
          const groupItems = NAV.filter((n) => n.group === g.id);
          if (groupItems.length === 0) return null;
          return (
            <div className="nav-group" key={g.id}>
              <p className="nav-heading" id={`nav-${g.id}`}>
                {g.label}
              </p>
              <ul aria-labelledby={`nav-${g.id}`}>
                {groupItems.map((n) => (
                  <NavLink key={n.to} {...n} />
                ))}
              </ul>
            </div>
          );
        })}
        <div className="nav-group">
          <p className="nav-heading" id="nav-account">
            Account
          </p>
          <ul aria-labelledby="nav-account">
            <NavLink to="/profile" label="Profile" icon={icons.profile} />
            {admin && <NavLink to="/users" label="Users" icon={icons.users} />}
          </ul>
        </div>
      </nav>
      {session && (
        <div className="session">
          <span className="avatar" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="session-who">
            <span className="session-name">{name}</span>
            <span className="session-role">{admin ? "Admin" : "Viewer (read-only)"}</span>
          </span>
          {session.principal.kind === "session" && (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={onLogout}
              aria-label="Sign out"
              title="Sign out"
            >
              {icons.signOut}
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
  const [sessionError, setSessionError] = useState<Error | null>(null);
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
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
        else setSessionError(new Error("The server sent an invalid session response."));
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setAuth({ status: "anonymous" });
        else if (!(err instanceof DOMException && err.name === "AbortError"))
          setSessionError(err instanceof Error ? err : new Error("Could not load session."));
      });
    return () => {
      off();
      ctrl.abort();
    };
  }, []);

  useEffect(() => {
    setProfile(null);
    if (auth.status !== "signed-in" || !auth.session.principal.managedUser) return;
    const ctrl = new AbortController();
    void request<ProfileInfo>("GET", "/api/profile", undefined, ctrl.signal)
      .then(setProfile)
      .catch(() => {});
    return () => ctrl.abort();
  }, [auth]);

  // Signed in already: the login URL just continues to the app.
  useEffect(() => {
    if (auth.status === "signed-in" && pathname === "/login") {
      navigate("/", { replace: true });
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
    <div className="app">
      <Nav session={auth.status === "signed-in" ? auth.session : null} onLogout={logout} />
      <main id="main" tabIndex={-1}>
        {auth.status === "unknown" ? (
          sessionError ? (
            <ErrorBox
              error={sessionError}
              onRetry={() => window.location.reload()}
              title="Could not load your session"
            />
          ) : (
            <p className="state shell-state">Loading session…</p>
          )
        ) : (
          <AccessContext.Provider value={{ session: auth.session, profile }}>
            <Routes />
          </AccessContext.Provider>
        )}
      </main>
    </div>
  );
}

export function App() {
  return (
    <Router>
      <Shell />
    </Router>
  );
}
