import { useRef, useState, type ReactNode } from "react";
import type {
  ArgoCdApplicationChoice,
  ArgoCdApplicationView,
  ArgoCdOperation,
  ArgoCdOperationReceipt,
  ArgoCdPreparedOperation,
  ArgoCdResource,
} from "@afe/core/argocd-operations";
import { ARGOCD_SYNC_OPTIONS } from "@afe/core/argocd-catalog";
import { ApiError, request } from "../api/client.ts";
import {
  Empty,
  ErrorBox,
  KeyValue,
  Loading,
  SectionHead,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { OperationDialog } from "../OperationDialog.tsx";
import { Link } from "../router.tsx";
import { useToast } from "../toast.tsx";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
const errorOf = (e: unknown) => (e instanceof Error ? e : new Error("Request failed."));
const key = (r: ArgoCdResource) => JSON.stringify([r.group, r.kind, r.namespace, r.name]);
const resource = (r: ArgoCdResource): ArgoCdResource => ({
  group: r.group,
  kind: r.kind,
  namespace: r.namespace,
  name: r.name,
});

export function ArgoCdOperationsPage() {
  useDocumentTitle("ArgoCD");
  const list = useAsync(
    (signal) =>
      request<{ items: ArgoCdApplicationChoice[]; reason?: string }>(
        "GET",
        "/api/actions/argocd/applications",
        undefined,
        signal,
      ),
    [],
  );
  const [selected, setSelected] = useState("");
  const choices = list.data?.items ?? [];
  const chosen =
    choices.find((c) => `${c.connectionId}/${c.appNamespace}/${c.application}` === selected) ??
    choices[0];
  return (
    <div className="page">
      <div className="page-header">
        <h1>ArgoCD</h1>
        <button className="btn" disabled={list.loading} onClick={list.reload}>
          {list.loading ? "Refreshing…" : "Refresh applications"}
        </button>
      </div>
      <p className="muted">
        Operate applications with your linked ArgoCD account. Source RBAC applies to every request.
      </p>
      {list.loading && !list.data && <Loading label="Loading ArgoCD applications…" />}
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.data && choices.length === 0 && (
        <Empty title="No applications available">
          <p>
            {list.data.reason ??
              "Link your ArgoCD account in Profile, then check its application permissions."}{" "}
            <Link to="/profile">Open Profile</Link>
          </p>
        </Empty>
      )}
      {choices.length > 0 && (
        <>
          <Field label="Application">
            <select
              value={
                chosen ? `${chosen.connectionId}/${chosen.appNamespace}/${chosen.application}` : ""
              }
              onChange={(e) => setSelected(e.target.value)}
            >
              {choices.map((c) => (
                <option
                  key={`${c.connectionId}/${c.appNamespace}/${c.application}`}
                  value={`${c.connectionId}/${c.appNamespace}/${c.application}`}
                >
                  {c.connectionName} · {c.appNamespace ? c.appNamespace + "/" : ""}
                  {c.application}
                </option>
              ))}
            </select>
          </Field>
          {chosen && (
            <ApplicationWorkspace
              key={`${chosen.connectionId}/${chosen.appNamespace}/${chosen.application}`}
              choice={chosen}
            />
          )}
        </>
      )}
    </div>
  );
}
function ApplicationWorkspace({ choice }: { choice: ArgoCdApplicationChoice }) {
  const path = `/api/actions/argocd/connections/${encodeURIComponent(choice.connectionId)}/applications/${encodeURIComponent(choice.application)}`;
  const query = `?${new URLSearchParams({ appNamespace: choice.appNamespace })}`;
  const endpoint = (part = "") => `${path}${part}${query}`;
  const data = useAsync(
    (signal) => request<ArgoCdApplicationView>("GET", endpoint(), undefined, signal),
    [path, query],
  );
  const history = useAsync(
    (signal) =>
      request<{ items: ArgoCdOperationReceipt[] }>("GET", endpoint("/history"), undefined, signal),
    [path, query],
  );
  const diff = useAsync(
    (signal) =>
      request<{ items: (ArgoCdResource & { changed: boolean })[]; message: string }>(
        "GET",
        endpoint("/diff"),
        undefined,
        signal,
      ),
    [path, query],
  );
  const [action, setAction] = useState<ArgoCdOperation>("argocd.sync");
  const [revision, setRevision] = useState("");
  const [revisions, setRevisions] = useState("");
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [options, setOptions] = useState<string[]>([]);
  const [prune, setPrune] = useState(false),
    [dryRun, setDryRun] = useState(false),
    [force, setForce] = useState(false);
  const [historyId, setHistoryId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [resourceAction, setResourceAction] = useState("");
  const [automated, setAutomated] = useState(false),
    [selfHeal, setSelfHeal] = useState(false),
    [allowEmpty, setAllowEmpty] = useState(false);
  const [cascade, setCascade] = useState(false),
    [propagationPolicy, setPropagationPolicy] = useState("foreground");
  const [review, setReview] = useState<{
    action: ArgoCdOperation;
    params: Record<string, unknown>;
    requestId: string;
    prepared?: ArgoCdPreparedOperation;
  } | null>(null);
  const [recover, setRecover] = useState<ArgoCdOperationReceipt | null>(null);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<ArgoCdOperationReceipt | null>(null);
  const guard = useRef(false);
  const toast = useToast();
  const app = data.data;
  const selectedResource = app?.resources.find((r) => key(r) === resourceId);
  const sourceActions = useAsync(
    (signal) =>
      selectedResource && action === "argocd.resource_action"
        ? request<{ items: { name: string; enabled: boolean; reason: string }[] }>(
            "GET",
            endpoint("/resource-actions") +
              `&resource=${encodeURIComponent(JSON.stringify(resource(selectedResource)))}`,
            undefined,
            signal,
          )
        : Promise.resolve({ items: [] }),
    [path, query, resourceId, action],
  );
  function reload() {
    data.reload();
    history.reload();
    diff.reload();
  }
  function params(): Record<string, unknown> {
    switch (action) {
      case "argocd.sync":
        return {
          ...(revision ? { revision } : {}),
          ...(revisions.trim()
            ? {
                revisions: revisions
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(selectedResources.length
            ? {
                resources: app!.resources
                  .filter((r) => selectedResources.includes(key(r)))
                  .map(resource),
              }
            : {}),
          prune,
          dryRun,
          force,
          syncOptions: options,
        };
      case "argocd.rollback":
        return { id: historyId === "" ? -1 : Number(historyId), prune };
      case "argocd.resource_action":
        return {
          resource: selectedResource ? resource(selectedResource) : null,
          name: resourceAction,
        };
      case "argocd.sync_policy":
        return {
          automated,
          prune: automated && prune,
          selfHeal: automated && selfHeal,
          allowEmpty: automated && allowEmpty,
        };
      case "argocd.delete":
        return { cascade, propagationPolicy };
      default:
        return {};
    }
  }
  async function prepare() {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    const next = { action, params: params(), requestId: crypto.randomUUID() };
    setReview(next);
    try {
      const prepared = await request<ArgoCdPreparedOperation>("POST", endpoint("/prepare"), {
        action: next.action,
        params: next.params,
      });
      setReview({ ...next, prepared });
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
      guard.current = false;
    }
  }
  async function confirm() {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    try {
      if (consent !== null) {
        await request("PUT", "/api/actions/argocd/consent", { enabled: consent });
        toast(
          consent ? "ArgoCD actions enabled for your linked account." : "ArgoCD actions disabled.",
        );
        setConsent(null);
      } else if (recover) {
        const receipt = await request<ArgoCdOperationReceipt>("POST", endpoint("/recover"), {
          requestId: recover.requestId,
          acknowledgeDuplicateRisk: true,
        });
        setResult(receipt);
        setRecover(null);
      } else if (review?.prepared) {
        try {
          const receipt = await request<ArgoCdOperationReceipt>("POST", endpoint("/execute"), {
            action: review.action,
            params: review.params,
            version: review.prepared.version,
            requestId: review.requestId,
            confirmed: true,
          });
          setResult(receipt);
          setReview(null);
        } catch (e) {
          if (
            e instanceof ApiError &&
            e.body &&
            ["accepted", "unknown", "rejected", "requested"].includes(String(e.body.state))
          ) {
            setResult(e.body as unknown as ArgoCdOperationReceipt);
            setReview(null);
          } else {
            // A lost Afe response may hide a dispatch. Keep UUID for safe replay and require explicit confirmation.
            throw e;
          }
        }
      }
      reload();
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
      guard.current = false;
    }
  }
  const capability = app?.capabilities.find((c) => c.action === action);
  return (
    <>
      {data.loading && !app && <Loading label="Loading application state and permissions…" />}
      {data.error && <ErrorBox error={data.error} onRetry={data.reload} />}
      {app && (
        <>
          <section className="card">
            <SectionHead
              id="argocd-application"
              title={choice.application}
              action={
                <button className="btn" disabled={data.loading || busy} onClick={reload}>
                  {data.loading ? "Refreshing…" : "Refresh state"}
                </button>
              }
            />
            <KeyValue
              items={[
                ["Connection", choice.connectionName],
                ["Application namespace", choice.appNamespace || "Default"],
                ["Sync", app.sync],
                ["Health", app.health],
                ["Revision", <code>{app.revision}</code>],
                ["Operation", app.operation],
                ["Operation started", app.context.operationId ?? "None"],
              ]}
            />
            <a href={app.sourceUrl} target="_blank" rel="noreferrer">
              Open application in ArgoCD
            </a>
          </section>
          <section className="card">
            <SectionHead
              id="argocd-operations"
              title="Application operations"
              action={
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setConsent(!app.actionsEnabled);
                  }}
                >
                  {app.actionsEnabled ? "Disable actions" : "Enable actions"}
                </button>
              }
            />
            {!app.actionsEnabled && (
              <p className="callout">
                Actions are off for your linked account. Enable them explicitly, then Afe checks the
                exact ArgoCD permission for each operation.
              </p>
            )}
            <div className="inline-form">
              <Field label="Operation">
                <select
                  value={action}
                  disabled={busy}
                  onChange={(e) => setAction(e.target.value as ArgoCdOperation)}
                >
                  {app.capabilities.map((c) => (
                    <option key={c.action} value={c.action}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
              {action === "argocd.sync" && (
                <>
                  <Field label="Revision (single source, optional)">
                    <input
                      value={revision}
                      onChange={(e) => setRevision(e.target.value)}
                      placeholder="Use configured target revision"
                    />
                  </Field>
                  <Field label="Revisions (multi-source, one per line in source order)">
                    <textarea value={revisions} onChange={(e) => setRevisions(e.target.value)} />
                  </Field>
                  <fieldset>
                    <legend>Resources (none selected syncs all)</legend>
                    {app.resources.length === 0 ? (
                      <p className="muted">No selectable resources in the current source state.</p>
                    ) : (
                      app.resources.map((r) => (
                        <label className="check" key={key(r)}>
                          <input
                            type="checkbox"
                            checked={selectedResources.includes(key(r))}
                            onChange={(e) =>
                              setSelectedResources((old) =>
                                e.target.checked
                                  ? [...old, key(r)]
                                  : old.filter((x) => x !== key(r)),
                              )
                            }
                          />
                          {r.kind} · {r.namespace}/{r.name}
                        </label>
                      ))
                    )}
                  </fieldset>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={dryRun}
                      onChange={(e) => setDryRun(e.target.checked)}
                    />
                    Dry run
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={force}
                      onChange={(e) => setForce(e.target.checked)}
                    />
                    Force apply (may recreate resources)
                  </label>
                  <fieldset>
                    <legend>Sync options</legend>
                    {ARGOCD_SYNC_OPTIONS.map((o) => (
                      <label className="check" key={o}>
                        <input
                          type="checkbox"
                          checked={options.includes(o)}
                          onChange={(e) =>
                            setOptions((old) =>
                              e.target.checked ? [...old, o] : old.filter((x) => x !== o),
                            )
                          }
                        />
                        <code>{o}</code>
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
              {action === "argocd.rollback" && (
                <Field label="Deployment history">
                  <select value={historyId} onChange={(e) => setHistoryId(e.target.value)}>
                    <option value="">Select a deployment</option>
                    {app.history.map((h) => (
                      <option key={h.id} value={h.id}>
                        #{h.id} · {h.revision} · {h.deployedAt ?? "Unknown time"}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {action === "argocd.resource_action" && (
                <>
                  <Field label="Resource">
                    <select
                      value={resourceId}
                      onChange={(e) => {
                        setResourceId(e.target.value);
                        setResourceAction("");
                      }}
                    >
                      <option value="">Select a resource</option>
                      {app.resources.map((r) => (
                        <option key={key(r)} value={key(r)}>
                          {r.kind} · {r.namespace}/{r.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {sourceActions.loading && <Loading label="Checking resource actions…" />}
                  {sourceActions.error && (
                    <ErrorBox error={sourceActions.error} onRetry={sourceActions.reload} />
                  )}
                  {selectedResource && sourceActions.data?.items.length === 0 && (
                    <p>No resource actions available.</p>
                  )}
                  <Field label="Resource action">
                    <select
                      value={resourceAction}
                      onChange={(e) => setResourceAction(e.target.value)}
                    >
                      <option value="">Select an action</option>
                      {sourceActions.data?.items.map((a) => (
                        <option key={a.name} value={a.name} disabled={!a.enabled}>
                          {a.name}
                          {a.enabled ? "" : ` — ${a.reason}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
              {action === "argocd.sync_policy" && (
                <>
                  <p>
                    Updates only automatic sync settings. ArgoCD may sync immediately when enabled.
                    GitOps may overwrite this change.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={automated}
                      onChange={(e) => setAutomated(e.target.checked)}
                    />
                    Automatic sync
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      disabled={!automated}
                      checked={selfHeal}
                      onChange={(e) => setSelfHeal(e.target.checked)}
                    />
                    Self heal
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      disabled={!automated}
                      checked={allowEmpty}
                      onChange={(e) => setAllowEmpty(e.target.checked)}
                    />
                    Allow empty application
                  </label>
                </>
              )}
              {["argocd.sync", "argocd.rollback", "argocd.sync_policy"].includes(action) && (
                <label className="check">
                  <input
                    type="checkbox"
                    disabled={action === "argocd.sync_policy" && !automated}
                    checked={prune}
                    onChange={(e) => setPrune(e.target.checked)}
                  />
                  Prune resources removed from source
                </label>
              )}
              {action === "argocd.delete" && (
                <>
                  <p className="callout callout-gap">
                    Deleting an application can delete its deployed resources when cascade is
                    enabled.
                  </p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={cascade}
                      onChange={(e) => setCascade(e.target.checked)}
                    />
                    Cascade deletion to deployed resources
                  </label>
                  <Field label="Propagation policy">
                    <select
                      value={propagationPolicy}
                      onChange={(e) => setPropagationPolicy(e.target.value)}
                    >
                      <option value="foreground">Foreground</option>
                      <option value="background">Background</option>
                    </select>
                  </Field>
                </>
              )}
              {capability?.reason && <p className="muted">{capability.reason}</p>}
              <button
                className="btn"
                disabled={
                  busy ||
                  data.loading ||
                  !!data.error ||
                  (action === "argocd.resource_action"
                    ? !sourceActions.data?.items.some((a) => a.name === resourceAction && a.enabled)
                    : !capability?.enabled)
                }
                onClick={() => void prepare()}
              >
                Review operation
              </button>
            </div>
          </section>
          {result && (
            <p
              className={`callout${result.state === "unknown" || result.state === "rejected" ? " callout-gap" : ""}`}
              role="status"
            >
              <strong>{result.state}</strong> · {result.message} <code>{result.requestId}</code>
            </p>
          )}
          <section className="card">
            <SectionHead id="argocd-resources" title="Resources and health" />
            {app.resources.length === 0 ? (
              <Empty title="No resources reported">
                <p>Refresh after ArgoCD reconciles the application.</p>
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Resource</th>
                      <th>Sync</th>
                      <th>Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {app.resources.map((r) => (
                      <tr key={key(r)}>
                        <td>
                          {r.kind}{" "}
                          <code>
                            {r.namespace}/{r.name}
                          </code>
                        </td>
                        <td>{r.status}</td>
                        <td>{r.health}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      <section className="card">
        <SectionHead id="argocd-diff" title="Resource diff" />
        {diff.loading && !diff.data && <Loading label="Loading resource differences…" />}
        {diff.error && <ErrorBox error={diff.error} onRetry={diff.reload} />}
        {diff.data && (
          <>
            <p className="muted">{diff.data.message}</p>
            {diff.data.items.length === 0 ? (
              <Empty title="No managed resources">
                <p>Refresh after ArgoCD reconciles the application.</p>
              </Empty>
            ) : (
              <ul className="entity-list">
                {diff.data.items.map((r) => (
                  <li key={key(r)}>
                    <div>
                      <strong>
                        {r.kind} · {r.name}
                      </strong>
                      <div className="entity-meta">
                        {r.namespace || "Cluster scoped"} ·{" "}
                        {r.changed ? "Differences reported" : "No differences reported"}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      <section className="card">
        <SectionHead id="argocd-history" title="Request history" />
        {history.loading && !history.data && <Loading label="Loading request history…" />}
        {history.error && <ErrorBox error={history.error} onRetry={history.reload} />}
        {history.data &&
          (history.data.items.length === 0 ? (
            <Empty title="No requests yet">
              <p>Confirmed operations and their acceptance states appear here.</p>
            </Empty>
          ) : (
            <ul className="entity-list">
              {history.data.items.map((r) => (
                <li key={r.requestId}>
                  <div>
                    <strong>
                      {r.action} · {r.state}
                    </strong>
                    <div className="entity-meta">
                      <code>{r.requestId}</code>
                    </div>
                    <p>{r.message}</p>
                    {["unknown", "requested"].includes(r.state) && (
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setRecover(r);
                        }}
                      >
                        Review recovery
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ))}
      </section>
      {review && (
        <OperationDialog
          title={`Confirm ${app?.capabilities.find((c) => c.action === review.action)?.label.toLowerCase() ?? "ArgoCD operation"}`}
          description={
            <p>{review.prepared?.summary ?? `Preparing operation for ${choice.application}…`}</p>
          }
          confirmLabel="Confirm operation"
          destructive={app?.capabilities.find((c) => c.action === review.action)?.destructive}
          busy={busy}
          pendingLabel={review.prepared ? "Submitting once…" : "Checking source state…"}
          confirmDisabled={!review.prepared}
          error={error}
          onCancel={() => {
            setReview(null);
            setError(null);
          }}
          onConfirm={() => void confirm()}
        >
          <pre>{JSON.stringify(review.params, null, 2)}</pre>
          <p>
            Only confirm if these inputs match your intent. If the response is uncertain, inspect
            ArgoCD and request history before recovery.
          </p>
        </OperationDialog>
      )}
      {consent !== null && (
        <OperationDialog
          title={consent ? "Enable ArgoCD actions" : "Disable ArgoCD actions"}
          description={
            <p>
              {consent
                ? "Allow Afe to send confirmed operations using your linked personal ArgoCD credential. Current source permissions still apply. The observation credential is never used."
                : "Disable operations for your linked ArgoCD account."}
            </p>
          }
          confirmLabel={consent ? "Enable actions" : "Disable actions"}
          busy={busy}
          error={error}
          onCancel={() => setConsent(null)}
          onConfirm={() => void confirm()}
        />
      )}
      {recover && (
        <OperationDialog
          title="Recover uncertain request"
          description={
            <p>
              Inspect {choice.application} in ArgoCD first. Releasing this request may allow a
              duplicate operation if the earlier request succeeded. In-flight requests require a two
              minute wait.
            </p>
          }
          confirmLabel="Acknowledge duplicate risk and release"
          destructive
          busy={busy}
          error={error}
          onCancel={() => setRecover(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </>
  );
}
