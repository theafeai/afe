import { useEffect, useState, useRef, type FormEvent } from "react";
import type {
  GitHubOperation,
  GitHubOperationCapability,
  GitHubOperationParams,
  GitHubPreparedOperation,
  GitHubOperationReceipt,
  GitHubRepositoryChoice,
  GitHubDispatchInput,
} from "@afe/core";
import { ApiError, request } from "../api/client.ts";
import { Empty, ErrorBox, Loading, KeyValue, useAsync, useDocumentTitle } from "../components.tsx";
import { formatBytes, humanize } from "../format.ts";
import { Link, useLocation } from "../router.tsx";
import { TimeAgo } from "./environments-ui.tsx";
import { ProgressState } from "./GitHubRunPanel.tsx";
import "./GitHubOperations.css";
type Item = {
  id: number;
  name?: string;
  path?: string;
  state?: string;
  status?: string;
  conclusion?: string;
  run_attempt?: number;
  run_id?: number;
  head_branch?: string;
  head_sha?: string;
  environment?: string | { id: number; name: string };
  ref?: string;
  description?: string;
  sha?: string;
  expired?: boolean;
  size_in_bytes?: number;
  html_url?: string;
  key?: string;
  type?: string;
  event?: string;
  task?: string;
  created_at?: string;
  updated_at?: string;
  last_accessed_at?: string;
  steps?: { number: number; name: string; status: string; conclusion: string | null }[];
  current_user_can_approve?: boolean;
  protection_rules?: {
    type: string;
    wait_timer?: number;
    prevent_self_review?: boolean;
    reviewers?: { type: "User" | "Team"; reviewer: { id: number } }[];
  }[];
  deployment_branch_policy?: { protected_branches: boolean; custom_branch_policies: boolean };
  reviewers?: { type: "User" | "Team"; reviewer: { id: number } }[];
};
type Page = { items: Item[]; page: number; hasMore: boolean };
type Reader = <T>(view: string, query?: Record<string, string>) => Promise<T>;
type Prepare = (action: GitHubOperation, params: GitHubOperationParams) => Promise<void>;
const tabs = [
  ["workflows", "Workflows"],
  ["runs", "Runs"],
  ["deployments", "Deployments"],
  ["environments", "Environments"],
  ["artifacts", "Artifacts"],
  ["caches", "Caches"],
  ["history", "Request history"],
] as const;
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function OperationButton({
  action,
  capabilities,
  params,
  prepare,
  label,
}: {
  label?: string;
  action: GitHubOperation;
  capabilities: GitHubOperationCapability[];
  params: GitHubOperationParams;
  prepare: Prepare;
}) {
  const c = capabilities.find((c) => c.action === action);
  if (!c) return null;
  return (
    <span className="gh-op">
      <button
        className={c.destructive ? "btn btn-danger" : "btn"}
        disabled={!c.enabled}
        title={c.reason ?? undefined}
        onClick={() => void prepare(action, params)}
      >
        {label ?? c.label}
      </button>
      {!c.enabled && c.reason && <small className="gh-op-reason">{c.reason}</small>}
    </span>
  );
}
/** GitHub run, job and step state as the app's outcome badge. */
function RunState({ item }: { item: { status?: string | null; conclusion?: string | null } }) {
  return <ProgressState status={item.status ?? null} conclusion={item.conclusion ?? null} />;
}
function When({ iso }: { iso?: string }) {
  return iso ? <TimeAgo iso={iso} /> : null;
}
function ShortSha({ sha }: { sha?: string }) {
  return sha ? <code title={sha}>{sha.slice(0, 7)}</code> : null;
}
const RECEIPT_OUTCOME: Record<GitHubOperationReceipt["state"], string> = {
  accepted: "succeeded",
  rejected: "failed",
  unknown: "pending",
  requested: "pending",
  released: "none",
};
function ReceiptState({ state }: { state: GitHubOperationReceipt["state"] }) {
  return <span className={`badge outcome outcome-${RECEIPT_OUTCOME[state]}`}>{state}</span>;
}
type Row = {
  title: React.ReactNode;
  meta: React.ReactNode[];
  status?: React.ReactNode;
  time?: string;
};
/** What each list shows for one GitHub object: a title, a short meta line, a state and a time. */
function describe(tab: string, item: Item): Row {
  const env = typeof item.environment === "string" ? item.environment : item.environment?.name;
  switch (tab) {
    case "workflows":
      return {
        title: item.name ?? `Workflow ${item.id}`,
        meta: [<code key="path">{item.path}</code>],
        status: item.state && (
          <span className={`badge${item.state === "active" ? "" : " gh-badge-off"}`}>
            {humanize(item.state)}
          </span>
        ),
        time: item.updated_at,
      };
    case "runs":
      return {
        title: item.name ?? `Run ${item.id}`,
        meta: [
          <span key="id">Run {item.id}</span>,
          item.event && <span key="event">{humanize(item.event)}</span>,
          item.head_branch && (
            <span key="branch" className="gh-branch" title={item.head_branch}>
              {item.head_branch}
            </span>
          ),
          <ShortSha key="sha" sha={item.head_sha} />,
          (item.run_attempt ?? 1) > 1 && <span key="attempt">Attempt {item.run_attempt}</span>,
        ],
        status: <RunState item={item} />,
        time: item.created_at,
      };
    case "deployments":
      return {
        title: env ?? `Deployment ${item.id}`,
        meta: [
          <span key="id">Deployment {item.id}</span>,
          item.task && <span key="task">{item.task}</span>,
          item.ref && (
            <span key="ref" className="gh-branch" title={item.ref}>
              {item.ref}
            </span>
          ),
          <ShortSha key="sha" sha={item.sha} />,
        ],
        time: item.created_at,
      };
    case "environments":
      return { title: item.name ?? String(item.id), meta: [], time: item.updated_at };
    case "artifacts":
      return {
        title: item.name ?? `Artifact ${item.id}`,
        meta: [
          <span key="size">{formatBytes(item.size_in_bytes)}</span>,
          item.run_id && <span key="run">Run {item.run_id}</span>,
        ],
        status: (
          <span className={item.expired ? "badge gh-badge-off" : "badge"}>
            {item.expired ? "expired" : "available"}
          </span>
        ),
        time: item.created_at,
      };
    case "caches":
      return {
        title: <code>{item.key ?? item.id}</code>,
        meta: [
          item.ref && (
            <span key="ref" className="gh-branch" title={item.ref}>
              {item.ref}
            </span>
          ),
          <span key="size">{formatBytes(item.size_in_bytes)}</span>,
        ],
        time: item.last_accessed_at,
      };
    default:
      return { title: item.name ?? String(item.id), meta: [] };
  }
}
function Pager({
  page,
  hasMore,
  onPage,
  noun,
}: {
  page: number;
  hasMore: boolean;
  onPage: (page: number) => void;
  noun: string;
}) {
  if (page === 1 && !hasMore) return null;
  return (
    <nav className="gh-pager" aria-label={`${noun} pages`}>
      <span className="small muted">Page {page}</span>
      <div className="toolbar">
        <button className="btn" disabled={page === 1} onClick={() => onPage(page - 1)}>
          Previous page
        </button>
        <button className="btn" disabled={!hasMore} onClick={() => onPage(page + 1)}>
          Next page
        </button>
      </div>
    </nav>
  );
}
export function GitHubOperationsPage() {
  useDocumentTitle("GitHub Actions");
  const [page, setPage] = useState(1);
  const resources = useAsync(
    (s) =>
      request<{ items: GitHubRepositoryChoice[]; hasMore: boolean }>(
        "GET",
        `/api/actions/github/resources?page=${page}`,
        undefined,
        s,
      ),
    [page],
  );
  const { search } = useLocation();
  const initial = new URLSearchParams(search);
  const [selected, setSelected] = useState(
    initial.get("connectionId") && initial.get("repository")
      ? {
          connectionId: initial.get("connectionId")!,
          repository: initial.get("repository")!,
          connectionName: "",
        }
      : null,
  );
  const known = resources.data?.items.find(
    (r) => r.connectionId === selected?.connectionId && r.repository === selected?.repository,
  );
  const scope = selected && known ? known : selected;
  return (
    <div className="page gh-page">
      <header className="page-header">
        <div>
          <h1>GitHub Actions</h1>
          <p className="lede">
            Inspect workflows, jobs and deployments, and operate them from Afe.
          </p>
        </div>
        <div className="toolbar">
          <Link className="btn btn-ghost" to="/profile">
            Link or update your GitHub account
          </Link>
        </div>
      </header>
      {resources.loading && <Loading label="Loading GitHub repositories…" />}
      {resources.error && <ErrorBox error={resources.error} onRetry={resources.reload} />}
      {resources.data && (
        <section className="card gh-picker" aria-label="Repository">
          <div className="gh-picker-row">
            <Field label="Connected repository">
              <select
                value={selected ? `${selected.connectionId}|${selected.repository}` : ""}
                onChange={(e) => {
                  const item = resources.data!.items.find(
                    (x) => `${x.connectionId}|${x.repository}` === e.target.value,
                  );
                  setSelected(item ?? null);
                }}
              >
                <option value="">Select a repository</option>
                {selected && !known && (
                  <option value={`${selected.connectionId}|${selected.repository}`}>
                    {selected.repository}
                  </option>
                )}
                {resources.data.items.map((r) => (
                  <option
                    key={`${r.connectionId}|${r.repository}`}
                    value={`${r.connectionId}|${r.repository}`}
                  >
                    {r.repository} · {r.connectionName}
                  </option>
                ))}
              </select>
            </Field>
            {(page > 1 || resources.data.hasMore) && (
              <div className="toolbar">
                <button className="btn" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                  Previous repositories
                </button>
                <button
                  className="btn"
                  disabled={!resources.data.hasMore}
                  onClick={() => setPage((p) => p + 1)}
                >
                  More repositories
                </button>
              </div>
            )}
          </div>
          {!resources.data.items.length && (
            <Empty title="No repositories on this page">
              <p>
                Only connected repositories available to your GitHub identity and Afe policy appear.
                Try the next page or update your account in Profile.
              </p>
            </Empty>
          )}
          {resources.data.items.length > 0 && !selected && (
            <p className="small muted gh-picker-hint">
              Choose a repository to see its workflows, runs and deployments.
            </p>
          )}
        </section>
      )}
      {scope && <GitHubWorkspace key={`${scope.connectionId}|${scope.repository}`} scope={scope} />}
    </div>
  );
}
function GitHubWorkspace({ scope }: { scope: GitHubRepositoryChoice }) {
  const root = `/api/actions/github/repositories/${scope.repository.split("/").map(encodeURIComponent).join("/")}`;
  const [tab, setTab] = useState<string>("workflows"),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<Item | null>(null);
  const [error, setError] = useState<Error | null>(null),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<{
      preview: GitHubPreparedOperation;
      params: GitHubOperationParams;
      requestId: string;
    } | null>(null),
    [receipt, setReceipt] = useState<GitHubOperationReceipt | null>(null),
    [recovery, setRecovery] = useState<GitHubOperationReceipt | null>(null),
    [risk, setRisk] = useState(false);
  const sending = useRef(false);
  const notice = useRef<HTMLDivElement>(null);
  // A prepared operation or its outcome is shown above the list; bring it into view.
  useEffect(() => {
    if (pending || receipt || recovery) notice.current?.scrollIntoView?.({ block: "nearest" });
  }, [pending, receipt, recovery]);
  const read: Reader = (view, query = {}) =>
    request(
      "GET",
      `${root}?${new URLSearchParams({ connectionId: scope.connectionId, view, ...query })}`,
    );
  const caps = useAsync(
    () =>
      read<{ items: GitHubOperationCapability[] }>(
        "capabilities",
        selected && tab === "runs"
          ? { runId: String(selected.id) }
          : selected && tab === "workflows"
            ? { workflowId: String(selected.id) }
            : {},
      ),
    [root, revision, tab, selected?.id],
  );
  const list = useAsync(() => read<Page>(tab, { page: String(page) }), [root, tab, page, revision]);
  const can = (action: GitHubOperation) =>
    caps.data?.items.find((c) => c.action === action)?.enabled ?? false;
  const label = (action: string) =>
    caps.data?.items.find((c) => c.action === action)?.label ?? humanize(action);
  const refresh = () => setRevision((r) => r + 1);
  const show = (next: string) => {
    setTab(next);
    setPage(1);
    setSelected(null);
  };
  async function prepare(action: GitHubOperation, params: GitHubOperationParams) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setPending(null);
    setReceipt(null);
    try {
      const preview = await request<GitHubPreparedOperation>("POST", root + "/prepare", {
        connectionId: scope.connectionId,
        action,
        params,
      });
      setPending({ preview, params, requestId: crypto.randomUUID() });
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Preparation failed"));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function execute() {
    if (!pending || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await request<GitHubOperationReceipt>("POST", root, {
        connectionId: scope.connectionId,
        action: pending.preview.action,
        params: pending.params,
        expectedVersion: pending.preview.version,
        requestId: pending.requestId,
        confirmed: true,
      });
      setReceipt(result);
      setPending(null);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.body?.state) {
        setReceipt(e.body as unknown as GitHubOperationReceipt);
        setPending(null);
        refresh();
      }
      setError(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function release() {
    if (!recovery || !risk || sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const result = await request<GitHubOperationReceipt>(
        "POST",
        `${root}/requests/${recovery.requestId}/release`,
        { connectionId: scope.connectionId, confirmed: true, acknowledgeDuplicateRisk: true },
      );
      setReceipt(result);
      setRecovery(null);
      setRisk(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Recovery failed"));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const button = (action: GitHubOperation, params: GitHubOperationParams, label?: string) => (
    <OperationButton
      action={action}
      label={label}
      params={params}
      capabilities={caps.data?.items ?? []}
      prepare={prepare}
    />
  );
  const tabLabel = tabs.find((t) => t[0] === tab)?.[1] ?? "";
  const details = (item: Item) => {
    switch (tab) {
      case "workflows":
        return (
          <WorkflowPanel
            key={item.id}
            item={item}
            read={read}
            prepare={prepare}
            button={button}
            can={can}
          />
        );
      case "runs":
        return (
          <RunPanel
            key={`${item.id}:${revision}`}
            item={item}
            read={read}
            button={button}
            can={can}
            download={(kind, id, attempt) =>
              `${root}/download?${new URLSearchParams({ connectionId: scope.connectionId, kind, id: String(id), ...(attempt ? { attempt: String(attempt) } : {}) })}`
            }
          />
        );
      case "deployments":
        return (
          <DeploymentPanel
            key={`${item.id}:${revision}`}
            item={item}
            read={read}
            prepare={prepare}
            button={button}
            can={can}
          />
        );
      case "environments":
        return (
          <EnvironmentPanel
            key={`${item.id}:${revision}`}
            item={item}
            read={read}
            prepare={prepare}
            button={button}
            can={can}
          />
        );
      case "artifacts":
        return (
          <div className="gh-detail">
            <KeyValue
              items={[
                ["Source ID", String(item.id)],
                ["Size", formatBytes(item.size_in_bytes)],
                ["Expired", item.expired ? "Yes" : "No"],
                ["Workflow run", String(item.run_id ?? "Unknown")],
              ]}
            />
            <div className="toolbar">
              {can("github.artifact_download") && !item.expired && (
                <a
                  className="btn"
                  href={`${root}/download?${new URLSearchParams({ connectionId: scope.connectionId, kind: "artifact", id: String(item.id) })}`}
                >
                  Download artifact
                </a>
              )}
              {button("github.artifact_delete", { artifactId: item.id })}
            </div>
          </div>
        );
      case "caches":
        return (
          <div className="gh-detail">
            <KeyValue
              items={[
                ["Key", <code key="k">{item.key}</code>],
                ["Ref", item.ref],
                ["Size", formatBytes(item.size_in_bytes)],
                ["Last used", item.last_accessed_at && <TimeAgo iso={item.last_accessed_at} />],
              ]}
            />
            <div className="toolbar">
              {button("github.cache_delete", { cacheId: item.id, key: item.key, ref: item.ref })}
            </div>
          </div>
        );
      default:
        return null;
    }
  };
  return (
    <div aria-busy={busy}>
      <section className="card gh-repo">
        <div className="gh-repo-head">
          <div className="gh-repo-title">
            <h2 className="mono-title">{scope.repository}</h2>
            <p className="small muted">
              {scope.connectionName ? (
                <>
                  Through <strong>{scope.connectionName}</strong> ·{" "}
                </>
              ) : null}
              Afe action grants and your current GitHub permissions both apply. Source events show
              completion after a request is accepted.
            </p>
          </div>
          <div className="toolbar">
            <a
              className="btn btn-ghost"
              href={`https://github.com/${scope.repository}/actions`}
              target="_blank"
              rel="noreferrer"
            >
              Open on GitHub
            </a>
            <button className="btn" disabled={busy} onClick={refresh}>
              Refresh GitHub state
            </button>
          </div>
        </div>
        <div className="gh-tabs" role="group" aria-label="GitHub views">
          {tabs.map(([value, label]) => (
            <button
              className="gh-tab"
              key={value}
              aria-pressed={tab === value}
              onClick={() => show(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      <div ref={notice}>
        {(error || caps.error) && <ErrorBox error={(error ?? caps.error)!} />}
        {receipt && (
          <section
            className={`callout ${receipt.state === "accepted" ? "callout-ok" : receipt.state === "rejected" ? "callout-error" : receipt.state === "released" ? "" : "callout-gap"} gh-receipt`}
            role="status"
          >
            <div className="gh-receipt-body">
              <p>
                <ReceiptState state={receipt.state} /> <strong>{label(receipt.action)}</strong>
              </p>
              <p>{receipt.message}</p>
              <p className="small muted">
                Request <code>{receipt.requestId}</code>
                {receipt.result?.id ? ` · Source ID ${receipt.result.id}` : ""}
              </p>
            </div>
            <div className="toolbar">
              <button className="btn" onClick={() => show("history")}>
                Inspect request history
              </button>
              <button className="btn btn-ghost" onClick={() => setReceipt(null)}>
                Dismiss
              </button>
            </div>
          </section>
        )}
        {pending && (
          <section className="card gh-confirm" role="group" aria-label="Confirm GitHub operation">
            <h2>Confirm operation</h2>
            <p className="gh-confirm-summary">{pending.preview.summary}</p>
            <p className="small muted">
              This may trigger a deployment or change source configuration. If another tool changes
              this resource, Afe will ask you to refresh.
            </p>
            <div className="toolbar">
              <button
                className={
                  caps.data?.items.find((c) => c.action === pending.preview.action)?.destructive
                    ? "btn btn-danger"
                    : "btn btn-primary"
                }
                disabled={busy}
                onClick={() => void execute()}
              >
                Confirm operation
              </button>
              <button className="btn" disabled={busy} onClick={() => setPending(null)}>
                Go back
              </button>
            </div>
          </section>
        )}
        {recovery && (
          <section className="card gh-confirm">
            <h2>Recover uncertain request</h2>
            <p>
              Inspect the source state in the Runs, Workflows or Deployments tabs first. The
              original request might have succeeded; another submission could create a duplicate
              deployment.
            </p>
            <label className="check">
              <input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} />I
              checked the current source state and accept the risk of a duplicate operation.
            </label>
            <div className="toolbar">
              <button
                className="btn btn-danger"
                disabled={!risk || busy}
                onClick={() => void release()}
              >
                Allow a new deliberate request
              </button>
              <button className="btn" onClick={() => setRecovery(null)}>
                Go back
              </button>
            </div>
          </section>
        )}
      </div>
      <section className="gh-list-section" aria-label={tabLabel}>
        <div className="gh-list-head">
          <h2>{tabLabel}</h2>
          {list.data && list.data.items.length > 0 && (
            <span className="small muted">
              {list.data.items.length} on page {page}
              {list.data.hasMore ? ", more available" : ""}
            </span>
          )}
        </div>
        {list.loading && <Loading label="Loading GitHub state…" />}
        {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
        {list.data && !list.data.items.length && (
          <Empty title={`No ${tabLabel.toLowerCase()} on this page`}>
            <p>Refresh after source changes, select another repository, or check another page.</p>
          </Empty>
        )}
        {list.data && list.data.items.length > 0 && tab === "history" && (
          <ul className="gh-list">
            {(list.data.items as unknown as GitHubOperationReceipt[]).map((r) => (
              <li className="gh-row" key={r.requestId}>
                <div className="gh-row-main">
                  <div className="gh-row-text">
                    <span className="gh-row-title">{label(r.action)}</span>
                    <p className="gh-row-message">{r.message}</p>
                    <span className="gh-row-meta">
                      <code title={r.requestId}>{r.requestId}</code>
                    </span>
                  </div>
                  <div className="gh-row-state">
                    <ReceiptState state={r.state} />
                  </div>
                  <div className="gh-row-time">
                    <When iso={r.createdAt} />
                  </div>
                  <div className="gh-row-action">
                    {["unknown", "requested"].includes(r.state) && (
                      <button
                        className="btn"
                        onClick={() => {
                          setRecovery(r);
                          setRisk(false);
                        }}
                      >
                        Review recovery
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {list.data && list.data.items.length > 0 && tab !== "history" && (
          <ul className="gh-list">
            {list.data.items.map((item) => {
              const row = describe(tab, item);
              const open = selected?.id === item.id;
              const detailId = `gh-detail-${tab}-${item.id}`;
              return (
                <li className={open ? "gh-row is-open" : "gh-row"} key={item.id}>
                  <div className="gh-row-main">
                    <div className="gh-row-text">
                      <span className="gh-row-title">{row.title}</span>
                      {row.meta.some(Boolean) && (
                        <span className="gh-row-meta">{row.meta.filter(Boolean)}</span>
                      )}
                    </div>
                    <div className="gh-row-state">{row.status}</div>
                    <div className="gh-row-time">
                      <When iso={row.time} />
                    </div>
                    <div className="gh-row-action">
                      <button
                        className="btn btn-ghost"
                        aria-expanded={open}
                        aria-controls={open ? detailId : undefined}
                        onClick={() => setSelected(open ? null : item)}
                      >
                        {open ? "Hide details" : "Open details"}
                      </button>
                    </div>
                  </div>
                  {open && (
                    <div className="gh-row-detail" id={detailId}>
                      {details(item)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {list.data && (
          <Pager
            page={page}
            hasMore={list.data.hasMore}
            noun={tabLabel}
            onPage={(p) => {
              setPage(p);
              setSelected(null);
            }}
          />
        )}
      </section>
      {tab === "deployments" && !selected && (
        <details className="card gh-create">
          <summary>Create deployment</summary>
          <DeploymentPanel
            key={`new:${revision}`}
            item={null}
            read={read}
            prepare={prepare}
            button={button}
            can={can}
          />
        </details>
      )}
      {tab === "environments" && !selected && (
        <details className="card gh-create">
          <summary>Create environment</summary>
          <EnvironmentPanel
            key={`new:${revision}`}
            item={null}
            read={read}
            prepare={prepare}
            button={button}
            can={can}
          />
        </details>
      )}
    </div>
  );
}
type PanelProps = {
  item: Item;
  read: Reader;
  prepare: Prepare;
  button: (a: GitHubOperation, p: GitHubOperationParams, label?: string) => React.ReactNode;
  can: (a: GitHubOperation) => boolean;
};
function WorkflowPanel({ item, read, prepare, button, can }: PanelProps) {
  const [ref, setRef] = useState("main"),
    [loadedRef, setLoadedRef] = useState("main"),
    [inputs, setInputs] = useState<Record<string, string | boolean | number>>({});
  const [refPage, setRefPage] = useState(1);
  const refs = useAsync(async () => {
    const [branches, tags] = await Promise.all([
      read<Page>("branches", { page: String(refPage) }),
      read<Page>("tags", { page: String(refPage) }),
    ]);
    return { items: [...branches.items, ...tags.items], hasMore: branches.hasMore || tags.hasMore };
  }, [refPage]);
  const file = useAsync(
    () =>
      read<{
        path: string;
        sha: string;
        content?: string;
        dispatchable: boolean;
        inputs: GitHubDispatchInput[];
      }>("workflow_file", { id: String(item.id), ref: loadedRef }),
    [item.id, loadedRef],
  );
  const environments = useAsync(() => read<Page>("environments"), [item.id]);
  return (
    <div className="gh-detail" role="region" aria-label={item.name ?? "Workflow"}>
      <div className="gh-detail-head">
        <KeyValue
          items={[
            ["File", <code key="p">{item.path}</code>],
            ["State", item.state && humanize(item.state)],
          ]}
        />
        <div className="toolbar gh-ops">
          {button("github.enable", { workflowId: item.id })}
          {button("github.disable", { workflowId: item.id })}
        </div>
      </div>
      <section className="gh-section">
        <h3>Dispatch workflow</h3>
        <form
          className="gh-ref-form"
          onSubmit={(e) => {
            e.preventDefault();
            setLoadedRef(ref);
            setInputs({});
            file.reload();
          }}
        >
          <Field label="Workflow branch, tag or SHA">
            <input
              value={ref}
              required
              list={`workflow-refs-${item.id}`}
              onChange={(e) => setRef(e.target.value)}
            />
            <datalist id={`workflow-refs-${item.id}`}>
              {refs.data?.items.map((r, i) => (
                <option key={`${r.name}:${i}`} value={r.name} />
              ))}
            </datalist>
          </Field>
          <div className="toolbar">
            <button className="btn">Load ref and inputs</button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={refPage === 1}
              onClick={() => setRefPage((p) => p - 1)}
            >
              Previous refs
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!refs.data?.hasMore}
              onClick={() => setRefPage((p) => p + 1)}
            >
              More refs
            </button>
          </div>
        </form>
        {refs.error && <ErrorBox error={refs.error} />}
        {file.loading && <Loading />}
        {file.error && <ErrorBox error={file.error} onRetry={file.reload} />}
        {file.data && (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void prepare("github.dispatch", {
                workflowId: item.id,
                ref: loadedRef,
                inputs: Object.fromEntries(
                  file
                    .data!.inputs.map((i) => [
                      i.name,
                      inputs[i.name] ?? i.default ?? (i.type === "boolean" ? false : undefined),
                    ])
                    .filter(([, value]) => value !== undefined),
                ),
              });
            }}
          >
            {file.data.inputs.map((input) =>
              input.type === "boolean" ? (
                <label className="check" key={input.name}>
                  <input
                    type="checkbox"
                    checked={Boolean(inputs[input.name] ?? input.default ?? false)}
                    onChange={(e) => setInputs({ ...inputs, [input.name]: e.target.checked })}
                  />
                  {input.name}
                  {input.required ? " (required)" : ""}
                  {input.description ? ` — ${input.description}` : ""}
                </label>
              ) : (
                <Field
                  key={input.name}
                  label={`${input.name}${input.required ? " (required)" : ""}${input.description ? ` — ${input.description}` : ""}`}
                >
                  {input.type === "environment" ? (
                    <>
                      <input
                        required={input.required}
                        list={`dispatch-environments-${item.id}-${input.name}`}
                        value={String(inputs[input.name] ?? input.default ?? "")}
                        onChange={(e) => setInputs({ ...inputs, [input.name]: e.target.value })}
                      />
                      <datalist id={`dispatch-environments-${item.id}-${input.name}`}>
                        {environments.data?.items.map((e) => (
                          <option key={e.id} value={e.name} />
                        ))}
                      </datalist>
                    </>
                  ) : input.type === "choice" ? (
                    <select
                      required={input.required}
                      value={String(inputs[input.name] ?? input.default ?? "")}
                      onChange={(e) => setInputs({ ...inputs, [input.name]: e.target.value })}
                    >
                      <option value="">Select a value</option>
                      {(input.options ?? []).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={input.type === "number" ? "number" : "text"}
                      required={input.required}
                      value={String(inputs[input.name] ?? input.default ?? "")}
                      onChange={(e) =>
                        setInputs({
                          ...inputs,
                          [input.name]:
                            input.type === "number" ? Number(e.target.value) : e.target.value,
                        })
                      }
                    />
                  )}
                </Field>
              ),
            )}
            <div className="toolbar">
              <button
                className="btn btn-primary"
                disabled={!can("github.dispatch") || !file.data.dispatchable}
              >
                Prepare dispatch
              </button>
              <span className="small muted">
                From <code>{loadedRef}</code>
              </span>
            </div>
            {!file.data.dispatchable && (
              <p className="small muted">This ref does not declare workflow_dispatch.</p>
            )}
          </form>
        )}
      </section>
      {file.data?.content !== undefined && (
        <details className="gh-section">
          <summary>Edit workflow YAML</summary>
          <WorkflowEditor
            key={`${file.data.sha}:${loadedRef}`}
            prepare={prepare}
            canSave={can("github.workflow_save")}
            canDelete={can("github.workflow_delete")}
            file={{ ...file.data, content: file.data.content, branch: loadedRef }}
          />
        </details>
      )}
    </div>
  );
}
function WorkflowEditor({
  prepare,
  file,
  canSave,
  canDelete,
}: {
  canSave: boolean;
  canDelete: boolean;
  prepare: Prepare;
  file: { path: string; sha: string; content: string; branch: string };
}) {
  const { path, branch, sha } = file;
  const [content, setContent] = useState(file.content),
    [message, setMessage] = useState("Update workflow from Afe");
  return (
    <section className="card">
      <h3>Edit workflow file</h3>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void prepare("github.workflow_save", {
            path,
            branch,
            content,
            message,
            sha,
          });
        }}
      >
        <Field label="Workflow file path">
          <input value={path} readOnly required />
        </Field>
        <Field label="Target branch">
          <input value={branch} readOnly required />
        </Field>
        <Field label="Commit message">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            maxLength={500}
          />
        </Field>
        <Field label="Workflow YAML">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={15}
            required
            spellCheck={false}
          />
        </Field>
        <p className="muted">
          Only workflow YAML is read or edited. Branch protection and GitHub workflow permissions
          still apply.
        </p>
        <button className="btn" disabled={!canSave}>
          Prepare workflow save
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!canDelete}
          onClick={() => void prepare("github.workflow_delete", { path, branch, message, sha })}
        >
          Prepare workflow deletion
        </button>
      </form>
    </section>
  );
}
function RunPanel({
  item,
  read,
  button,
  download,
}: Omit<PanelProps, "prepare"> & {
  download: (kind: string, id: number, attempt?: number) => string;
}) {
  const run = useAsync(() => read<{ item: Item }>("run", { id: String(item.id) }), [item.id]);
  const current = run.data?.item ?? item;
  const [attempt, setAttempt] = useState(item.run_attempt ?? 1),
    [debug, setDebug] = useState(false),
    [envIds, setEnvIds] = useState<number[]>([]),
    [comment, setComment] = useState("");
  const [jobPage, setJobPage] = useState(1);
  const jobs = useAsync(
    () =>
      read<Page>("jobs", {
        runId: String(item.id),
        attempt: String(attempt),
        page: String(jobPage),
      }),
    [item.id, attempt, jobPage],
  );
  const pending = useAsync(() => read<Page>("pending", { runId: String(item.id) }), [item.id]);
  const archives = useAsync(
    () =>
      read<{ items: GitHubOperationCapability[] }>("capabilities", {
        runId: String(item.id),
        attempt: String(attempt),
      }),
    [item.id, attempt],
  );
  const logCapability = archives.data?.items.find((c) => c.action === "github.logs_download");
  const params = { runId: item.id, attempt: current.run_attempt ?? 1 };
  return (
    <div className="gh-detail" aria-label={`Run ${item.id}`} role="region">
      {run.error && <ErrorBox error={run.error} />}
      <div className="gh-detail-head">
        <KeyValue
          items={[
            ["Status", <RunState key="s" item={current} />],
            ["Current attempt", String(current.run_attempt ?? 1)],
            ["Branch", current.head_branch],
            ["Commit", <ShortSha key="c" sha={current.head_sha} />],
            ["Trigger", current.event && humanize(current.event)],
          ]}
        />
        {current.html_url && (
          <a className="btn" href={current.html_url} target="_blank" rel="noreferrer">
            Open source run
          </a>
        )}
      </div>
      <section className="gh-section" aria-labelledby={`run-${item.id}-actions`}>
        <h3 id={`run-${item.id}-actions`}>Run actions</h3>
        <div className="toolbar gh-ops">
          {button("github.cancel", params)}
          {button("github.force_cancel", params)}
          {button("github.rerun", { ...params, enableDebugLogging: debug })}
          {button("github.rerun_failed", { ...params, enableDebugLogging: debug })}
          {button("github.approve_run", params)}
        </div>
        <label className="check">
          <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
          Enable debug logging for the next re-run
        </label>
      </section>
      <section className="gh-section" aria-labelledby={`run-${item.id}-jobs`}>
        <div className="gh-section-head">
          <h3 id={`run-${item.id}-jobs`}>Jobs and steps</h3>
          <div className="toolbar">
            <label className="gh-inline-field">
              <span>Attempt</span>
              <input
                type="number"
                aria-label="Inspect log/job attempt"
                min={1}
                max={current.run_attempt ?? 1}
                value={attempt}
                onChange={(e) => {
                  setAttempt(Number(e.target.value));
                  setJobPage(1);
                }}
              />
            </label>
            {archives.data?.items.find((c) => c.action === "github.logs_download")?.enabled && (
              <a className="btn" href={download("logs", item.id, attempt)}>
                Download this attempt's archived logs
              </a>
            )}
          </div>
        </div>
        <p className="small muted">
          Open a job’s logs to inspect its completed output. Logs may take a moment to become
          available after completion.
        </p>
        {archives.loading && <Loading label="Checking log access…" />}
        {archives.error && <ErrorBox error={archives.error} onRetry={archives.reload} />}
        {logCapability && !logCapability.enabled && (
          <p className="callout" role="note">
            Logs unavailable: {logCapability.reason}
          </p>
        )}
        {jobs.loading && <Loading />}
        {jobs.error && <ErrorBox error={jobs.error} onRetry={jobs.reload} />}
        {jobs.data && !jobs.data.items.length && <Empty title="No jobs available" />}
        {!jobs.loading && jobs.data && jobs.data.items.length > 0 && (
          <ul className="gh-jobs">
            {jobs.data.items.map((job) => (
              <RunJob
                key={`${attempt}:${job.id}`}
                job={job}
                runId={item.id}
                attempt={attempt}
                read={read}
                enabled={logCapability?.enabled === true}
                unavailableReason={
                  archives.loading
                    ? "Checking log access…"
                    : archives.error
                      ? "Could not check log access. Retry above."
                      : (logCapability?.reason ?? "Log access is unavailable.")
                }
                action={button("github.rerun_job", {
                  ...params,
                  jobId: job.id,
                  enableDebugLogging: debug,
                })}
              />
            ))}
          </ul>
        )}
        {jobs.data && (jobPage > 1 || jobs.data.hasMore) && (
          <div className="toolbar">
            <button
              className="btn"
              disabled={jobPage === 1}
              onClick={() => setJobPage((p) => p - 1)}
            >
              Previous jobs
            </button>
            <button
              className="btn"
              disabled={!jobs.data.hasMore}
              onClick={() => setJobPage((p) => p + 1)}
            >
              More jobs
            </button>
          </div>
        )}
      </section>
      <section className="gh-section" aria-labelledby={`run-${item.id}-reviews`}>
        <h3 id={`run-${item.id}-reviews`}>Pending deployment reviews</h3>
        {pending.loading && <Loading />}
        {pending.error && <ErrorBox error={pending.error} />}
        {pending.data && !pending.data.items.length && (
          <p className="small muted">No environments are awaiting review.</p>
        )}
        {pending.data && pending.data.items.length > 0 && (
          <div className="form">
            <fieldset>
              <legend>Environments</legend>
              {pending.data.items.map((p) => {
                const env =
                  typeof p.environment === "object"
                    ? p.environment
                    : { id: p.id, name: p.name ?? String(p.id) };
                return (
                  <label className="check" key={env.id}>
                    <input
                      type="checkbox"
                      disabled={!p.current_user_can_approve}
                      checked={envIds.includes(env.id)}
                      onChange={(e) =>
                        setEnvIds(
                          e.target.checked
                            ? [...envIds, env.id]
                            : envIds.filter((x) => x !== env.id),
                        )
                      }
                    />
                    {env.name}
                    {!p.current_user_can_approve
                      ? " — Your GitHub identity cannot approve this environment."
                      : ""}
                  </label>
                );
              })}
            </fieldset>
            <Field label="Deployment review comment">
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={2000}
              />
            </Field>
            {envIds.length > 0 && comment.trim() ? (
              <div className="toolbar">
                {button(
                  "github.review_deployment",
                  { ...params, environmentIds: envIds, state: "approved", comment },
                  "Approve selected deployments",
                )}
                {button(
                  "github.review_deployment",
                  { ...params, environmentIds: envIds, state: "rejected", comment },
                  "Reject selected deployments",
                )}
              </div>
            ) : (
              <p className="small muted">Select environments and add a comment to review them.</p>
            )}
          </div>
        )}
      </section>
      <section className="gh-section gh-danger" aria-labelledby={`run-${item.id}-cleanup`}>
        <h3 id={`run-${item.id}-cleanup`}>Cleanup</h3>
        <p className="small muted">These permanently remove the run or its logs on GitHub.</p>
        <div className="toolbar gh-ops">
          {button("github.delete_logs", params)}
          {button("github.delete_run", params)}
        </div>
      </section>
    </div>
  );
}
function DeploymentPanel({
  item,
  read,
  prepare,
  button,
  can,
}: Omit<PanelProps, "item"> & { item: Item | null }) {
  const [ref, setRef] = useState("main"),
    [environment, setEnvironment] = useState(
      typeof item?.environment === "string" ? item.environment : "production",
    ),
    [description, setDescription] = useState(""),
    [state, setState] = useState("pending"),
    [autoMerge, setAutoMerge] = useState(false),
    [autoInactive, setAutoInactive] = useState(false),
    [environmentUrl, setEnvironmentUrl] = useState(""),
    [logUrl, setLogUrl] = useState(""),
    [task, setTask] = useState("deploy"),
    [contexts, setContexts] = useState(""),
    [bypassContexts, setBypassContexts] = useState(false),
    [transient, setTransient] = useState(false),
    [production, setProduction] = useState(true),
    [payload, setPayload] = useState(""),
    [formError, setFormError] = useState<Error | null>(null);
  const statuses = useAsync(
    () =>
      item
        ? read<Page>("statuses", { id: String(item.id) })
        : Promise.resolve({ items: [], hasMore: false, page: 1 }),
    [item?.id],
  );
  function create(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      void prepare("github.deployment_create", {
        ref,
        environment,
        description,
        task,
        autoMerge,
        transientEnvironment: transient,
        productionEnvironment: production,
        ...(bypassContexts
          ? { requiredContexts: [] }
          : contexts.trim()
            ? {
                requiredContexts: contexts
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {}),
        ...(payload.trim() ? { payload: JSON.parse(payload) } : {}),
      });
    } catch {
      setFormError(new Error("Deployment payload must be a JSON object."));
    }
  }
  return (
    <div className="gh-detail">
      {item ? (
        <>
          <KeyValue
            items={[
              ["Ref", item.ref],
              ["Environment", typeof item.environment === "string" ? item.environment : null],
              ["SHA", item.sha && <code key="sha">{item.sha}</code>],
            ]}
          />
          <section className="gh-section">
            <h3>Status history</h3>
            {statuses.loading && <Loading />}
            {statuses.error && <ErrorBox error={statuses.error} />}
            {statuses.data && !statuses.data.items.length && (
              <p className="small muted">GitHub has no statuses for this deployment yet.</p>
            )}
            {statuses.data && statuses.data.items.length > 0 && (
              <ul className="gh-plain-list">
                {statuses.data.items.map((s) => (
                  <li key={s.id}>
                    <span className="badge">{humanize(s.state)}</span>
                    <span>{s.description}</span>
                    <When iso={s.created_at} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <h3>Update status</h3>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void prepare("github.deployment_status", {
                deploymentId: item.id,
                state,
                description,
                environmentUrl,
                logUrl,
                autoInactive,
                ...(environment ? { environment } : {}),
              });
            }}
          >
            <Field label="Deployment state">
              <select value={state} onChange={(e) => setState(e.target.value)}>
                {[
                  "pending",
                  "queued",
                  "in_progress",
                  "success",
                  "failure",
                  "error",
                  "inactive",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Status description">
              <input
                maxLength={140}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Environment name">
              <input value={environment} onChange={(e) => setEnvironment(e.target.value)} />
            </Field>
            <Field label="Environment URL">
              <input
                type="url"
                value={environmentUrl}
                onChange={(e) => setEnvironmentUrl(e.target.value)}
              />
            </Field>
            <Field label="Output URL">
              <input type="url" value={logUrl} onChange={(e) => setLogUrl(e.target.value)} />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={autoInactive}
                onChange={(e) => setAutoInactive(e.target.checked)}
              />
              Mark previous matching deployments inactive
            </label>
            <button className="btn" disabled={!can("github.deployment_status")}>
              Prepare status update
            </button>
          </form>
          <section className="gh-section gh-danger">
            <h3>Delete deployment</h3>
            <div className="toolbar gh-ops">
              {button("github.deployment_delete", { deploymentId: item.id })}
            </div>
          </section>
        </>
      ) : (
        <form className="form" onSubmit={create}>
          <Field label="Deployment ref">
            <input value={ref} onChange={(e) => setRef(e.target.value)} required />
          </Field>
          <Field label="Environment">
            <input value={environment} onChange={(e) => setEnvironment(e.target.value)} required />
          </Field>
          <Field label="Deployment task">
            <input value={task} onChange={(e) => setTask(e.target.value)} />
          </Field>
          <Field label="Deployment description">
            <input
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={autoMerge}
              onChange={(e) => setAutoMerge(e.target.checked)}
            />
            Allow GitHub to merge the default branch before deployment
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={transient}
              onChange={(e) => setTransient(e.target.checked)}
            />
            Transient environment
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={production}
              onChange={(e) => setProduction(e.target.checked)}
            />
            Production environment
          </label>
          <Field label="Required status checks (one per line; blank uses GitHub defaults)">
            <textarea value={contexts} onChange={(e) => setContexts(e.target.value)} />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={bypassContexts}
              onChange={(e) => setBypassContexts(e.target.checked)}
            />
            Explicitly bypass status checks for this deployment
          </label>
          <Field label="Additional deployment payload (optional JSON object)">
            <textarea value={payload} onChange={(e) => setPayload(e.target.value)} />
          </Field>
          {formError && <ErrorBox error={formError} />}
          <button className="btn" disabled={!can("github.deployment_create")}>
            Prepare deployment
          </button>
        </form>
      )}
    </div>
  );
}
function EnvironmentPanel({
  item,
  read,
  prepare,
  button,
  can,
}: Omit<PanelProps, "item"> & { item: Item | null }) {
  const environmentName = item?.name ?? "";
  const details = useAsync(
    () =>
      item
        ? read<{ item: Item | null }>("environment", { name: environmentName })
        : Promise.resolve({ item: null }),
    [environmentName],
  );
  if (details.loading) return <Loading />;
  if (details.error) return <ErrorBox error={details.error} onRetry={details.reload} />;
  return (
    <EnvironmentEditor
      key={JSON.stringify(details.data)}
      item={details.data?.item ?? null}
      read={read}
      prepare={prepare}
      button={button}
      can={can}
    />
  );
}
function EnvironmentEditor({
  item,
  read,
  prepare,
  button,
  can,
}: Omit<PanelProps, "item"> & { item: Item | null }) {
  const reviewerRule = item?.protection_rules?.find((r) => r.type === "required_reviewers");
  const wait = item?.protection_rules?.find((r) => r.type === "wait_timer")?.wait_timer ?? 0;
  const [policyId, setPolicyId] = useState<number | undefined>(undefined);
  const [name, setName] = useState(item?.name ?? ""),
    [timer, setTimer] = useState(wait),
    [self, setSelf] = useState(reviewerRule?.prevent_self_review ?? false),
    [reviewers, setReviewers] = useState(
      (reviewerRule?.reviewers ?? []).map((r) => `${r.type}:${r.reviewer.id}`).join("\n"),
    ),
    [branchPolicy, setBranchPolicy] = useState(
      item?.deployment_branch_policy?.custom_branch_policies
        ? "custom"
        : item?.deployment_branch_policy?.protected_branches
          ? "protected"
          : "none",
    ),
    [pattern, setPattern] = useState(""),
    [policyType, setPolicyType] = useState("branch");
  const [reviewerPage, setReviewerPage] = useState(1);
  const options = useAsync(
    () =>
      can("github.environment_save")
        ? read<Page>("reviewers", { page: String(reviewerPage) })
        : Promise.resolve({ items: [], hasMore: false, page: 1 }),
    [reviewerPage],
  );
  const customRules = useAsync(
    () =>
      item
        ? read<Page>("protection_rules", { name: item.name ?? "" })
        : Promise.resolve({ items: [], hasMore: false, page: 1 }),
    [item?.name],
  );
  const ruleApps = useAsync(
    () =>
      item && can("github.protection_rule_enable")
        ? read<Page>("protection_apps", { name: item.name ?? "" })
        : Promise.resolve({ items: [], hasMore: false, page: 1 }),
    [item?.name],
  );
  const policies = useAsync(
    () =>
      item
        ? read<Page>("branch_policies", { name: item.name ?? "" })
        : Promise.resolve({ items: [], hasMore: false, page: 1 }),
    [item?.name],
  );
  function save(e: FormEvent) {
    e.preventDefault();
    void prepare("github.environment_save", {
      environment: name,
      waitTimer: timer,
      preventSelfReview: self,
      reviewers: reviewers
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const [type, id] = x.split(":");
          return { type, id: Number(id) };
        }),
      branchPolicy:
        branchPolicy === "none"
          ? null
          : {
              protected_branches: branchPolicy === "protected",
              custom_branch_policies: branchPolicy === "custom",
            },
    });
  }
  return (
    <div className="gh-detail">
      <form className="form" onSubmit={save}>
        <Field label="Environment name">
          <input
            required
            value={name}
            readOnly={!!item}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Wait timer (minutes)">
          <input
            type="number"
            min={0}
            max={43200}
            value={timer}
            onChange={(e) => setTimer(Number(e.target.value))}
          />
        </Field>
        <label className="check">
          <input type="checkbox" checked={self} onChange={(e) => setSelf(e.target.checked)} />
          Prevent self-review
        </label>
        <Field label="Required reviewers (up to six; User:ID or Team:ID, one per line)">
          <textarea value={reviewers} onChange={(e) => setReviewers(e.target.value)} />
        </Field>
        {options.error && <ErrorBox error={options.error} />}
        <Field label="Add a repository reviewer">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value)
                setReviewers((value) =>
                  [...new Set([...value.split("\n").filter(Boolean), e.target.value])].join("\n"),
                );
            }}
          >
            <option value="">Choose a GitHub user or team</option>
            {options.data?.items.map((o) => (
              <option key={`${o.type}:${o.id}`} value={`${o.type}:${o.id}`}>
                {o.name} ({o.type})
              </option>
            ))}
          </select>
        </Field>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={reviewerPage === 1}
            onClick={() => setReviewerPage((p) => p - 1)}
          >
            Previous reviewers
          </button>
          <button
            type="button"
            className="btn"
            disabled={!options.data?.hasMore}
            onClick={() => setReviewerPage((p) => p + 1)}
          >
            More reviewers
          </button>
        </div>
        <Field label="Deployment branch protection">
          <select value={branchPolicy} onChange={(e) => setBranchPolicy(e.target.value)}>
            <option value="none">No branch restriction</option>
            <option value="protected">Protected branches only</option>
            <option value="custom">Custom branch and tag policies</option>
          </select>
        </Field>
        <button className="btn" disabled={!can("github.environment_save")}>
          Prepare environment save
        </button>
      </form>
      {item && (
        <>
          <h3>Deployment branch policies</h3>
          {policies.error && <ErrorBox error={policies.error} />}
          <ul className="gh-plain-list">
            {policies.data?.items.map((p) => (
              <li key={p.id}>
                {p.name} · {p.type}{" "}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setPolicyId(p.id);
                    setPattern(p.name ?? "");
                    setPolicyType(p.type ?? "branch");
                  }}
                >
                  Edit pattern
                </button>
                {button("github.branch_policy_delete", { environment: name, policyId: p.id })}
              </li>
            ))}
          </ul>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void prepare("github.branch_policy_save", {
                environment: name,
                name: pattern,
                type: policyType,
                ...(policyId ? { policyId } : {}),
              });
            }}
          >
            <Field label="Branch or tag pattern">
              <input required value={pattern} onChange={(e) => setPattern(e.target.value)} />
            </Field>
            <Field label="Policy type">
              <select
                disabled={policyId !== undefined}
                value={policyType}
                onChange={(e) => setPolicyType(e.target.value)}
              >
                <option value="branch">Branch</option>
                <option value="tag">Tag</option>
              </select>
            </Field>
            <button className="btn" disabled={!can("github.branch_policy_save")}>
              Prepare branch policy
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPolicyId(undefined);
                setPattern("");
              }}
            >
              New branch policy
            </button>
          </form>
          <h3>Custom deployment protection integrations</h3>
          {customRules.error && <ErrorBox error={customRules.error} />}
          <ul className="gh-plain-list">
            {customRules.data?.items.map((rule) => (
              <li key={rule.id}>
                {rule.name}
                {button("github.protection_rule_delete", { environment: name, ruleId: rule.id })}
              </li>
            ))}
          </ul>
          {ruleApps.error && <ErrorBox error={ruleApps.error} />}
          <ul className="gh-plain-list">
            {ruleApps.data?.items.map((app) => (
              <li key={app.id}>
                {app.name}
                {button("github.protection_rule_enable", { environment: name, appId: app.id })}
              </li>
            ))}
          </ul>
          <p className="muted">
            Custom rule decisions are supplied by the registered GitHub App. A user cannot
            impersonate that integration to approve its callback.
          </p>
          <section className="gh-section gh-danger">
            <h3>Delete environment</h3>
            <div className="toolbar gh-ops">
              {button("github.environment_delete", { environment: name })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function RunJob({
  job,
  runId,
  attempt,
  read,
  enabled,
  unavailableReason,
  action,
}: {
  job: Item;
  runId: number;
  attempt: number;
  read: Reader;
  enabled: boolean;
  unavailableReason: string;
  action: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const outputId = `gh-log-${runId}-${attempt}-${job.id}`;
  return (
    <li className="gh-job">
      <div className="gh-job-head">
        <span className="gh-job-name">{job.name}</span>
        <RunState item={job} />
        <div className="toolbar gh-job-action">
          <button
            className="btn gh-log-toggle"
            disabled={!enabled && !open}
            aria-describedby={!enabled ? `${outputId}-access` : undefined}
            aria-label={`${open ? "Hide" : "View"} logs for ${job.name}`}
            aria-expanded={open}
            aria-controls={open ? outputId : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide logs" : "View logs"}
          </button>
        </div>
      </div>
      {!enabled && (
        <p className="small muted gh-job-access" id={`${outputId}-access`}>
          {unavailableReason}
        </p>
      )}
      {open && enabled && (
        <RunJobLogOutput id={outputId} runId={runId} attempt={attempt} job={job} read={read} />
      )}
      {!!job.steps?.length && (
        <ol className="gh-steps">
          {job.steps.map((step) => (
            <li key={step.number}>
              <span className="gh-step-number">{step.number}</span>
              <span className="gh-step-name">{step.name}</span>
              <RunState item={step} />
            </li>
          ))}
        </ol>
      )}
      <div className="toolbar gh-job-secondary">{action}</div>
    </li>
  );
}

function RunJobLogOutput({
  id,
  runId,
  attempt,
  job,
  read,
}: {
  id: string;
  runId: number;
  attempt: number;
  job: Item;
  read: Reader;
}) {
  const log = useAsync(
    () =>
      read<{ text: string }>("job_log", {
        runId: String(runId),
        attempt: String(attempt),
        jobId: String(job.id),
      }),
    [runId, attempt, job.id],
  );
  return (
    <section className="gh-job-log" id={id} aria-label={`Logs for ${job.name}, attempt ${attempt}`}>
      <div className="gh-job-log-head">
        <h4>Job output</h4>
        <span className="small muted">
          Attempt {attempt} · Job {job.id}
        </span>
      </div>
      <div className="gh-job-log-body">
        {log.loading && <Loading label="Fetching job logs…" />}
        {log.error && (
          <ErrorBox
            error={log.error}
            title={
              log.error instanceof ApiError && log.error.status === 409
                ? "Logs not ready yet"
                : log.error instanceof ApiError && log.error.status === 403
                  ? "Log access denied"
                  : "Job logs unavailable"
            }
            onRetry={log.reload}
          />
        )}
        {log.data &&
          (log.data.text ? (
            <pre className="gh-job-log-output" aria-label={`Job log for ${job.name}`} tabIndex={0}>
              {log.data.text}
            </pre>
          ) : (
            <p className="muted">This job has no log output.</p>
          ))}
      </div>
    </section>
  );
}
