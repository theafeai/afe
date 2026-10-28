import { useState, useRef, type FormEvent } from "react";
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
import { Link, useLocation } from "../router.tsx";
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
    <span>
      <button
        className={c.destructive ? "btn btn-danger" : "btn"}
        disabled={!c.enabled}
        title={c.reason ?? undefined}
        onClick={() => void prepare(action, params)}
      >
        {label ?? c.label}
      </button>
      {!c.enabled && <small className="muted"> {c.reason}</small>}
    </span>
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
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>GitHub Actions</h1>
          <p className="lede">
            Inspect workflows, jobs and deployments, and operate them from Afe.
          </p>
        </div>
        <Link to="/profile">Link or update your GitHub account</Link>
      </header>
      {resources.loading && <Loading label="Loading GitHub repositories…" />}
      {resources.error && <ErrorBox error={resources.error} onRetry={resources.reload} />}
      {resources.data && (
        <section className="card">
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
              {selected &&
                !resources.data.items.some(
                  (r) =>
                    r.connectionId === selected.connectionId &&
                    r.repository === selected.repository,
                ) && (
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
          <div className="actions">
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
          {!resources.data.items.length && (
            <Empty title="No repositories on this page">
              <p>
                Only connected repositories available to your GitHub identity and Afe policy appear.
                Try the next page or update your account in Profile.
              </p>
            </Empty>
          )}
        </section>
      )}
      {selected && (
        <GitHubWorkspace key={`${selected.connectionId}|${selected.repository}`} scope={selected} />
      )}
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
  const refresh = () => setRevision((r) => r + 1);
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
  return (
    <div aria-busy={busy}>
      <section className="card">
        <div className="toolbar">
          <strong>{scope.repository}</strong>
          <button className="btn" disabled={busy} onClick={refresh}>
            Refresh GitHub state
          </button>
        </div>
        <p className="muted">
          Afe action grants and your current GitHub permissions both apply. Source events show
          completion after a request is accepted.
        </p>
        <div className="actions" role="group" aria-label="GitHub views">
          {tabs.map(([value, label]) => (
            <button
              className="btn"
              key={value}
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value);
                setPage(1);
                setSelected(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      {(error || caps.error) && <ErrorBox error={(error ?? caps.error)!} />}
      {receipt && (
        <section className="callout" role="status">
          <strong>{receipt.state}</strong>
          <p>{receipt.message}</p>
          <p>
            Request <code>{receipt.requestId}</code>
            {receipt.result?.id ? ` · Source ID ${receipt.result.id}` : ""}
          </p>
          <button
            className="btn"
            onClick={() => {
              setTab("history");
              setSelected(null);
            }}
          >
            Inspect request history
          </button>
        </section>
      )}
      {pending && (
        <section className="card" role="group" aria-label="Confirm GitHub operation">
          <h2>Confirm operation</h2>
          <p>{pending.preview.summary}</p>
          <p>
            This may trigger a deployment or change source configuration. If another tool changes
            this resource, Afe will ask you to refresh.
          </p>
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
          </button>{" "}
          <button className="btn" disabled={busy} onClick={() => setPending(null)}>
            Go back
          </button>
        </section>
      )}
      {recovery && (
        <section className="card">
          <h2>Recover uncertain request</h2>
          <p>
            Inspect the source state in the Runs, Workflows or Deployments tabs first. The original
            request might have succeeded; another submission could create a duplicate deployment.
          </p>
          <label className="check">
            <input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} />I
            checked the current source state and accept the risk of a duplicate operation.
          </label>
          <button
            className="btn btn-danger"
            disabled={!risk || busy}
            onClick={() => void release()}
          >
            Allow a new deliberate request
          </button>{" "}
          <button className="btn" onClick={() => setRecovery(null)}>
            Go back
          </button>
        </section>
      )}
      {list.loading && <Loading label="Loading GitHub state…" />}
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.data && (
        <section className="card">
          <h2>{tabs.find((t) => t[0] === tab)?.[1]}</h2>
          {!list.data.items.length && (
            <Empty title="No items on this page">
              <p>Refresh after source changes, select another repository, or check another page.</p>
            </Empty>
          )}
          {tab === "history" ? (
            <ul className="plain">
              {(list.data.items as unknown as GitHubOperationReceipt[]).map((r) => (
                <li key={r.requestId}>
                  <p>
                    <strong>
                      {r.action} · {r.state}
                    </strong>{" "}
                    · <code>{r.requestId}</code>
                  </p>
                  <p>{r.message}</p>
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
                </li>
              ))}
            </ul>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name / ID</th>
                    <th>State</th>
                    <th>Context</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.name ?? item.key ?? item.id}
                        <div className="muted">{item.id}</div>
                      </td>
                      <td>
                        {item.status ?? item.state ?? (item.expired ? "Expired" : "Available")}
                        {item.conclusion ? ` · ${item.conclusion}` : ""}
                      </td>
                      <td>
                        {typeof item.environment === "string"
                          ? item.environment
                          : (item.ref ??
                            item.head_branch ??
                            item.path ??
                            (item.run_id ? `Run ${item.run_id}` : ""))}
                      </td>
                      <td>
                        <button className="btn btn-ghost" onClick={() => setSelected(item)}>
                          Open details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="actions">
            <button
              className="btn"
              disabled={page === 1}
              onClick={() => {
                setPage((p) => p - 1);
                setSelected(null);
              }}
            >
              Previous page
            </button>
            <button
              className="btn"
              disabled={!list.data.hasMore}
              onClick={() => {
                setPage((p) => p + 1);
                setSelected(null);
              }}
            >
              Next page
            </button>
          </div>
        </section>
      )}
      {tab === "workflows" && selected && (
        <WorkflowPanel
          key={selected.id}
          item={selected}
          read={read}
          prepare={prepare}
          button={button}
          can={can}
        />
      )}
      {tab === "workflows" && can("github.workflow_save") && (
        <details className="card">
          <summary>Create workflow</summary>
          <WorkflowEditor key="new-workflow" prepare={prepare} canSave={true} canDelete={false} />
        </details>
      )}
      {tab === "runs" && selected && (
        <RunPanel
          key={`${selected.id}:${revision}`}
          item={selected}
          read={read}
          button={button}
          can={can}
          download={(kind, id, attempt) =>
            `${root}/download?${new URLSearchParams({ connectionId: scope.connectionId, kind, id: String(id), ...(attempt ? { attempt: String(attempt) } : {}) })}`
          }
        />
      )}
      {tab === "deployments" && (
        <DeploymentPanel
          key={`${selected?.id ?? "new"}:${revision}`}
          item={selected}
          read={read}
          prepare={prepare}
          button={button}
          can={can}
        />
      )}
      {tab === "environments" && (
        <EnvironmentPanel
          key={`${selected?.id ?? "new"}:${revision}`}
          item={selected}
          read={read}
          prepare={prepare}
          button={button}
          can={can}
        />
      )}
      {tab === "artifacts" && selected && (
        <section className="card">
          <h2>{selected.name ?? "Artifact"}</h2>
          <KeyValue
            items={[
              ["Source ID", String(selected.id)],
              ["Size", `${selected.size_in_bytes ?? 0} bytes`],
              ["Expired", selected.expired ? "Yes" : "No"],
              ["Workflow run", String(selected.run_id ?? "Unknown")],
            ]}
          />
          <div className="actions">
            {can("github.artifact_download") && !selected.expired && (
              <a
                className="btn"
                href={`${root}/download?${new URLSearchParams({ connectionId: scope.connectionId, kind: "artifact", id: String(selected.id) })}`}
              >
                Download artifact
              </a>
            )}
            {button("github.artifact_delete", { artifactId: selected.id })}
          </div>
        </section>
      )}
      {tab === "caches" && selected && (
        <section className="card">
          <h2>{selected.key ?? "Cache"}</h2>
          <p>
            {selected.ref} · {selected.size_in_bytes ?? 0} bytes
          </p>
          {button("github.cache_delete", {
            cacheId: selected.id,
            key: selected.key,
            ref: selected.ref,
          })}
        </section>
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
    <section className="card">
      <h2>{item.name ?? "Workflow"}</h2>
      <p>
        {item.path} · {item.state}
      </p>
      <form
        className="form"
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
        {refs.error && <ErrorBox error={refs.error} />}
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={refPage === 1}
            onClick={() => setRefPage((p) => p - 1)}
          >
            Previous refs
          </button>
          <button
            type="button"
            className="btn"
            disabled={!refs.data?.hasMore}
            onClick={() => setRefPage((p) => p + 1)}
          >
            More refs
          </button>
        </div>
        <button className="btn">Load ref and inputs</button>
      </form>
      {file.loading && <Loading />}
      {file.error && <ErrorBox error={file.error} onRetry={file.reload} />}
      {file.data && (
        <>
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
            <h3>Dispatch workflow</h3>
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
            <button
              className="btn btn-primary"
              disabled={!can("github.dispatch") || !file.data.dispatchable}
            >
              Prepare dispatch
            </button>
            {!file.data.dispatchable && <p>This ref does not declare workflow_dispatch.</p>}
          </form>
          {file.data.content !== undefined && (
            <details>
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
        </>
      )}
      <div className="actions">
        {button("github.enable", { workflowId: item.id })}
        {button("github.disable", { workflowId: item.id })}
      </div>
    </section>
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
  file?: { path: string; sha: string; content: string; branch: string };
}) {
  const [path, setPath] = useState(file?.path ?? ".github/workflows/deploy.yml"),
    [branch, setBranch] = useState(file?.branch ?? "main"),
    [content, setContent] = useState(
      file?.content ??
        'name: Deploy\non: workflow_dispatch\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "Add your deployment steps"\n',
    ),
    [message, setMessage] = useState("Update workflow from Afe");
  return (
    <section className="card">
      <h3>{file ? "Edit workflow file" : "Create workflow file"}</h3>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void prepare("github.workflow_save", {
            path,
            branch,
            content,
            message,
            ...(file ? { sha: file.sha } : {}),
          });
        }}
      >
        <Field label="Workflow file path">
          <input
            value={path}
            readOnly={!!file}
            onChange={(e) => setPath(e.target.value)}
            required
          />
        </Field>
        <Field label="Target branch">
          <input
            value={branch}
            readOnly={!!file}
            onChange={(e) => setBranch(e.target.value)}
            required
          />
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
        {file && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={!canDelete}
            onClick={() =>
              void prepare("github.workflow_delete", { path, branch, message, sha: file.sha })
            }
          >
            Prepare workflow deletion
          </button>
        )}
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
  const params = { runId: item.id, attempt: current.run_attempt ?? 1 };
  return (
    <section className="card">
      <h2>Run {item.id}</h2>
      {run.error && <ErrorBox error={run.error} />}
      <p>
        Current attempt {current.run_attempt} · {current.status} · {current.conclusion}
      </p>
      {current.html_url && (
        <a href={current.html_url} target="_blank" rel="noreferrer">
          Open source run
        </a>
      )}
      <label className="check">
        <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
        Enable debug logging for the next re-run
      </label>
      <div className="actions">
        {button("github.cancel", params)}
        {button("github.force_cancel", params)}
        {button("github.rerun", { ...params, enableDebugLogging: debug })}
        {button("github.rerun_failed", { ...params, enableDebugLogging: debug })}
        {button("github.approve_run", params)}
      </div>
      <Field label="Inspect log/job attempt">
        <input
          type="number"
          min={1}
          max={current.run_attempt ?? 1}
          value={attempt}
          onChange={(e) => {
            setAttempt(Number(e.target.value));
            setJobPage(1);
          }}
        />
      </Field>
      <p className="muted">
        Attempts remain separate. These archives are completed output; full live source capture is
        being developed separately.
      </p>
      {archives.data?.items.find((c) => c.action === "github.logs_download")?.enabled && (
        <a className="btn" href={download("logs", item.id, attempt)}>
          Download this attempt's archived logs
        </a>
      )}
      <h3>Jobs and steps</h3>
      {jobs.loading && <Loading />}
      {jobs.error && <ErrorBox error={jobs.error} onRetry={jobs.reload} />}
      {jobs.data && !jobs.data.items.length && <Empty title="No jobs available" />}
      {jobs.data?.items.map((job) => (
        <section className="card" key={job.id}>
          <h4>
            {job.name} · {job.status} · {job.conclusion}
          </h4>
          <ol>
            {job.steps?.map((step) => (
              <li key={step.number}>
                {step.name} · {step.status} · {step.conclusion}
              </li>
            ))}
          </ol>
          {button("github.rerun_job", { ...params, jobId: job.id, enableDebugLogging: debug })}
        </section>
      ))}
      <div className="actions">
        <button className="btn" disabled={jobPage === 1} onClick={() => setJobPage((p) => p - 1)}>
          Previous jobs
        </button>
        <button
          className="btn"
          disabled={!jobs.data?.hasMore}
          onClick={() => setJobPage((p) => p + 1)}
        >
          More jobs
        </button>
      </div>
      <h3>Pending deployment reviews</h3>
      {pending.loading && <Loading />}
      {pending.error && <ErrorBox error={pending.error} />}
      {pending.data && !pending.data.items.length && <p>No environments are awaiting review.</p>}
      {pending.data?.items.map((p) => {
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
                  e.target.checked ? [...envIds, env.id] : envIds.filter((x) => x !== env.id),
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
      <Field label="Deployment review comment">
        <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
      </Field>
      <div className="actions">
        {envIds.length > 0 && comment.trim() && (
          <>
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
          </>
        )}
      </div>
      <h3>Cleanup</h3>
      <div className="actions">
        {button("github.delete_logs", params)}
        {button("github.delete_run", params)}
      </div>
    </section>
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
    <section className="card">
      <h2>{item ? `Deployment ${item.id}` : "Create deployment"}</h2>
      {item ? (
        <>
          <KeyValue
            items={[
              ["Ref", item.ref],
              ["Environment", typeof item.environment === "string" ? item.environment : null],
              ["SHA", item.sha],
            ]}
          />
          {statuses.error && <ErrorBox error={statuses.error} />}
          <ul>
            {statuses.data?.items.map((s) => (
              <li key={s.id}>
                {s.state} · {s.description}
              </li>
            ))}
          </ul>
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
          {button("github.deployment_delete", { deploymentId: item.id })}
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
    </section>
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
    <section className="card">
      <h2>{item ? `Environment ${item.name}` : "Create environment"}</h2>
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
          <ul>
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
          <ul>
            {customRules.data?.items.map((rule) => (
              <li key={rule.id}>
                {rule.name}
                {button("github.protection_rule_delete", { environment: name, ruleId: rule.id })}
              </li>
            ))}
          </ul>
          {ruleApps.error && <ErrorBox error={ruleApps.error} />}
          <ul>
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
          {button("github.environment_delete", { environment: name })}
        </>
      )}
    </section>
  );
}
