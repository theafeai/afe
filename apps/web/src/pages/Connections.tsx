import { useState } from "react";
import { api } from "../api/client.ts";
import type { ConnectionWithHealth } from "../api/types.ts";
import {
  Empty,
  ErrorBox,
  GapBanners,
  HealthBadge,
  KeyValue,
  Loading,
  StatusBadge,
  ToolBadge,
  gapReason,
  toolLabel,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { formatDateTime, formatDuration, formatRelative, humanize } from "../format.ts";
import { Link, useLocation, useNavigate } from "../router.tsx";

const TOOLS = [
  { id: "github", label: "GitHub", blurb: "GitHub App with read-only permissions." },
  { id: "argocd", label: "ArgoCD", blurb: "Read-only API token for an ArgoCD instance." },
  { id: "vercel", label: "Vercel", blurb: "Vercel Integration or an access token." },
  { id: "terraform", label: "Terraform", blurb: "Signed lifecycle reports from local or CI runs." },
];

export function ConnectButtons() {
  return (
    <div className="connect-buttons">
      {TOOLS.map((t) => (
        <Link key={t.id} to={`/connections/${t.id}`} className={`connect-card tool-${t.id}`}>
          <strong>Connect {t.label}</strong>
          <span className="small muted">{t.blurb}</span>
        </Link>
      ))}
    </div>
  );
}

function GapCell({ c }: { c: ConnectionWithHealth }) {
  const g = c.health.openGap;
  if (!g) return <span className="muted">none</span>;
  return (
    <span className="gap-cell">
      <strong>Open</strong> since {formatDateTime(g.startedAt)} ({formatRelative(g.startedAt)},{" "}
      {gapReason(g.reason)})
    </span>
  );
}

export function Connections() {
  useDocumentTitle("Connections");
  const { data, error, loading, reload } = useAsync((s) => api.connections(s), []);
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Connections</h1>
          <p className="lede">
            Each connected tool, whether Afe can currently observe it, and any period it could not.
          </p>
        </div>
        <button type="button" className="btn" onClick={reload}>
          Refresh
        </button>
      </header>
      {loading ? (
        <Loading label="Loading connections…" />
      ) : error ? (
        <ErrorBox error={error} onRetry={reload} title="Could not load connections" />
      ) : data && data.connections.length === 0 ? (
        <Empty title="No tools connected">
          <p>Connect at least one tool. Afe only ever asks for read-only access.</p>
          <ConnectButtons />
        </Empty>
      ) : (
        data && (
          <>
            <GapBanners connections={data.connections} />
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Connection</th>
                    <th scope="col">Status</th>
                    <th scope="col">Health</th>
                    <th scope="col">Last successful observation</th>
                    <th scope="col">Observation gap</th>
                    <th scope="col">Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {data.connections.map((c) => (
                    <tr key={c.id} className={c.health.openGap ? "row-has-gap" : undefined}>
                      <td>
                        <ToolBadge source={c.source} />{" "}
                        <Link to={`/connections/${c.id}`}>{c.name}</Link>
                      </td>
                      <td>
                        <StatusBadge status={c.status} />
                      </td>
                      <td>
                        <HealthBadge state={c.health.state} />
                      </td>
                      <td>
                        {c.health.lastSuccessAt ? (
                          <time dateTime={c.health.lastSuccessAt} title={c.health.lastSuccessAt}>
                            {formatRelative(c.health.lastSuccessAt)}
                          </time>
                        ) : (
                          <span className="muted">never</span>
                        )}
                      </td>
                      <td>
                        <GapCell c={c} />
                      </td>
                      <td>
                        {c.alert ? <span className="alert-tag">{c.alert.message}</span> : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h2>Add a connection</h2>
            <ConnectButtons />
          </>
        )
      )}
    </div>
  );
}

function DisconnectSection({ c, onDone }: { c: ConnectionWithHealth; onDone: () => void }) {
  const [state, setState] = useState<{ busy: boolean; error: Error | null; note: string | null }>({
    busy: false,
    error: null,
    note: null,
  });
  if (c.status === "disconnected") {
    return (
      <p className="muted">
        Disconnected{c.statusReason ? ` (${c.statusReason})` : ""}. Afe has deleted its credentials;
        events recorded before are kept until they leave the retention window.
      </p>
    );
  }
  if (c.source === "github") {
    return (
      <p>
        To disconnect, uninstall the Afe GitHub App from <strong>{c.name}</strong> on GitHub (
        <em>Settings → GitHub Apps</em> for an organization or your account). Afe records the
        uninstall and marks this connection revoked. Events recorded before are kept until they
        leave the retention window.
      </p>
    );
  }
  if (c.source !== "argocd" && c.source !== "vercel" && c.source !== "terraform") return null;
  const run = async () => {
    if (
      !window.confirm(
        `Disconnect ${toolLabel(c.source)} “${c.name}”? Afe deletes its credentials and stops observing it. Recorded events are kept.`,
      )
    )
      return;
    setState({ busy: true, error: null, note: null });
    try {
      const note =
        c.source === "argocd"
          ? (await api.argocdDisconnect(c.id),
            "Afe deleted its copy of the API token. You can also delete the token in ArgoCD.")
          : c.source === "terraform"
            ? (await api.terraformDisconnect(c.id)).note
            : ((await api.vercelDisconnect(c.id)).note ?? "Disconnected.");
      setState({ busy: false, error: null, note });
      onDone();
    } catch (err) {
      setState({ busy: false, error: err as Error, note: null });
    }
  };
  return (
    <>
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => void run()}
        disabled={state.busy}
      >
        {state.busy ? "Disconnecting…" : "Disconnect"}
      </button>
      {state.note && (
        <p className="callout callout-ok" role="status">
          {state.note}
        </p>
      )}
      {state.error && <ErrorBox error={state.error} title="Could not disconnect" />}
    </>
  );
}

export function ConnectionDetail({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync((s) => api.connectionHealth(id, s), [id]);
  const location = useLocation();
  const navigate = useNavigate();
  const justConnected = new URLSearchParams(location.search).get("connected");
  useDocumentTitle(data ? data.connection.name : "Connection");
  if (loading) return <Loading label="Loading connection…" />;
  if (error)
    return (
      <div className="page">
        <p>
          <Link to="/connections">← Connections</Link>
        </p>
        <ErrorBox error={error} onRetry={reload} title="Could not load this connection" />
      </div>
    );
  if (!data) return null;
  const c = data.connection;
  const h = c.health;
  return (
    <div className="page">
      <p>
        <Link to="/connections">← Connections</Link>
      </p>
      {justConnected && (
        <div className="callout callout-ok" role="status">
          <strong>{toolLabel(justConnected)} connected.</strong> Afe will start observing it; health
          appears below after the first check.{" "}
          <button
            type="button"
            className="btn-link"
            onClick={() => navigate(location.pathname, { replace: true })}
          >
            Dismiss
          </button>
        </div>
      )}
      <header className="page-header">
        <div>
          <h1>
            <ToolBadge source={c.source} /> {c.name}
          </h1>
          <p className="lede">
            <StatusBadge status={c.status} /> <HealthBadge state={h.state} />{" "}
            {c.statusReason && <span className="muted">{c.statusReason}</span>}
          </p>
        </div>
        <div className="toolbar">
          <Link className="btn" to={`/events?connectionId=${encodeURIComponent(c.id)}`}>
            Events from this connection
          </Link>
          {c.source === "vercel" && c.status === "active" && (
            <Link className="btn" to={`/connections/vercel/${c.id}/projects`}>
              Choose projects
            </Link>
          )}
          {c.source === "argocd" && (
            <Link className="btn" to="/connections/argocd">
              Test or reconnect
            </Link>
          )}
        </div>
      </header>

      {h.openGap && (
        <div className="callout callout-gap" role="status">
          <strong>Observation gap open.</strong> Afe has not been able to observe this connection
          since {formatDateTime(h.openGap.startedAt)} ({formatRelative(h.openGap.startedAt)};{" "}
          {gapReason(h.openGap.reason)}). Events from this period may be missing until it recovers
          and a backfill runs.
        </div>
      )}
      {c.alert && (
        <div className="callout callout-error" role="alert">
          <strong>Alert:</strong> {c.alert.message}
        </div>
      )}

      <div className="grid-2">
        <section className="card">
          <h2>Health</h2>
          <KeyValue
            items={[
              ["State", <HealthBadge key="s" state={h.state} />],
              [
                "Last successful observation",
                h.lastSuccessAt
                  ? `${formatDateTime(h.lastSuccessAt)} (${formatRelative(h.lastSuccessAt)})`
                  : "never",
              ],
              ["Last attempt", formatDateTime(h.lastAttemptAt)],
              ["Last failure", formatDateTime(h.lastFailureAt)],
              [
                "Last error",
                h.lastError
                  ? `${humanize(h.lastErrorReason)}: ${h.lastError}`
                  : humanize(h.lastErrorReason),
              ],
              ["Consecutive failures", String(h.consecutiveFailures)],
              [
                "Next check",
                h.nextAttemptAt
                  ? new Date(h.nextAttemptAt).getTime() <= Date.now()
                    ? `due (scheduled ${formatRelative(h.nextAttemptAt)}; runs on the next worker probe)`
                    : formatRelative(h.nextAttemptAt)
                  : null,
              ],
              [
                "Last backfill",
                h.lastBackfill
                  ? `${h.lastBackfill.status ?? "?"} ${formatDateTime(h.lastBackfill.at)}${h.lastBackfill.error ? ` — ${h.lastBackfill.error}` : ""}`
                  : null,
              ],
            ]}
          />
        </section>
        <section className="card">
          <h2>Connection</h2>
          <KeyValue
            items={[
              ["Tool", toolLabel(c.source)],
              ["External id", <code key="e">{c.externalId}</code>],
              ["Connected", formatDateTime(c.createdAt)],
              ["Afe id", <code key="i">{c.id}</code>],
            ]}
          />
          <h3>Disconnect</h3>
          <DisconnectSection c={c} onDone={reload} />
        </section>
      </div>

      <section className="card">
        <h2>Observation gap history</h2>
        {data.gaps.length === 0 ? (
          <p className="muted">
            No gaps recorded: Afe has not detected a period where it could not observe this
            connection.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">To</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {data.gaps.map((g) => (
                  <tr key={g.gapId} className={g.open ? "row-has-gap" : undefined}>
                    <td>{formatDateTime(g.startedAt)}</td>
                    <td>{g.open ? <strong>still open</strong> : formatDateTime(g.endedAt)}</td>
                    <td>
                      {formatDuration(
                        (g.endedAt ? new Date(g.endedAt).getTime() : Date.now()) -
                          new Date(g.startedAt).getTime(),
                      )}
                    </td>
                    <td>
                      {gapReason(g.reason)}
                      {g.detail && <div className="small muted">{g.detail}</div>}
                    </td>
                    <td>
                      {g.openedEventId && <Link to={`/events/${g.openedEventId}`}>opened</Link>}
                      {g.closedEventId && (
                        <>
                          {" · "}
                          <Link to={`/events/${g.closedEventId}`}>closed</Link>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.alerts.length > 0 && (
        <section className="card">
          <h2>Alerts</h2>
          <ul className="plain">
            {data.alerts.map((a) => (
              <li key={a.id}>
                <strong>{a.resolvedAt ? "Resolved" : "Open"}</strong> — {a.message}{" "}
                <span className="muted small">
                  opened {formatDateTime(a.openedAt)}
                  {a.resolvedAt ? `, resolved ${formatDateTime(a.resolvedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
