import { GITHUB_OPERATIONS } from "@afe/core/github-operations";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { request } from "../api/client.ts";
import {
  Empty,
  ErrorBox,
  Loading,
  SectionHead,
  toolLabel,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import "./Users.css";
import { useAccess } from "../access.tsx";
import { useToast } from "../toast.tsx";
import { Link } from "../router.tsx";
import { icons, ToolMark } from "../icons.tsx";
import { DeleteUserAction, type UserDeletionProtection } from "./DeleteUserAction.tsx";

type User = {
  id: string;
  username: string;
  disabled: boolean;
  email?: string | null;
  deletionProtection?: UserDeletionProtection;
};
const USER_PAGE_SIZE = 10;
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
  const { data: mail } = useAsync(
    (s) => request<{ enabled: boolean }>("GET", "/api/admin/email", undefined, s),
    [],
  );
  const [email, setEmail] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [invite, setInvite] = useState(false);
  const [username, setUsername] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [requestedPage, setUserPage] = useState(0);
  const [selected, setSelected] = useState<User | null>(null);
  const [token, setToken] = useState<{ value: string; username: string } | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [failureContext, setFailureContext] = useState<string | null>(null);
  const toast = useToast();
  const [actionBusy, setBusy] = useState(false);
  const [permissionsSaving, setPermissionsSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const busy = actionBusy || permissionsSaving || deleting;
  const userList = useRef<HTMLElement>(null);
  const focusUserList = useRef(false);
  const userHeading = useRef<HTMLHeadingElement>(null);
  const selectedId = selected?.id;
  const query = userSearch.trim().toLowerCase();
  const matches = (data?.users ?? []).filter((u) =>
    `${u.username} ${u.email ?? ""}`.toLowerCase().includes(query),
  );
  const pages = Math.max(1, Math.ceil(matches.length / USER_PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  const visibleUsers = matches.slice(page * USER_PAGE_SIZE, (page + 1) * USER_PAGE_SIZE);
  useEffect(() => {
    // Run after the modal's cleanup restores focus to its former trigger.
    if (focusUserList.current && !selectedId) {
      userList.current?.focus();
      focusUserList.current = false;
    } else userHeading.current?.focus();
  }, [selectedId]);
  async function run(action: () => Promise<void>, context?: string) {
    setBusy(true);
    setFailure(null);
    setFailureContext(context ?? null);
    try {
      await action();
    } catch (e) {
      setFailure(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      setBusy(false);
    }
  }
  function runForUser(action: () => Promise<void>) {
    return run(action, selected?.username);
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
      setToken(r.token ? { value: r.token, username: r.user.username } : null);
      if (invite)
        toast({
          message: "Invitation queued.",
          action: { label: "View delivery status", to: "/account/settings" },
        });
      setUsername("");
      setEmail("");
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
    <div className="page users-page">
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
        New users start with no tool access. Invitations are available when email is configured.{" "}
        <Link to="/account/settings">Manage email delivery in Settings</Link>.
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
          <h2>Save the credential for {token.username} now</h2>
          <p>It is shown only once. Resetting it ends the user's existing sessions.</p>
          <textarea aria-label="Generated access credential" readOnly value={token.value} />
          <button className="btn" onClick={() => setToken(null)}>
            Dismiss credential
          </button>
        </section>
      )}
      {failure && (
        <ErrorBox
          error={failure}
          title={failureContext ? `Changes for ${failureContext} were not saved` : undefined}
        />
      )}
      <div className="users-workspace">
        <section
          className="card users-accounts"
          aria-labelledby="users-list-heading"
          ref={userList}
          tabIndex={-1}
        >
          <SectionHead
            id="users-list-heading"
            title="User accounts"
            count={!loading && !error ? data?.users.length : undefined}
            hint="Select a user to manage access and credentials."
          />
          <div className="field users-search">
            <label htmlFor="users-search">Search users</label>
            <input
              id="users-search"
              type="search"
              placeholder="Search by username or email"
              value={userSearch}
              onChange={(event) => {
                setUserSearch(event.target.value);
                setUserPage(0);
              }}
            />
          </div>
          {loading ? (
            <Loading label="Loading users…" />
          ) : error ? (
            <ErrorBox title="Users could not be loaded" error={error} onRetry={reload} />
          ) : !data?.users.length ? (
            <Empty title="No users yet" icon={icons.users}>
              <p>Create a user above to give someone access to Afe.</p>
            </Empty>
          ) : !matches.length ? (
            <Empty title="No matching users">
              <p>Try another username or email.</p>
              <button className="btn btn-sm" onClick={() => setUserSearch("")}>
                Clear user search
              </button>
            </Empty>
          ) : (
            <ul className="entity-list users-list" aria-label="User accounts">
              {visibleUsers.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="users-row"
                    aria-label={u.username}
                    aria-describedby={`user-status-${u.id}${selected?.id === u.id ? ` user-editing-${u.id}` : ""}`}
                    aria-pressed={selected?.id === u.id}
                    aria-controls="user-details"
                    title={`Manage ${u.username}`}
                    onClick={() => select(u)}
                    disabled={busy}
                  >
                    <span className="entity-main">
                      <span className="entity-name">
                        <strong>{u.username}</strong>
                      </span>
                      {u.email && <span className="entity-meta">{u.email}</span>}
                      {selected?.id === u.id && (
                        <span className="entity-meta" id={`user-editing-${u.id}`}>
                          Editing this user
                        </span>
                      )}
                    </span>
                    <span className="badge users-status" id={`user-status-${u.id}`}>
                      {u.disabled ? "Disabled" : "Active"}
                    </span>
                    {selected?.id === u.id ? icons.check : icons.edit}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!loading && !error && !!data?.users.length && (pages > 1 || query) && (
            <div className="users-pager">
              <span className="small muted" role="status">
                {matches.length ? page * USER_PAGE_SIZE + 1 : 0}–
                {Math.min((page + 1) * USER_PAGE_SIZE, matches.length)} of {matches.length} users
                {query ? ` (${data.users.length} total)` : ""}
              </span>
              {pages > 1 && (
                <nav className="button-row" aria-label="User pages">
                  <button
                    className="btn btn-sm"
                    disabled={page === 0}
                    onClick={() => setUserPage(page - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={page === pages - 1}
                    onClick={() => setUserPage(page + 1)}
                  >
                    Next
                  </button>
                </nav>
              )}
            </div>
          )}
        </section>
        <section className="card users-detail" id="user-details" aria-labelledby="user-heading">
          {selected ? (
            <>
              <div className="users-edit-context">
                <div className="users-permission-head">
                  <p className="small muted">Editing user</p>
                  <a className="btn btn-ghost btn-sm" href="#users-list-heading">
                    Change user
                  </a>
                </div>
                <div className="users-edit-identity">
                  <h2 id="user-heading" ref={userHeading} tabIndex={-1}>
                    {selected.username}
                  </h2>
                  <span className="badge">{selected.disabled ? "Disabled" : "Active"}</span>
                </div>
                {selected.email && <p className="small muted">{selected.email}</p>}
              </div>
              <ToolPermissions
                key={selected.id}
                user={selected}
                disabled={busy}
                onSaving={setPermissionsSaving}
              />
              <section className="users-account" aria-labelledby="user-account-heading">
                <h3 id="user-account-heading">Account management</h3>
                <p className="small muted">
                  Credentials and account access for {selected.username}.
                </p>
                <div className="actions">
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void runForUser(async () => {
                        const r = await request<{ token: string }>(
                          "POST",
                          `/api/admin/users/${selected.id}/credentials`,
                        );
                        setToken({ value: r.token, username: selected.username });
                      })
                    }
                  >
                    Reset credential
                  </button>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void runForUser(async () => {
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
                  <DeleteUserAction
                    key={selected.id}
                    user={selected}
                    disabled={busy}
                    onBusy={setDeleting}
                    onDeleted={() => {
                      toast(`Deleted user ${selected.username}.`);
                      focusUserList.current = true;
                      setSelected(null);
                      setToken(null);
                      setFailure(null);
                      reload();
                    }}
                  />
                </div>
                {mail?.enabled && (
                  <form
                    className="form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void runForUser(async () => {
                        await request("PATCH", `/api/admin/users/${selected.id}`, {
                          email: userEmail || null,
                        });
                        setSelected({ ...selected, email: userEmail || null });
                        toast(
                          `Email saved for ${selected.username}. Earlier email links are invalidated.`,
                        );
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
                              void runForUser(async () => {
                                await request("POST", `/api/admin/users/${selected.id}/email`, {
                                  purpose,
                                });
                                toast(
                                  `Email queued for ${selected.username}. Previous links are invalidated.`,
                                );
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
              </section>
            </>
          ) : (
            <>
              <SectionHead id="user-heading" title="User permissions" />
              <Empty title="Select a user" icon={icons.users}>
                <p>Choose an account from the list to edit its tool permissions and credentials.</p>
              </Empty>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ToolPermissions({
  user,
  disabled,
  onSaving,
}: {
  user: User;
  disabled: boolean;
  onSaving: (saving: boolean) => void;
}) {
  const { data, error, loading, reload } = useAsync(
    (signal) =>
      request<{ tools: Record<string, Policy> }>(
        "GET",
        `/api/admin/users/${user.id}/permissions`,
        undefined,
        signal,
      ),
    [user.id],
  );
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [savedPolicies, setSavedPolicies] = useState<Record<string, Policy>>({});
  const tools = Object.keys(data?.tools ?? {});
  const tool = selectedTool && tools.includes(selectedTool) ? selectedTool : tools[0];
  return (
    <section className="users-permissions" aria-labelledby="tool-permissions-title">
      <div>
        <h3 id="tool-permissions-title">Tool permissions</h3>
        <p className="small muted">
          Choose which linked tool accounts {user.username} can use. Each tool saves separately.
          Switching users or tools discards unsaved changes.
        </p>
      </div>
      {loading ? (
        <Loading label={`Loading tool permissions for ${user.username}…`} />
      ) : error ? (
        <ErrorBox
          title={`Tool permissions for ${user.username} could not be loaded`}
          error={error}
          onRetry={reload}
        />
      ) : !tool ? (
        <Empty title="No tools available">
          <p>No tool permissions are available for {user.username}. Try loading them again.</p>
          <button className="btn btn-sm" onClick={reload}>
            Reload tools
          </button>
        </Empty>
      ) : (
        <>
          <ToolPicker
            tools={tools}
            selected={tool}
            disabled={disabled}
            onSelect={setSelectedTool}
          />
          <ToolPermissionEditor
            key={tool}
            user={user}
            tool={tool}
            policy={savedPolicies[tool] ?? data!.tools[tool]!}
            disabled={disabled}
            onSaving={onSaving}
            onSaved={(policy) => setSavedPolicies((saved) => ({ ...saved, [tool]: policy }))}
          />
        </>
      )}
    </section>
  );
}

/** Search popover follows the repository picker pattern (ADR 0015). */
function ToolPicker({
  tools,
  selected,
  disabled,
  onSelect,
}: {
  tools: string[];
  selected: string;
  disabled: boolean;
  onSelect: (tool: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const query = search.trim().toLowerCase();
  const matches = tools.filter((tool) =>
    `${toolLabel(tool)} ${tool}`.toLowerCase().includes(query),
  );
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (event: MouseEvent) => {
      if (!picker.current?.contains(event.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  function close() {
    setOpen(false);
    setSearch("");
    trigger.current?.focus();
  }
  return (
    <div
      className="users-tool-picker"
      ref={picker}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setSearch("");
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        className="btn users-tool-trigger"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="users-tool-menu"
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="muted">Tool</span>
        <ToolMark source={selected} />
        <strong>{toolLabel(selected)}</strong>
        {icons.chevrons}
      </button>
      {open && (
        <div
          className="users-tool-menu"
          id="users-tool-menu"
          role="dialog"
          aria-label="Choose a tool"
        >
          <label className="field">
            <span>Search tools</span>
            <input
              type="search"
              value={search}
              ref={input}
              placeholder="Search by tool name"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <p className="small muted" role="status">
            {matches.length} of {tools.length} tools
          </p>
          {matches.length ? (
            <ul className="entity-list users-tool-options" aria-label="Tool results">
              {matches.map((tool) => (
                <li key={tool}>
                  <button
                    type="button"
                    className="users-row"
                    aria-pressed={tool === selected}
                    disabled={disabled}
                    onClick={() => {
                      onSelect(tool);
                      close();
                    }}
                  >
                    <span>
                      <ToolMark source={tool} /> {toolLabel(tool)}
                    </span>
                    {tool === selected && icons.check}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No matching tools">
              <p>Try another tool name.</p>
            </Empty>
          )}
        </div>
      )}
    </div>
  );
}

function ToolPermissionEditor({
  user,
  tool,
  policy,
  disabled,
  onSaving,
  onSaved,
}: {
  user: User;
  tool: string;
  policy: Policy;
  disabled: boolean;
  onSaving: (saving: boolean) => void;
  onSaved: (policy: Policy) => void;
}) {
  const name = toolLabel(tool);
  const [mode, setMode] = useState(policy.mode);
  const [restrictions, setRestrictions] = useState(
    (policy.denied ?? []).map((g) => `${g.resource} ${g.action}`).join("\n"),
  );
  const [saved, setSaved] = useState({ mode: policy.mode, restrictions });
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const [error, setError] = useState<Error | null>(null);
  const legacy = !Object.hasOwn(MODES, saved.mode);
  const dirty = mode !== saved.mode || restrictions !== saved.restrictions;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (disabled || saving || !dirty || !Object.hasOwn(MODES, mode)) return;
    setSaving(true);
    onSaving(true);
    setError(null);
    try {
      const nextPolicy: Policy = {
        mode,
        ...(tool === "github"
          ? {
              denied: restrictions
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((line) => {
                  const [resource = "", action = ""] = line.split(/\s+/);
                  return { resource, action };
                }),
            }
          : {}),
        custom: [],
      };
      await request("PUT", `/api/admin/users/${user.id}/permissions/${tool}`, nextPolicy);
      onSaved(nextPolicy);
      setSaved({ mode, restrictions });
      toast(`Saved ${name} permissions for ${user.username}.`);
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      setSaving(false);
      onSaving(false);
    }
  }
  return (
    <form
      className="users-permission"
      onSubmit={(e) => void save(e)}
      aria-label={`${name} permissions for ${user.username}`}
      aria-busy={saving}
    >
      <div className="users-permission-head">
        <h4 className={`tool-${tool}`}>
          <ToolMark source={tool} />
          {name}
        </h4>
        <span className="badge">{legacy ? "Review required" : MODES[saved.mode]?.label}</span>
      </div>
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
        <legend className="sr-only">
          {name} permissions for {user.username}
        </legend>
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
            <p className="small muted">
              GitHub checks the linked account’s repository access and operation permissions on
              every request. Restrictions below can narrow that access; they never grant access.
            </p>
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
        <div className="users-permission-save">
          <p className="small muted" id={`permission-context-${tool}`}>
            Applies to <strong>{user.username}</strong>
            {dirty && <span className="users-unsaved">Unsaved changes</span>}
          </p>
          <button
            className="btn btn-sm"
            disabled={!dirty || !Object.hasOwn(MODES, mode)}
            aria-describedby={`permission-context-${tool}`}
          >
            {saving ? `Saving ${name} permissions…` : `Save ${name} permissions`}
          </button>
        </div>
      </fieldset>
      {error && (
        <ErrorBox title={`${name} permissions for ${user.username} were not saved`} error={error} />
      )}
    </form>
  );
}
