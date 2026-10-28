import { useState, type FormEvent } from "react";
import { request } from "../api/client.ts";
import { ErrorBox, Loading, useAsync, useDocumentTitle } from "../components.tsx";
import { useAccess } from "../access.tsx";

type User = { id: string; username: string; disabled: boolean; email?: string | null };
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
  const { data: mail, reload: reloadMail } = useAsync(
    (s) =>
      request<{
        enabled: boolean;
        configured: boolean;
        from: string | null;
        deliveries: { id: string; state: string; attempts: number }[];
      }>("GET", "/api/admin/email", undefined, s),
    [],
  );
  const [email, setEmail] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [invite, setInvite] = useState(false);
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
      const r = await request<{ user: User; token?: string }>(
        "POST",
        invite ? "/api/admin/users/invite" : "/api/admin/users",
        {
          ...(invite ? { email } : {}),
          username,
        },
      );
      setToken(r.token ?? null);
      if (invite) setNotice("Invitation queued. Delivery status appears below.");
      setUsername("");
      setEmail("");
      reloadMail();
      reload();
    });
  }
  async function select(u: User) {
    setSelected(u);
    setUserEmail(u.email ?? "");
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
          TOOLS.map((t) => [
            t,
            r.tools[t]!.custom.map((g) =>
              g.action === "read" ? g.resource : `${g.resource} ${g.action}`,
            ).join("\n"),
          ]),
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
        New users start with no tool access. Invitations are available when email is configured.
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
        {mail?.enabled && (
          <>
            <label>
              <input
                type="checkbox"
                checked={invite}
                onChange={(e) => setInvite(e.target.checked)}
              />{" "}
              Send an invitation by email
            </label>
            {invite && (
              <>
                <label htmlFor="invite-email">Email address</label>
                <input
                  id="invite-email"
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </>
            )}
          </>
        )}
        <button className="btn btn-primary" disabled={busy}>
          {invite ? "Invite user" : "Create user"}
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
      <section className="card">
        <h2>Email delivery</h2>
        {mail?.configured ? (
          <>
            <p>Sender: {mail.from}</p>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await request("POST", "/api/admin/email/test", { email: testEmail });
                  setNotice("Test email queued.");
                  reloadMail();
                });
              }}
            >
              <label htmlFor="test-email">Test recipient</label>
              <input
                id="test-email"
                type="email"
                required
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
              />
              <button className="btn" disabled={busy}>
                Send test email
              </button>
            </form>
            <button className="btn" onClick={reloadMail}>
              Refresh delivery status
            </button>
            <ul>
              {mail.deliveries.map((d) => (
                <li key={d.id}>
                  {d.state} — {d.attempts} attempt(s)
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            Email is disabled. An operator can configure SMTP to enable invitations and reset links.
          </p>
        )}
      </section>
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
          {mail?.enabled && (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await request("PATCH", `/api/admin/users/${selected.id}`, {
                    email: userEmail || null,
                  });
                  setSelected({ ...selected, email: userEmail || null });
                  setNotice("Email saved. Earlier email links are invalidated.");
                  reload();
                });
              }}
            >
              <label htmlFor="user-email">Email address</label>
              <input
                id="user-email"
                type="email"
                maxLength={254}
                value={userEmail}
                onChange={(e) => setUserEmail(e.target.value)}
              />
              <button className="btn" disabled={busy}>
                Save email
              </button>
              {selected.email && (
                <div className="actions">
                  {(["invitation", "reset"] as const).map((purpose) => (
                    <button
                      key={purpose}
                      type="button"
                      className="btn"
                      disabled={busy || selected.disabled}
                      onClick={() =>
                        void run(async () => {
                          await request("POST", `/api/admin/users/${selected.id}/email`, {
                            purpose,
                          });
                          setNotice("Email queued. Previous links are invalidated.");
                          reloadMail();
                        })
                      }
                    >
                      {purpose === "invitation" ? "Resend invitation" : "Email reset link"}
                    </button>
                  ))}
                </div>
              )}
            </form>
          )}
          <h3>Tool permissions</h3>
          <p>
            Source uses the user's linked tool account. Custom grants add read access to specific
            resources. Source + custom combines both. GitHub run controls require an explicit
            repository action grant plus the user’s GitHub write access.
          </p>
          <p>
            Enter one resource per line: <code>repository:owner/name</code>,{" "}
            <code>project:project-id</code>, <code>application:app-name</code>, or{" "}
            <code>connection:connection-id</code>. A connection grant includes all events from that
            connection.
          </p>
          <p>
            For GitHub run controls, append <code>github.cancel</code>, <code>github.rerun</code>,
            or <code>github.rerun_failed</code> after a lowercase repository resource, for example{" "}
            <code>repository:owner/name github.cancel</code>. Each grant goes on its own line.
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
                        .map((line) => {
                          const [resource, action = "read"] = line.split(/\s+/);
                          return { resource, action };
                        }),
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
                    <label htmlFor={`grants-${tool}`}>Resource grants</label>
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
