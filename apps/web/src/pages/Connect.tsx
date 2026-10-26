import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError, api } from "../api/client.ts";
import type {
  ArgoCdConnectResult,
  ArgoCdTestResult,
  ConnectionWithHealth,
  ProjectSelection,
} from "../api/types.ts";
import {
  Empty,
  ErrorBox,
  HealthBadge,
  Loading,
  StatusBadge,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { formatRelative } from "../format.ts";
import { Link, useLocation, useNavigate } from "../router.tsx";

function ExistingConnections({ source }: { source: string }) {
  const { data, error, loading, reload } = useAsync((s) => api.connections(s), [source]);
  if (loading) return <Loading label="Loading connections…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} title="Could not load connections" />;
  const rows = (data?.connections ?? []).filter((c) => c.source === source);
  if (rows.length === 0) return <p className="muted">None yet.</p>;
  return <ConnectionList rows={rows} />;
}

function ConnectionList({ rows }: { rows: ConnectionWithHealth[] }) {
  return (
    <ul className="conn-list">
      {rows.map((c) => (
        <li key={c.id}>
          <Link to={`/connections/${c.id}`}>{c.name}</Link> <StatusBadge status={c.status} />{" "}
          <HealthBadge state={c.health.state} />{" "}
          <span className="small muted">
            last observed {formatRelative(c.health.lastSuccessAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Back() {
  return (
    <p>
      <Link to="/connections">← Connections</Link>
    </p>
  );
}

// --- GitHub -----------------------------------------------------------------------

export function ConnectGitHub() {
  useDocumentTitle("Connect GitHub");
  const location = useLocation();
  const q = new URLSearchParams(location.search);
  const status = q.get("status");
  const flowError = q.get("error");
  const app = useAsync((s) => api.githubApp(s), []);
  const id = useId();
  const [org, setOrg] = useState("");

  return (
    <div className="page narrow">
      <Back />
      <h1>Connect GitHub</h1>
      <p className="lede">
        Afe connects as a GitHub App with <strong>read-only</strong> permissions (metadata, actions,
        deployments, environments). Each organization or account you install it on becomes one
        connection.
      </p>
      {status === "pending_approval" && (
        <div className="callout callout-gap" role="status">
          <strong>Waiting for approval.</strong> An organization owner must approve the installation
          on GitHub. The connection appears here once they do.
        </div>
      )}
      {flowError && (
        <div className="callout callout-error" role="alert">
          <strong>The GitHub install did not complete:</strong> {flowError}. Start again with the
          button below.
        </div>
      )}
      <section className="card">
        <h2>Install</h2>
        {app.loading ? (
          <Loading />
        ) : app.error ? (
          <ErrorBox error={app.error} onRetry={app.reload} />
        ) : app.data?.configured ? (
          <>
            <p>
              The App <code>{app.data.slug}</code> is configured. GitHub asks which organization and
              repositories to grant, then sends you back here.
            </p>
            <a
              className="btn btn-primary"
              href={app.data.installUrl ?? "/api/connections/github/install"}
            >
              Install on GitHub
            </a>
          </>
        ) : app.data?.manifestFlow.available ? (
          <>
            <p>
              No GitHub App is configured yet. Create one in one step (App Manifest flow): GitHub
              creates a private App with exactly Afe's read-only permissions and Afe stores its
              credentials encrypted.
            </p>
            {!app.data.manifestFlow.publicUrlConfigured ? (
              <div className="callout callout-error" role="alert">
                Set <code>AFE_PUBLIC_URL</code> to the address GitHub can reach this Afe at, then
                restart Afe. It is needed for GitHub's redirect and webhook URLs.
              </div>
            ) : (
              <form method="get" action={app.data.manifestFlow.url} className="form">
                <div className="field">
                  <label htmlFor={`${id}-org`}>Organization (optional)</label>
                  <input
                    id={`${id}-org`}
                    name={org ? "org" : undefined}
                    value={org}
                    onChange={(e) => setOrg(e.target.value)}
                    placeholder="leave empty to own the App with your account"
                    pattern="[A-Za-z0-9][A-Za-z0-9-]{0,38}"
                  />
                </div>
                <button type="submit" className="btn btn-primary">
                  Create the GitHub App
                </button>
              </form>
            )}
            <p className="small muted">
              Prefer to register it yourself? Set <code>AFE_GITHUB_APP_ID</code>,{" "}
              <code>AFE_GITHUB_APP_PRIVATE_KEY</code>, <code>AFE_GITHUB_WEBHOOK_SECRET</code> and{" "}
              <code>AFE_GITHUB_APP_SLUG</code> (see docs/connectors/github.md).
            </p>
          </>
        ) : (
          <p>
            No GitHub App is configured. Set the <code>AFE_GITHUB_APP_*</code> variables (see
            docs/connectors/github.md) and restart Afe.
          </p>
        )}
      </section>
      <section className="card">
        <h2>Connected GitHub accounts</h2>
        <ExistingConnections source="github" />
        <p className="small muted">
          To disconnect, uninstall the App on GitHub (organization or account Settings → GitHub
          Apps). Afe records the uninstall.
        </p>
      </section>
    </div>
  );
}

// --- ArgoCD -----------------------------------------------------------------------

function ReadOnlyResult({ r }: { r: ArgoCdTestResult }) {
  const ro = r.readOnlyCheck;
  return (
    <div
      className={`callout ${ro.status === "write_capable" ? "callout-error" : "callout-ok"}`}
      role="status"
    >
      <p>
        <strong>
          {ro.status === "verified"
            ? "Read-only check passed."
            : ro.status === "unavailable"
              ? "Connected, but ArgoCD could not confirm the token is read-only."
              : "The token can modify ArgoCD."}
        </strong>{" "}
        ArgoCD {r.server.version ?? "(version unknown)"}, account <code>{r.account.username}</code>,{" "}
        {r.applicationCount} application{r.applicationCount === 1 ? "" : "s"} visible.
      </p>
      {ro.writeCapabilities.length > 0 && (
        <p>Write capabilities: {ro.writeCapabilities.join(", ")}</p>
      )}
      {r.warnings.length > 0 && (
        <ul>
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function argocdErrorMessage(err: Error): string {
  if (!(err instanceof ApiError)) return err.message;
  if (err.code === "token_not_read_only") {
    const caps = (err.body?.writeCapabilities as string[] | undefined) ?? [];
    return `${err.message}${caps.length ? ` Write access found: ${caps.join(", ")}.` : ""}`;
  }
  if (err.code === "connection_failed") {
    const kind = typeof err.body?.kind === "string" ? err.body.kind : "error";
    const hint: Record<string, string> = {
      unauthorized: "Check the token (it may be expired or for another instance).",
      tls: "The certificate is not trusted. Paste the CA certificate (PEM) of your ArgoCD.",
      unreachable: "Afe cannot reach that address from where it runs.",
      timeout: "ArgoCD did not answer in time.",
      unsafe_address:
        "The address is on a private network. A self-hosted Afe can allow it with AFE_ALLOW_PRIVATE_NETWORK_TARGETS=true.",
    };
    return `${err.message}${hint[kind] ? ` ${hint[kind]}` : ""}`;
  }
  return err.message;
}

export function ConnectArgoCD() {
  useDocumentTitle("Connect ArgoCD");
  const id = useId();
  const [form, setForm] = useState({ url: "", token: "", caPem: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ArgoCdConnectResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const list = useAsync((s) => api.argocdConnections(s), []);
  const [tests, setTests] = useState<
    Record<string, { busy: boolean; result?: ArgoCdTestResult; error?: Error }>
  >({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.argocdConnect({
        url: form.url.trim(),
        token: form.token,
        ...(form.caPem.trim() ? { caPem: form.caPem } : {}),
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
      });
      setResult(r);
      setForm({ url: "", token: "", caPem: "", name: "" });
      list.reload();
    } catch (err) {
      setError(err as Error);
      setForm((f) => ({ ...f, token: "" }));
    } finally {
      setBusy(false);
    }
  };

  const test = async (cid: string) => {
    setTests((t) => ({ ...t, [cid]: { busy: true } }));
    try {
      const r = await api.argocdTest(cid);
      setTests((t) => ({ ...t, [cid]: { busy: false, result: r } }));
    } catch (err) {
      setTests((t) => ({ ...t, [cid]: { busy: false, error: err as Error } }));
    }
  };
  const disconnect = async (cid: string, name: string) => {
    if (
      !window.confirm(
        `Disconnect ArgoCD “${name}”? Afe deletes its token. Recorded events are kept.`,
      )
    )
      return;
    try {
      await api.argocdDisconnect(cid);
      list.reload();
    } catch (err) {
      setTests((t) => ({ ...t, [cid]: { busy: false, error: err as Error } }));
    }
  };

  return (
    <div className="page narrow">
      <Back />
      <h1>Connect ArgoCD</h1>
      <p className="lede">
        Afe reads ArgoCD with the API token of a dedicated local account with a{" "}
        <strong>read-only</strong> role (see docs/connectors/argocd.md). Afe checks the token cannot
        sync, change or delete anything and refuses it otherwise.
      </p>
      <section className="card">
        <h2>Add an instance</h2>
        <form className="form" onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label htmlFor={`${id}-url`}>Server URL</label>
            <input
              id={`${id}-url`}
              type="url"
              required
              placeholder="https://argocd.example.com"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-token`}>API token</label>
            <input
              id={`${id}-token`}
              type="password"
              required
              autoComplete="off"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              aria-describedby={`${id}-token-help`}
            />
            <small id={`${id}-token-help`} className="muted">
              <code>argocd account generate-token --account afe</code>. Stored encrypted; never
              shown again.
            </small>
          </div>
          <div className="field">
            <label htmlFor={`${id}-ca`}>CA certificate (PEM, optional)</label>
            <textarea
              id={`${id}-ca`}
              rows={4}
              placeholder="-----BEGIN CERTIFICATE-----"
              value={form.caPem}
              onChange={(e) => setForm({ ...form, caPem: e.target.value })}
            />
            <small className="muted">
              For a private CA or self-signed certificate. TLS is always verified.
            </small>
          </div>
          <div className="field">
            <label htmlFor={`${id}-name`}>Name (optional)</label>
            <input
              id={`${id}-name`}
              placeholder="defaults to the host name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Checking the token…" : "Check and connect"}
          </button>
        </form>
        {error && (
          <div className="callout callout-error" role="alert">
            <strong>Not connected.</strong> {argocdErrorMessage(error)}
          </div>
        )}
        {result && (
          <>
            <ReadOnlyResult r={result} />
            <p>
              Connected{" "}
              <Link to={`/connections/${result.connection.id}`}>{result.connection.name}</Link>.
            </p>
          </>
        )}
      </section>
      <section className="card">
        <h2>Connected instances</h2>
        {list.loading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={list.reload} />
        ) : list.data?.connections.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="conn-list">
            {list.data?.connections.map((c) => {
              const t = tests[c.id];
              return (
                <li key={c.id}>
                  <div className="conn-line">
                    <Link to={`/connections/${c.id}`}>{c.name}</Link>{" "}
                    <StatusBadge status={c.status} />{" "}
                    <span className="small muted">
                      {c.config.serverUrl} · ArgoCD {c.config.argocdVersion ?? "?"} · account{" "}
                      {c.config.account ?? "?"}
                    </span>
                  </div>
                  {c.status !== "disconnected" && (
                    <div className="button-row">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void test(c.id)}
                        disabled={t?.busy}
                      >
                        {t?.busy ? "Testing…" : "Test"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => void disconnect(c.id, c.name)}
                      >
                        Disconnect
                      </button>
                    </div>
                  )}
                  {t?.result && <ReadOnlyResult r={t.result} />}
                  {t?.error && (
                    <div className="callout callout-error" role="alert">
                      {argocdErrorMessage(t.error)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// --- Vercel -----------------------------------------------------------------------

export function ConnectVercel() {
  useDocumentTitle("Connect Vercel");
  const id = useId();
  const navigate = useNavigate();
  const integration = useAsync((s) => api.vercelIntegration(s), []);
  const [form, setForm] = useState({ token: "", teamId: "", webhookSecret: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.vercelConnectToken({
        token: form.token.trim(),
        ...(form.teamId.trim() ? { teamId: form.teamId.trim() } : {}),
        ...(form.webhookSecret ? { webhookSecret: form.webhookSecret } : {}),
      });
      navigate(`/connections/vercel/${r.connection.id}/projects?new=token`);
    } catch (err) {
      setError(err as Error);
      setForm((f) => ({ ...f, token: "", webhookSecret: "" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <Back />
      <h1>Connect Vercel</h1>
      <p className="lede">
        Afe reads deployments of the Vercel projects you choose. A new connection observes no
        projects until you pick them.
      </p>
      <section className="card">
        <h2>Vercel Integration (recommended)</h2>
        {integration.loading ? (
          <Loading />
        ) : integration.error ? (
          <ErrorBox error={integration.error} onRetry={integration.reload} />
        ) : integration.data?.configured ? (
          <>
            <p>
              Install the Afe integration on your team with read-only permissions. Vercel sends you
              back here to choose projects.
            </p>
            <a
              className="btn btn-primary"
              href={integration.data.installUrl ?? "/api/connections/vercel/install"}
            >
              Install the Vercel Integration
            </a>
          </>
        ) : (
          <p>
            Not configured on this Afe. To enable it, create a Vercel Integration and set{" "}
            {integration.data?.missing.map((m, i) => (
              <span key={m}>
                {i > 0 && ", "}
                <code>{m}</code>
              </span>
            ))}{" "}
            (see docs/connectors/vercel.md). Or use an access token below.
          </p>
        )}
      </section>
      <section className="card">
        <h2>Access token</h2>
        <div className="callout callout-gap" role="note">
          Vercel access tokens <strong>cannot be limited to read-only</strong>: this token grants
          full access to its scope. Afe only sends GET requests with it. Scope it to one team, set
          an expiry, and create it as a member with the least-privileged role.
        </div>
        <form className="form" onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label htmlFor={`${id}-token`}>Access token</label>
            <input
              id={`${id}-token`}
              type="password"
              required
              minLength={8}
              autoComplete="off"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-team`}>Team id (optional)</label>
            <input
              id={`${id}-team`}
              placeholder="team_… (leave empty for a personal account)"
              value={form.teamId}
              onChange={(e) => setForm({ ...form, teamId: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-secret`}>Webhook secret (optional)</label>
            <input
              id={`${id}-secret`}
              type="password"
              autoComplete="off"
              value={form.webhookSecret}
              onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
              aria-describedby={`${id}-secret-help`}
            />
            <small id={`${id}-secret-help`} className="muted">
              If you create an account webhook pointing at{" "}
              <code>/webhooks/vercel/&lt;team or user id&gt;</code>. Without one, Afe polls.
            </small>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Checking the token…" : "Connect with token"}
          </button>
        </form>
        {error && <ErrorBox error={error} title="Not connected" />}
      </section>
      <section className="card">
        <h2>Connected Vercel accounts</h2>
        <ExistingConnections source="vercel" />
      </section>
    </div>
  );
}

function selectionSummary(s: ProjectSelection): string {
  if (s.mode === "all") return "all projects";
  if (s.mode === "none") return "no projects";
  return `${s.projectIds.length} selected project${s.projectIds.length === 1 ? "" : "s"}`;
}

export function VercelProjectsPage({ id }: { id: string }) {
  useDocumentTitle("Vercel projects");
  const location = useLocation();
  const isNew = new URLSearchParams(location.search).get("new");
  const { data, error, loading, reload } = useAsync((s) => api.vercelProjects(id, s), [id]);
  const [mode, setMode] = useState<"none" | "all" | "selected">("none");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [save, setSave] = useState<{
    busy: boolean;
    error: Error | null;
    saved: ProjectSelection | null;
  }>({
    busy: false,
    error: null,
    saved: null,
  });

  useEffect(() => {
    if (!data) return;
    setMode(data.selection.mode);
    setChosen(
      new Set(
        data.projects
          .filter((p) => p.selected && data.selection.mode === "selected")
          .map((p) => p.id),
      ),
    );
  }, [data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSave({ busy: true, error: null, saved: null });
    try {
      const r = await api.vercelSaveProjects(
        id,
        mode === "all" ? { projects: "all" } : { projectIds: mode === "none" ? [] : [...chosen] },
      );
      setSave({ busy: false, error: null, saved: r.selection });
    } catch (err) {
      setSave({ busy: false, error: err as Error, saved: null });
    }
  };

  return (
    <div className="page narrow">
      <p>
        <Link to={`/connections/${id}`}>← Connection</Link>
      </p>
      <h1>Choose Vercel projects</h1>
      {isNew !== null && (
        <div className="callout callout-ok" role="status">
          <strong>Vercel connected.</strong> It observes no projects until you choose them below.
        </div>
      )}
      <p className="lede">
        Afe only reads deployments of the projects you choose here and ignores webhooks for others.
      </p>
      {loading ? (
        <Loading label="Loading projects from Vercel…" />
      ) : error ? (
        <ErrorBox error={error} onRetry={reload} title="Could not load projects" />
      ) : (
        data && (
          <form className="form" onSubmit={(e) => void submit(e)}>
            <p>
              Currently observing: <strong>{selectionSummary(data.selection)}</strong>.
            </p>
            <fieldset>
              <legend>Observe</legend>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "selected"}
                  onChange={() => setMode("selected")}
                />
                Only the projects I select
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "all"}
                  onChange={() => setMode("all")}
                />
                All projects, including ones created later
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "none"}
                  onChange={() => setMode("none")}
                />
                None (pause observation)
              </label>
            </fieldset>
            {mode === "selected" &&
              (data.projects.length === 0 ? (
                <Empty title="No projects visible">
                  <p>This token or installation cannot see any projects.</p>
                </Empty>
              ) : (
                <fieldset className="project-list">
                  <legend>Projects ({chosen.size} selected)</legend>
                  {data.projects.map((p) => (
                    <label key={p.id} className="check">
                      <input
                        type="checkbox"
                        checked={chosen.has(p.id)}
                        onChange={(e) => {
                          const next = new Set(chosen);
                          if (e.target.checked) next.add(p.id);
                          else next.delete(p.id);
                          setChosen(next);
                        }}
                      />
                      {p.name} {p.framework && <span className="small muted">({p.framework})</span>}
                    </label>
                  ))}
                </fieldset>
              ))}
            <button type="submit" className="btn btn-primary" disabled={save.busy}>
              {save.busy ? "Saving…" : "Save selection"}
            </button>
            {save.saved && (
              <p className="callout callout-ok" role="status">
                Saved: Afe now observes {selectionSummary(save.saved)}.{" "}
                <Link to={`/connections/${id}`}>Back to the connection</Link>
              </p>
            )}
            {save.error && <ErrorBox error={save.error} title="Could not save" />}
          </form>
        )
      )}
    </div>
  );
}
