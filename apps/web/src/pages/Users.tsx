import { GITHUB_OPERATIONS } from "@afe/core/github-operations";
import { useState, type FormEvent } from "react";
import { request } from "../api/client.ts";
import {
  Empty,
  ErrorBox,
  Loading,
  SectionHead,
  ToolBadge,
  toolLabel,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import "./Users.css";
import { useAccess } from "../access.tsx";
import { useToast } from "../toast.tsx";
import { icons } from "../icons.tsx";

type User = { id: string; username: string; disabled: boolean; email?: string | null };
const TOOLS = ["github", "vercel", "argocd", "terraform"];
const MODES: Record<string, { label: string; help: string }> = {
  none: {
    label: "No access",
    help: "This tool is unavailable to the user.",
  },
  source: {
    label: "Linked tool account",
    help: "Read access follows the user’s linked tool account.",
  },
};
type Policy = {
  mode: string;
  custom: { resource: string; action: string }[];
  denied?: { resource: string; action: string }[];
};
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
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
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
      if (invite) toast("Invitation queued. Delivery status appears below.");
      setUsername("");
      setEmail("");
      reloadMail();
      reload();
    });
  }
  function select(u: User) {
    setSelected(u);
    setUserEmail(u.email ?? "");
    setToken(null);
    setFailure(null);
  }
  if (!admin)
    return (
      <div className="page">
        <h1>Administrator access required</h1>
      </div>
    );
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Users</h1>
          <p className="lede">Manage user access, credentials and linked tool permissions.</p>
        </div>
      </header>
      <p>
        Open source inherits source permissions. Afe-managed custom permissions are planned for Afe
        Cloud only.
      </p>
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
      {failure && <ErrorBox error={failure} />}
      <section className="card" aria-labelledby="users-list-heading">
        <SectionHead
          id="users-list-heading"
          title="User accounts"
          count={!loading && !error ? data?.users.length : undefined}
          hint="Select a user to manage access and credentials."
        />
        {loading ? (
          <Loading label="Loading users…" />
        ) : error ? (
          <ErrorBox title="Users could not be loaded" error={error} onRetry={reload} />
        ) : !data?.users.length ? (
          <Empty title="No users yet" icon={icons.users}>
            <p>Create a user above to give someone access to Afe.</p>
          </Empty>
        ) : (
          <ul className="entity-list users-list" aria-label="User accounts">
            {data.users.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="users-row"
                  aria-label={u.username}
                  aria-describedby={`user-status-${u.id}`}
                  aria-pressed={selected?.id === u.id}
                  aria-controls={selected ? "user-details" : undefined}
                  title={`Manage ${u.username}`}
                  onClick={() => select(u)}
                  disabled={busy}
                >
                  <span className="entity-main">
                    <span className="entity-name">
                      <strong>{u.username}</strong>
                    </span>
                    {u.email && <span className="entity-meta">{u.email}</span>}
                  </span>
                  <span className="badge users-status" id={`user-status-${u.id}`}>
                    {u.disabled ? "Disabled" : "Active"}
                  </span>
                  {icons.edit}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selected && (
        <section className="card users-detail" id="user-details" aria-labelledby="user-heading">
          <h2 id="user-heading">{selected.username}</h2>
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
                  toast("Email saved. Earlier email links are invalidated.");
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
                          toast("Email queued. Previous links are invalidated.");
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
          <ToolPermissions key={selected.id} userId={selected.id} disabled={busy} />
        </section>
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
                  toast("Test email queued.");
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
    </div>
  );
}

function ToolPermissions({ userId, disabled }: { userId: string; disabled: boolean }) {
  const { data, error, loading, reload } = useAsync(
    (signal) =>
      request<{ tools: Record<string, Policy> }>(
        "GET",
        `/api/admin/users/${userId}/permissions`,
        undefined,
        signal,
      ),
    [userId],
  );
  return (
    <section className="users-permissions" aria-labelledby="tool-permissions-title">
      <div>
        <h3 id="tool-permissions-title">Tool permissions</h3>
        <p className="muted">
          Choose how this account can access each tool. Save changes separately for each tool.
        </p>
      </div>
      {loading ? (
        <Loading label="Loading tool permissions…" />
      ) : error ? (
        <ErrorBox title="Tool permissions could not be loaded" error={error} onRetry={reload} />
      ) : (
        data &&
        TOOLS.map((tool) => (
          <ToolPermissionEditor
            key={tool}
            userId={userId}
            tool={tool}
            policy={data.tools[tool]!}
            disabled={disabled}
          />
        ))
      )}
    </section>
  );
}

function ToolPermissionEditor({
  userId,
  tool,
  policy,
  disabled,
}: {
  userId: string;
  tool: string;
  policy: Policy;
  disabled: boolean;
}) {
  const name = toolLabel(tool);
  const [mode, setMode] = useState(policy.mode);
  const [reviewed, setReviewed] = useState(false);
  const [restrictions, setRestrictions] = useState(
    (policy.denied ?? []).map((g) => `${g.resource} ${g.action}`).join("\n"),
  );
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const [error, setError] = useState<Error | null>(null);
  const legacy = !Object.hasOwn(MODES, policy.mode) && !reviewed;
  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await request("PUT", `/api/admin/users/${userId}/permissions/${tool}`, {
        mode,
        ...(tool === "github"
          ? {
              denied: restrictions
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((line) => {
                  const [resource, action = ""] = line.split(/\s+/);
                  return { resource, action };
                }),
            }
          : {}),
        custom: [],
      });
      setReviewed(true);
      toast(`Saved ${name} permissions.`);
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="users-permission"
      onSubmit={(e) => void save(e)}
      aria-label={`${name} permissions`}
    >
      <h4>
        <ToolBadge source={tool} />
      </h4>
      {legacy && (
        <div className="callout callout-error" role="alert">
          Existing {policy.mode} policy is blocked in open source. Review the linked account’s
          permissions before explicitly choosing inherited access, which may grant different or
          broader access. Choose No access to keep this tool disabled. Custom permissions are
          planned for Afe Cloud only.
        </div>
      )}
      {legacy && (
        <details>
          <summary>Stored grants (inactive)</summary>
          {policy.custom.length ? (
            <ul className="plain">
              {policy.custom.map((grant, index) => (
                <li key={index}>
                  <code>
                    {grant.resource} {grant.action}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No stored grants.</p>
          )}
        </details>
      )}
      <fieldset className="form users-permission-fields" disabled={disabled || saving}>
        <legend className="sr-only">{name} permissions</legend>
        <div className="field">
          <label htmlFor={`mode-${tool}`}>Permission mode</label>
          <select
            id={`mode-${tool}`}
            value={mode}
            aria-describedby={`mode-help-${tool}`}
            onChange={(e) => {
              setMode(e.target.value);
            }}
          >
            {legacy && (
              <option value={policy.mode} disabled>
                Blocked legacy policy — review required
              </option>
            )}
            {Object.entries(MODES).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className="small muted" id={`mode-help-${tool}`}>
            {tool === "github" && mode === "source"
              ? "Read access and supported GitHub operations follow the user’s linked account, except restricted actions."
              : MODES[mode]?.help}
          </p>
        </div>
        {tool === "github" && (
          <>
            <div className="callout small">
              Source inherits supported operations from the linked GitHub account. GitHub checks
              current repository access and operation permissions on every request. Deny-only
              restrictions below can narrow access; they never grant access.
            </div>
            <div className="field">
              <label htmlFor="github-restrictions">GitHub action restrictions (optional)</label>
              <textarea
                id="github-restrictions"
                aria-label="GitHub action restrictions"
                rows={4}
                value={restrictions}
                spellCheck={false}
                autoCapitalize="none"
                aria-describedby="github-restrictions-help"
                placeholder="repository:owner/name github.delete_run"
                onChange={(e) => {
                  setRestrictions(e.target.value);
                }}
              />
              <p className="small muted" id="github-restrictions-help">
                Block one repository/action per line, for example{" "}
                <code>repository:owner/name github.delete_run</code>. Leave empty to apply no
                additional action restrictions. Restrictions override inherited access.
              </p>
            </div>
            <details>
              <summary>Supported GitHub operations</summary>
              <ul className="users-permission-catalog">
                {GITHUB_OPERATIONS.map(([action, label, , , level]) => (
                  <li key={action}>
                    <code>{action}</code> — {label} (GitHub {level})
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        <div className="button-row">
          <button className="btn" disabled={!Object.hasOwn(MODES, mode)}>
            {saving ? `Saving ${name} permissions…` : `Save ${name} permissions`}
          </button>
        </div>
      </fieldset>
      {error && <ErrorBox title={`${name} permissions were not saved`} error={error} />}
    </form>
  );
}
