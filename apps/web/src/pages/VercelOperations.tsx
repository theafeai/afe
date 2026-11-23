import { useRef, useState } from "react";
import {
  VERCEL_OPERATIONS,
  type VercelIntent,
  type VercelOperation,
  type VercelOperationReceipt,
  type VercelPreparedOperation,
  type VercelProjectResource,
  type VercelWorkspace,
} from "@afe/core/vercel-operations";
import { request } from "../api/client.ts";
import {
  Empty,
  ErrorBox,
  Loading,
  SectionHead,
  useAsync,
  useDocumentTitle,
  KeyValue,
} from "../components.tsx";
import { OperationDialog } from "../OperationDialog.tsx";
import { Link, useSearchParams } from "../router.tsx";
import { useToast } from "../toast.tsx";

export function VercelOperationsPage() {
  useDocumentTitle("Vercel deployments");
  const resources = useAsync(
    (s) =>
      request<{ items: VercelProjectResource[] }>(
        "GET",
        "/api/actions/vercel/resources",
        undefined,
        s,
      ),
    [],
  );
  const [search] = useSearchParams();
  const [selected, setSelected] = useState(
    () => `${search.get("connectionId") ?? ""}:${search.get("projectId") ?? ""}`,
  );
  const resource = resources.data?.items.find(
    (r) => `${r.connectionId}:${r.projectId}` === selected,
  );
  return (
    <div className="page">
      <header className="page-header">
        <h1>Vercel deployments</h1>
        <p className="lede">
          Operate selected projects with your linked Vercel account. Source events and polling
          confirm completion.
        </p>
      </header>
      {resources.loading && <Loading label="Loading Vercel projects…" />}
      {resources.error && (
        <>
          <ErrorBox error={resources.error} onRetry={resources.reload} />
          <p>
            <Link to="/profile">Link your Vercel account in Profile</Link>
          </p>
        </>
      )}
      {resources.data && !resources.data.items.length && (
        <Empty title="No Vercel projects available">
          <p>
            Ask an administrator to select projects on a Vercel connection, then{" "}
            <Link to="/profile">link your personal account</Link>.
          </p>
        </Empty>
      )}
      {!!resources.data?.items.length && (
        <div className="field">
          <label htmlFor="vercel-project">Project</label>
          <select
            id="vercel-project"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Select a project</option>
            {resources.data.items.map((r) => (
              <option
                key={`${r.connectionId}:${r.projectId}`}
                value={`${r.connectionId}:${r.projectId}`}
              >
                {r.name} · {r.connectionName}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="muted small">
        Discovery lists up to 1,000 projects in your linked account. Each deployment page contains
        up to 30 builds; project domains are limited to the first 100.
      </p>
      {resource && (
        <Workspace
          key={selected}
          resource={resource}
          initialDeployment={
            selected === `${search.get("connectionId") ?? ""}:${search.get("projectId") ?? ""}`
              ? (search.get("deploymentId") ?? "")
              : ""
          }
        />
      )}
    </div>
  );
}

function Workspace({
  resource,
  initialDeployment,
}: {
  resource: VercelProjectResource;
  initialDeployment: string;
}) {
  const root = `/api/actions/vercel/connections/${encodeURIComponent(resource.connectionId)}/projects/${encodeURIComponent(resource.projectId)}`;
  const [deploymentId, setDeploymentId] = useState(initialDeployment);
  const [until, setUntil] = useState<number | null>(null);
  const q = new URLSearchParams();
  if (deploymentId) q.set("deploymentId", deploymentId);
  if (until !== null) q.set("until", String(until));
  const url = `${root}?${q}`;
  const { data, loading, error, reload } = useAsync(
    (s) => request<VercelWorkspace>("GET", url, undefined, s),
    [url],
  );
  const [action, setAction] = useState<VercelOperation>("vercel.redeploy");
  const [ref, setRef] = useState(""),
    [target, setTarget] = useState("preview"),
    [domain, setDomain] = useState("");
  const [autoAssign, setAutoAssign] = useState(false),
    [previewDisabled, setPreviewDisabled] = useState(false);
  const [prepared, setPrepared] = useState<
    (VercelPreparedOperation & { requestId: string }) | null
  >(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [release, setRelease] = useState<VercelOperationReceipt | null>(null);
  const [result, setResult] = useState<VercelOperationReceipt | null>(null);
  const submitting = useRef(false);
  const intent = useRef<(VercelPreparedOperation & { requestId: string }) | null>(null);
  const toast = useToast();
  const capability = data?.capabilities.find((c) => c.action === action);
  async function run(fn: () => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await fn();
    } catch (e) {
      setFailure(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function params(): VercelIntent["params"] {
    if (action === "vercel.deploy") return { ref, target };
    if (action === "vercel.configure")
      return { autoAssignCustomDomains: autoAssign, previewDeploymentsDisabled: previewDisabled };
    return {
      deploymentId,
      ...(action === "vercel.redeploy" ? { target } : {}),
      ...(action === "vercel.alias_assign" ? { domain } : {}),
    };
  }
  return (
    <>
      <Credential root={root} reload={reload} />
      {loading && <Loading label="Loading deployment context…" />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <section className="card">
            <SectionHead
              id="vercel-context"
              title={data.project.name}
              action={
                <button className="btn btn-sm" disabled={busy || loading} onClick={reload}>
                  Refresh source state
                </button>
              }
            />
            <p>
              Production: <code>{data.project.productionId ?? "No production deployment"}</code> ·{" "}
              <a href={data.project.sourceUrl} target="_blank" rel="noreferrer">
                Open in Vercel
              </a>
            </p>
            <p className="muted">
              Each deployment identifies an individual build. Open it in Vercel to view build and
              runtime logs.
            </p>
            {!data.deployments.length ? (
              <Empty title="No deployments on this page">
                <p>Deploy a Git commit SHA or return to the newest deployments.</p>
              </Empty>
            ) : (
              <ul className="entity-list">
                {data.deployments.map((d) => (
                  <li key={d.id}>
                    <div className="entity-main">
                      <div className="entity-name">
                        <strong>
                          {d.state} · {d.target}
                        </strong>
                        <code>{d.id}</code>
                      </div>
                      <p className="entity-meta">
                        {d.commit ? `Commit ${d.commit.slice(0, 12)} · ` : ""}
                        {new Date(d.createdAt).toLocaleString()} ·{" "}
                        <a href={d.sourceUrl} target="_blank" rel="noreferrer">
                          Deployment in Vercel
                        </a>
                      </p>
                    </div>
                    <div className="entity-actions">
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        aria-pressed={deploymentId === d.id}
                        onClick={() => {
                          setDeploymentId(d.id);
                          setPrepared(null);
                          setResult(null);
                        }}
                      >
                        Select deployment
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="button-row">
              <button
                className="btn btn-sm"
                disabled={until === null || busy}
                onClick={() => setUntil(null)}
              >
                Newest deployments
              </button>
              <button
                className="btn btn-sm"
                disabled={data.next === null || busy}
                onClick={() => setUntil(data.next)}
              >
                Older deployments
              </button>
            </div>
          </section>
          <section className="card">
            <SectionHead id="vercel-operations" title="Delivery operations" />
            <p>
              {data.deployment ? (
                <>
                  <code>{data.deployment.id}</code> · {data.deployment.state} ·{" "}
                  {data.deployment.target}
                </>
              ) : (
                "Select a deployment for lifecycle operations."
              )}
            </p>
            <div className="form">
              <div className="field">
                <label htmlFor="vercel-action">Operation</label>
                <select
                  id="vercel-action"
                  value={action}
                  disabled={busy}
                  onChange={(e) => {
                    setAction(e.target.value as VercelOperation);
                    setAutoAssign(data.settings.autoAssignCustomDomains ?? false);
                    setPreviewDisabled(data.settings.previewDeploymentsDisabled ?? false);
                    setPrepared(null);
                  }}
                >
                  {data.capabilities.map((c) => (
                    <option key={c.action} value={c.action}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              {capability?.reason && <p className="callout">{capability.reason}</p>}
              {action === "vercel.deploy" && (
                <div className="field">
                  <label htmlFor="vercel-ref">Git commit SHA</label>
                  <input
                    id="vercel-ref"
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    maxLength={255}
                  />
                </div>
              )}
              {["vercel.deploy", "vercel.redeploy"].includes(action) && (
                <div className="field">
                  <label htmlFor="vercel-target">Deployment environment</label>
                  <select
                    id="vercel-target"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="preview">Preview</option>
                    <option value="production">Production</option>
                  </select>
                </div>
              )}
              {action === "vercel.alias_assign" && (
                <div className="field">
                  <label htmlFor="vercel-domain">Verified project domain</label>
                  <select
                    id="vercel-domain"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                  >
                    <option value="">Select a domain</option>
                    {data.domains
                      .filter((d) => d.verified)
                      .map((d) => (
                        <option key={d.name}>{d.name}</option>
                      ))}
                  </select>
                </div>
              )}
              {action === "vercel.configure" && (
                <>
                  <p className="muted">
                    Current automatic domain assignment:{" "}
                    {String(data.settings.autoAssignCustomDomains ?? "unknown")}. Current preview
                    deployments disabled:{" "}
                    {String(data.settings.previewDeploymentsDisabled ?? "unknown")}.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={autoAssign}
                      onChange={(e) => setAutoAssign(e.target.checked)}
                    />
                    Automatically assign production domains
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={previewDisabled}
                      onChange={(e) => setPreviewDisabled(e.target.checked)}
                    />
                    Disable preview deployments
                  </label>
                </>
              )}
              <div className="button-row">
                <button
                  className="btn"
                  disabled={busy || loading || !!error || !capability?.enabled}
                  onClick={() =>
                    void run(async () => {
                      const p = await request<VercelPreparedOperation>("POST", `${root}/prepare`, {
                        action,
                        params: params(),
                      });
                      const next = {
                        ...p,
                        requestId:
                          intent.current?.fingerprint === p.fingerprint &&
                          intent.current.action === p.action
                            ? intent.current.requestId
                            : crypto.randomUUID(),
                      };
                      intent.current = next;
                      setPrepared(next);
                    })
                  }
                >
                  Review operation
                </button>
              </div>
            </div>
          </section>
          <section className="card">
            <SectionHead id="vercel-history" title="Your request history" />
            {!data.history.length ? (
              <Empty title="No requests yet">
                <p>Reviewed operations appear here after submission.</p>
              </Empty>
            ) : (
              <ul className="entity-list">
                {data.history.map((r) => (
                  <li key={r.requestId}>
                    <div className="entity-main">
                      <div className="entity-name">
                        <strong>
                          {r.action} · {r.state}
                        </strong>
                        <code>{r.requestId}</code>
                      </div>
                      <p className="entity-meta">
                        {r.message}
                        {r.targetDeploymentId ? ` Target deployment: ${r.targetDeploymentId}.` : ""}
                        {r.upstreamStatus ? ` HTTP ${r.upstreamStatus}.` : ""}
                        {r.deploymentId ? ` New deployment: ${r.deploymentId}.` : ""}
                      </p>
                    </div>
                    {["unknown", "requested"].includes(r.state) && (
                      <div className="entity-actions">
                        <button
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => setRelease(r)}
                        >
                          Review recovery
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {failure && !prepared && !release && <ErrorBox error={failure} />}
      {result && (
        <p role="status">
          {result.message}
          {result.deploymentId ? ` Deployment ${result.deploymentId}.` : ""}
        </p>
      )}
      {prepared && (
        <OperationDialog
          title={VERCEL_OPERATIONS.find(([name]) => name === prepared.action)![1]}
          description={
            <>
              <p>
                Project <strong>{resource.name}</strong> · <code>{prepared.context.projectId}</code>
                {prepared.context.deploymentId && (
                  <>
                    {" "}
                    · Deployment <code>{prepared.context.deploymentId}</code>
                  </>
                )}
              </p>
              <p>{prepared.warning}</p>
              <KeyValue
                items={Object.entries(prepared.params).map(([key, value]) => [
                  key,
                  <code key={key}>{String(value)}</code>,
                ])}
              />
            </>
          }
          confirmLabel="Confirm operation"
          confirmDisabled={loading || !!error}
          destructive={["vercel.delete", "vercel.cancel", "vercel.rollback"].includes(
            prepared.action,
          )}
          busy={busy}
          error={failure}
          onCancel={() => {
            setPrepared(null);
            setFailure(null);
          }}
          onConfirm={() =>
            void run(async () => {
              const r = await request<VercelOperationReceipt>("POST", root, {
                action: prepared.action,
                params: prepared.params,
                fingerprint: prepared.fingerprint,
                requestId: prepared.requestId,
                confirmed: true,
              });
              setResult(r);
              setPrepared(null);
              reload();
            })
          }
        />
      )}
      {release && (
        <OperationDialog
          title="Release uncertain request"
          description={
            <>
              <p>
                Inspect the deployment and production state in Vercel before continuing. The
                original operation may already have taken effect. A new request could duplicate it.
              </p>
              <p>
                <code>{release.requestId}</code>
              </p>
              <p>In-flight requests must be at least two minutes old.</p>
            </>
          }
          confirmLabel="Acknowledge duplicate risk and release"
          destructive
          busy={busy}
          error={failure}
          onCancel={() => {
            setRelease(null);
            setFailure(null);
          }}
          onConfirm={() =>
            void run(async () => {
              await request("POST", `${root}/requests/${release.requestId}/release`, {
                acknowledgeDuplicateRisk: true,
              });
              intent.current = null;
              setRelease(null);
              reload();
              toast("Request released after acknowledging duplicate risk.");
            })
          }
        />
      )}
    </>
  );
}

function Credential({ root, reload }: { root: string; reload: () => void }) {
  const [open, setOpen] = useState(false),
    [token, setToken] = useState("");
  const [actions, setActions] = useState<VercelOperation[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const submitting = useRef(false);
  const toast = useToast();
  async function save(remove = false) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await request(
        remove ? "DELETE" : "PUT",
        `${root}/credential`,
        remove ? undefined : { token, actions },
      );
      setToken("");
      setOpen(false);
      reload();
      toast(
        remove
          ? "Action token removed from Afe."
          : "Action token enabled for selected operations on this project.",
      );
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <SectionHead
        id="vercel-credentials"
        title="Action credentials"
        action={
          <button
            className="btn btn-sm"
            aria-expanded={open}
            disabled={busy}
            onClick={() => setOpen(!open)}
          >
            Enable or replace action token
          </button>
        }
      />
      <p className="muted">
        Opt in separately for this project. Use your own expiring, team-scoped token with the
        narrowest Vercel role. Observation and Profile tokens remain read-only in Afe.
      </p>
      {open && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="field">
            <label htmlFor="vercel-action-token">Personal Vercel action token</label>
            <input
              id="vercel-action-token"
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <fieldset>
            <legend>Allowed operations for this project</legend>
            {VERCEL_OPERATIONS.map(([name, label]) => (
              <label className="check" key={name}>
                <input
                  type="checkbox"
                  checked={actions.includes(name)}
                  onChange={(e) =>
                    setActions(
                      e.target.checked ? [...actions, name] : actions.filter((a) => a !== name),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="button-row">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setToken("");
              }}
            >
              Cancel
            </button>
            <button className="btn" disabled={busy || !actions.length}>
              Save
            </button>
          </div>
        </form>
      )}
      <button className="btn btn-sm" disabled={busy} onClick={() => void save(true)}>
        Disable action token
      </button>
      {error && <ErrorBox error={error} />}
    </section>
  );
}
