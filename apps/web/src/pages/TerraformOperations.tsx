import { useEffect, useRef, useState } from "react";
import {
  TERRAFORM_OPERATIONS,
  type TerraformCapability,
  type TerraformOperationInput,
  type TerraformPreparedOperation,
  type TerraformReceipt,
  type TerraformWorkspaceView,
} from "@afe/core/terraform-actions";
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
import { useAccess } from "../access.tsx";
import { icons } from "../icons.tsx";
import { Link } from "../router.tsx";
import { useToast } from "../toast.tsx";

const label = (action: string) => TERRAFORM_OPERATIONS.find(([a]) => a === action)?.[1] ?? action;
const asError = (e: unknown) => (e instanceof Error ? e : new Error("Request failed."));
type Resource = { connectionId: string; workspaceId: string; name: string; organization: string };

function RemoteSetup() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<Error | null>(null);
  const [form, setForm] = useState({
    serverUrl: "https://app.terraform.io",
    organization: "",
    workspaceId: "",
  });
  const [connectionId, setConnectionId] = useState<string | null>(null);
  return (
    <section className="card">
      <SectionHead
        id="terraform-setup"
        title="Remote workspace connections"
        hint="Administrator setup: select a workspace, then link your personal user token in Profile."
        action={
          <button className="btn btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {icons.plus}Add remote workspace
          </button>
        }
      />
      {open && (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (submitting.current) return;
            submitting.current = true;
            setBusy(true);
            setError(null);
            try {
              const result = await request<{ connection: { id: string } }>(
                "POST",
                "/api/connections/terraform/remote",
                form,
              );
              setConnectionId(result.connection.id);
              setOpen(false);
            } catch (err) {
              setError(asError(err));
            } finally {
              setBusy(false);
              submitting.current = false;
            }
          }}
        >
          <div className="field">
            <label htmlFor="tf-server">Terraform server origin</label>
            <input
              id="tf-server"
              required
              type="url"
              value={form.serverUrl}
              onChange={(e) => setForm({ ...form, serverUrl: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="tf-org">Organization</label>
            <input
              id="tf-org"
              required
              value={form.organization}
              onChange={(e) => setForm({ ...form, organization: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="tf-ws">Workspace ID</label>
            <input
              id="tf-ws"
              required
              placeholder="ws-…"
              value={form.workspaceId}
              onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}
            />
          </div>
          {error && <ErrorBox error={error} />}
          <div className="button-row form-end">
            <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
      {connectionId && (
        <p className="callout">
          Workspace selected. Connection ID: <code>{connectionId}</code>. Link your personal
          Terraform token in <Link to="/profile">Profile</Link>. Workspace access is verified using
          that token.
        </p>
      )}
    </section>
  );
}

function Workspace({ id }: { id: string }) {
  const root = `/api/actions/terraform/connections/${encodeURIComponent(id)}`;
  const [page, setPage] = useState(1);
  const view = useAsync(
    (s) => request<TerraformWorkspaceView>("GET", `${root}?page=${page}`, undefined, s),
    [root, page],
  );
  const history = useAsync(
    (s) => request<{ requests: TerraformReceipt[] }>("GET", `${root}/requests`, undefined, s),
    [root],
  );
  const refresh = () => {
    view.reload();
    history.reload();
  };
  const [review, setReview] = useState<{
    operation: TerraformOperationInput;
    requestId: string;
    prepared: TerraformPreparedOperation | null;
  } | null>(null);
  const [recover, setRecover] = useState<TerraformReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const guard = useRef(false);
  const toast = useToast();
  // Source polling owns completion. An accepted action never fabricates a deployment event.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!guard.current) view.reload();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [view.reload]);
  async function prepare(operation: TerraformOperationInput) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    setUncertain(false);
    const next = {
      operation,
      requestId: crypto.randomUUID(),
      prepared: null as TerraformPreparedOperation | null,
    };
    setReview(next);
    try {
      next.prepared = await request<TerraformPreparedOperation>(
        "POST",
        `${root}/prepare`,
        operation,
      );
      setReview({ ...next });
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
      guard.current = false;
    }
  }
  async function execute() {
    if (guard.current || !review?.prepared || uncertain) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    try {
      const receipt = await request<TerraformReceipt>("POST", `${root}/execute`, {
        operation: review.operation,
        version: review.prepared.version,
        requestId: review.requestId,
        confirmed: true,
      });
      if (receipt.state !== "accepted") {
        setUncertain(true);
        setError(new Error(receipt.message));
      } else {
        toast(receipt.message);
        setReview(null);
      }
    } catch (e) {
      // Keep the intent UUID and prevent a blind repeat after a transport failure.
      setUncertain(true);
      setError(asError(e));
      if (e instanceof ApiError && typeof e.body?.message === "string")
        setError(new Error(e.body.message));
    } finally {
      setBusy(false);
      guard.current = false;
      refresh();
    }
  }
  const controls = (
    items: TerraformCapability[],
    params: Omit<TerraformOperationInput, "action"> = {},
  ) => (
    <div className="button-row">
      {items.map((c) => (
        <span key={c.action} title={c.reason ?? undefined}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!c.enabled || busy || !!review || !!recover}
            onClick={() => void prepare({ action: c.action, ...params })}
          >
            {label(c.action)}
          </button>
          {c.reason && <span className="sr-only">{c.reason}</span>}
        </span>
      ))}
    </div>
  );
  return (
    <>
      <div className="toolbar">
        <button className="btn" disabled={view.loading || busy} onClick={refresh}>
          Refresh source state
        </button>
        <span className="muted small">
          Refreshes every 15 seconds. Acceptance is separate from completion.
        </span>
      </div>
      {view.error && <ErrorBox error={view.error} onRetry={view.reload} />}
      {view.loading && !view.data && <Loading />}
      {view.data && (
        <>
          <section className="card">
            <SectionHead
              id="terraform-workspace"
              title={view.data.name}
              action={
                <a className="btn btn-sm" href={view.data.url} target="_blank" rel="noreferrer">
                  Open Terraform
                </a>
              }
            />
            <KeyValue
              items={[
                ["Workspace", <code>{view.data.context.workspaceId}</code>],
                ["Organization", view.data.context.organization],
                ["Lock", view.data.locked ? "Locked" : "Unlocked"],
              ]}
            />
            {controls(view.data.capabilities)}
            {view.data.capabilities.find((c) => c.reason)?.reason && (
              <p className="muted small">{view.data.capabilities.find((c) => c.reason)?.reason}</p>
            )}
          </section>
          <section className="card">
            <SectionHead
              id="terraform-runs"
              title="Runs"
              count={view.data.runs.length}
              hint="Plan change counts are metadata. Open Terraform for the full plan, outputs, run tasks and approvals."
            />
            {!view.data.runs.length ? (
              <Empty title="No remote runs">
                Queue a plan if your Terraform permissions allow it, or open the workspace in
                Terraform.
              </Empty>
            ) : (
              <ul className="entity-list">
                {view.data.runs.map((run) => (
                  <li key={run.id}>
                    <div className="entity-main">
                      <strong>
                        <a href={run.url} target="_blank" rel="noreferrer">
                          {run.id}
                        </a>
                      </strong>
                      <p className="entity-meta">
                        {run.status} · Additions: {run.changes.additions ?? "Unavailable"} ·
                        Changes: {run.changes.changes ?? "Unavailable"} · Destructions:{" "}
                        {run.changes.destructions ?? "Unavailable"}
                      </p>
                      <p className="muted small">
                        Plan: <code>{run.planId ?? "Unavailable"}</code> · Apply:{" "}
                        <code>{run.applyId ?? "Unavailable"}</code>
                      </p>
                      {controls(run.capabilities, { runId: run.id })}
                      {run.policies.map((policy) => (
                        <div key={policy.id}>
                          <p className="muted small">
                            <code>{policy.id}</code> · {policy.status}
                          </p>
                          {controls(policy.capabilities, {
                            runId: run.id,
                            policyCheckId: policy.id,
                          })}
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="button-row">
              <button
                className="btn btn-sm"
                disabled={page <= 1 || view.loading}
                onClick={() => setPage(page - 1)}
              >
                Previous page
              </button>
              <span>Page {page}</span>
              <button
                className="btn btn-sm"
                disabled={!view.data.nextPage || view.loading}
                onClick={() => setPage(view.data!.nextPage!)}
              >
                Next page
              </button>
            </div>
          </section>
        </>
      )}
      <section className="card">
        <SectionHead
          id="terraform-requests"
          title="Your recent requests"
          hint="Uncertain operations stay locked until you inspect Terraform and explicitly acknowledge duplicate risk."
        />
        {history.error && <ErrorBox error={history.error} onRetry={history.reload} />}
        {history.loading && !history.data && <Loading />}
        {history.data &&
          (!history.data.requests.length ? (
            <Empty title="No requests yet">
              Confirmed operations and their outcomes appear here.
            </Empty>
          ) : (
            <ul className="entity-list">
              {history.data.requests.map((r) => (
                <li key={r.requestId}>
                  <div className="entity-main">
                    <strong>
                      {label(r.action)} · {r.state}
                    </strong>
                    <p className="entity-meta">
                      <code>{r.resourceKey}</code> · <code>{r.requestId}</code>
                    </p>
                    <p>{r.message}</p>
                    {r.resultRunId && (
                      <p>
                        Created run:{" "}
                        {view.data ? (
                          <a
                            href={`${view.data.url}/runs/${r.resultRunId}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <code>{r.resultRunId}</code>
                          </a>
                        ) : (
                          <code>{r.resultRunId}</code>
                        )}
                      </p>
                    )}
                    {["unknown", "requested"].includes(r.state) && (
                      <button
                        className="btn btn-sm"
                        disabled={busy || !!review}
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
          title={label(review.operation.action)}
          confirmLabel="Confirm operation"
          description={
            <>
              <p>
                {review.prepared?.summary ??
                  "Checking current Terraform permissions and source state…"}
              </p>
              <p>
                {TERRAFORM_OPERATIONS.find(([action]) => action === review.operation.action)?.[3]}
              </p>
              {review.prepared && (
                <a href={review.prepared.sourceUrl} target="_blank" rel="noreferrer">
                  Inspect in Terraform
                </a>
              )}
            </>
          }
          busy={busy}
          pendingLabel={review.prepared ? "Submitting…" : "Preparing…"}
          confirmDisabled={!review.prepared || uncertain}
          error={error}
          onConfirm={() => void execute()}
          onCancel={() => {
            setReview(null);
            setError(null);
          }}
        />
      )}
      {recover && (
        <OperationDialog
          title="Release uncertain request"
          confirmLabel="Acknowledge duplicate risk"
          destructive
          description={
            <>
              <p>
                Inspect Terraform before releasing <code>{recover.requestId}</code>. The original
                operation may have succeeded. A new request could duplicate it.
              </p>
              <p>
                Pending requests must be at least two minutes old. Releasing does not retry the
                operation.
              </p>
              {view.data && (
                <a href={view.data.url} target="_blank" rel="noreferrer">
                  Inspect in Terraform
                </a>
              )}
            </>
          }
          busy={busy}
          error={error}
          onCancel={() => setRecover(null)}
          onConfirm={async () => {
            if (guard.current) return;
            guard.current = true;
            setBusy(true);
            setError(null);
            try {
              await request("POST", `${root}/requests/${recover.requestId}/recover`, {
                confirmed: true,
                acknowledgeDuplicateRisk: true,
              });
              toast("Request released. Review current state before preparing a new operation.");
              setRecover(null);
              refresh();
            } catch (e) {
              setError(asError(e));
            } finally {
              guard.current = false;
              setBusy(false);
            }
          }}
        />
      )}
    </>
  );
}

export function TerraformOperationsPage() {
  useDocumentTitle("Terraform");
  const { admin } = useAccess();
  const resources = useAsync(
    (s) =>
      request<{ resources: Resource[] }>("GET", "/api/actions/terraform/resources", undefined, s),
    [],
  );
  const [selected, setSelected] = useState("");
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Terraform</h1>
          <p className="lede">
            Operate HCP Terraform and Terraform Enterprise workspaces with your own source
            permissions.
          </p>
        </div>
      </div>
      <p className="callout">
        CLI and manual reports remain observation only. Remote operations require a named Afe user,
        Source access and a linked personal token in <Link to="/profile">Profile</Link>. Full plans,
        output values and task approvals stay in Terraform.
      </p>
      {admin && <RemoteSetup />}
      {resources.error && (
        <ErrorBox
          error={resources.error}
          onRetry={resources.reload}
          title="Could not discover remote workspaces"
        />
      )}
      {resources.loading && <Loading />}
      {resources.data &&
        (!resources.data.resources.length ? (
          <Empty title="No accessible remote workspaces">
            Ask your administrator to select a remote workspace, then link your personal Terraform
            token in Profile.
          </Empty>
        ) : (
          <div className="field">
            <label htmlFor="tf-workspace-picker">Remote workspace</label>
            <select
              id="tf-workspace-picker"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Select a workspace</option>
              {resources.data.resources.map((r) => (
                <option key={r.connectionId} value={r.connectionId}>
                  {r.organization}/{r.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      {selected && <Workspace key={selected} id={selected} />}
    </div>
  );
}
