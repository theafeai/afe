import { useEffect } from "react";
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
  if (matchPath("/connections", pathname)) return <Connections />;
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
];

function Nav() {
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
    </header>
  );
}

export function App() {
  return (
    <Router>
      <Nav />
      <main id="main" tabIndex={-1}>
        <Routes />
      </main>
    </Router>
  );
}
