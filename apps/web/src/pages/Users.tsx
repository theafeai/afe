import { useState, type FormEvent } from "react";
import { request } from "../api/client.ts";
import { ErrorBox, Loading, useAsync, useDocumentTitle } from "../components.tsx";
import { useAccess } from "../access.tsx";

type User = { id: string; username: string; disabled: boolean };
const TOOLS = ["github", "vercel", "argocd", "terraform"];
const MODES = ["none", "source", "custom", "source + custom"];
type Policy = { mode: string; custom: { resource: string; action: string }[] };
export function UsersPage() {
  useDocumentTitle("Users");
  const { admin } = useAccess();
  const { data, error, loading, reload } = useAsync(
    (s) => request<{ users: User[] }>("GET", "/api/admin/users", undefined, s),
    [],
  );
  const [username, setUsername] = useState("");
  const [selected, setSelected] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [policies, setPolicies] = useState<Record<string, Policy> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setFailure(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      setBusy(false);
    }
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const r = await request<{ user: User; token: string }>("POST", "/api/admin/users", {
        username,
      });
      setToken(r.token);
      setUsername("");
      reload();
    });
  }
  async function select(u: User) {
    setSelected(u);
    setPolicies(null);
    setToken(null);
    await run(async () => {
      const r = await request<{ tools: Record<string, Policy> }>(
        "GET",
        `/api/admin/users/${u.id}/permissions`,
      );
      setPolicies(r.tools);
      setDrafts(
        Object.fromEntries(
          TOOLS.map((t) => [t, r.tools[t]!.custom.map((g) => g.resource).join("\n")]),
        ),
      );
    });
  }
  if (!admin)
    return (
      <div className="page">
        <h1>Administrator access required</h1>
      </div>
    );
  return (
    <div className="page">
      <h1>Users</h1>
      <p>
        Create a user and share their generated access credential directly. Email is not required.
        New users start with no tool access.
      </p>
      <form className="form card" onSubmit={(e) => void create(e)}>
        <label htmlFor="new-username">Username</label>
        <input
          id="new-username"
          required
          maxLength={100}
          pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy}>
          Create user
        </button>
      </form>
      {token && (
        <section className="callout" role="status">
          <h2>Save this credential now</h2>
          <p>It is shown only once. Resetting it ends the user's existing sessions.</p>
          <textarea aria-label="Generated access credential" readOnly value={token} />
          <button className="btn" onClick={() => setToken(null)}>
            Dismiss credential
          </button>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      {(failure || error) && <ErrorBox error={(failure || error)!} />}
      {loading ? (
        <Loading />
      ) : (
        <ul>
          {data?.users.map((u) => (
            <li key={u.id}>
              <button className="btn" onClick={() => void select(u)} disabled={busy}>
                {u.username}
              </button>{" "}
              {u.disabled ? "Disabled" : "Active"}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <section className="card">
          <h2>{selected.username}</h2>
          <div className="actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await request<{ token: string }>(
                    "POST",
                    `/api/admin/users/${selected.id}/credentials`,
                  );
                  setToken(r.token);
                })
              }
            >
              Reset credential
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await request("PATCH", `/api/admin/users/${selected.id}`, {
                    disabled: !selected.disabled,
                  });
                  setSelected({ ...selected, disabled: !selected.disabled });
                  reload();
                })
              }
            >
              {selected.disabled ? "Enable user" : "Disable user"}
            </button>
          </div>
          <h3>Tool permissions</h3>
          <p>
            Source uses the user's linked tool account. Custom grants add read access to specific
            resources. Source + custom combines both.
          </p>
          <p>
            Enter one resource per line: <code>repository:owner/name</code>,{" "}
            <code>project:project-id</code>, <code>application:app-name</code>, or{" "}
            <code>connection:connection-id</code>. A connection grant includes all events from that
            connection.
          </p>
          {policies &&
            TOOLS.map((tool) => (
              <form
                className="form card"
                key={tool}
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await request("PUT", `/api/admin/users/${selected.id}/permissions/${tool}`, {
                      mode: policies[tool]!.mode,
                      custom: (drafts[tool] ?? "")
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .map((resource) => ({ resource, action: "read" })),
                    });
                    setNotice(`Saved ${tool} permissions.`);
                  });
                }}
              >
                <h4>{tool}</h4>
                <label htmlFor={`mode-${tool}`}>Permission mode</label>
                <select
                  id={`mode-${tool}`}
                  value={policies[tool]!.mode}
                  onChange={(e) =>
                    setPolicies({
                      ...policies,
                      [tool]: { ...policies[tool]!, mode: e.target.value },
                    })
                  }
                >
                  {MODES.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                {["custom", "source + custom"].includes(policies[tool]!.mode) && (
                  <>
                    <label htmlFor={`grants-${tool}`}>Read grants</label>
                    <textarea
                      id={`grants-${tool}`}
                      rows={4}
                      value={drafts[tool] ?? ""}
                      onChange={(e) => setDrafts({ ...drafts, [tool]: e.target.value })}
                    />
                  </>
                )}
                <button className="btn" disabled={busy}>
                  Save {tool} permissions
                </button>
              </form>
            ))}
        </section>
      )}
    </div>
  );
}
