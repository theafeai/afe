import { useId, useState } from "react";
import { request } from "../api/client.ts";
import {
  ErrorBox,
  KeyValue,
  Loading,
  toolLabel,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import type { ProfileInfo, ProfileTool } from "../access.tsx";
import { Link } from "../router.tsx";
import { useToast } from "../toast.tsx";

const MODE_LABEL: Record<string, string> = {
  none: "No access",
  source: "Your tool permissions",
  custom: "Custom grants",
  "source + custom": "Your tool permissions + custom grants",
};

type Busy = "signin" | "link" | "disconnect" | null;
const FAILED: Record<Exclude<Busy, null>, string> = {
  signin: "Sign-in did not start",
  link: "Account not linked",
  disconnect: "Account not disconnected",
};

function ToolAccount({ tool, reload }: { tool: ProfileTool; reload: () => void }) {
  const id = useId();
  const name = toolLabel(tool.tool);
  const [token, setToken] = useState("");
  const [workflowAccess, setWorkflowAccess] = useState(false);
  const [context, setContext] = useState("");
  const [oidcConnection, setOidcConnection] = useState(tool.oidcConnections?.[0]?.id ?? "");
  const [error, setError] = useState<{ title: string; error: Error } | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState<Busy>(null);
  async function run(kind: Exclude<Busy, null>, action: () => Promise<string | void>) {
    setBusy(kind);
    setError(null);
    try {
      const done = await action();
      if (done) toast(done);
    } catch (e) {
      setError({
        title: FAILED[kind],
        error: e instanceof Error ? e : new Error("Request failed"),
      });
    } finally {
      setBusy(null);
    }
  }
  const tokenForm = ["github", "vercel", "argocd"].includes(tool.tool);
  const disconnect = tool.linked && (
    <button
      type="button"
      className="btn btn-danger"
      disabled={busy !== null}
      onClick={() =>
        void run("disconnect", async () => {
          await request("DELETE", `/api/profile/tools/${tool.tool}`);
          reload();
          return `${name} account disconnected.`;
        })
      }
    >
      {busy === "disconnect" ? "Disconnecting…" : "Disconnect account"}
    </button>
  );
  const ready = tool.sourceEnabled && tool.sourceAvailable !== false;
  return (
    <section className="card tool-account" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{name}</h2>
      <KeyValue
        items={[
          ["Permission mode", MODE_LABEL[tool.mode] ?? tool.mode],
          ["Linked account", tool.linked ? `Linked as ${tool.accountName}` : "No account linked"],
        ]}
      />
      {tool.sourceEnabled && tool.sourceAvailable === false && (
        <p className="muted">
          This tool has no personal sign-in. Ask your administrator for custom resource access.
        </p>
      )}
      {ready && tool.oauthAvailable && (
        <>
          <h3>Sign in with {name}</h3>
          <div className="form">
            {tool.tool === "argocd" && (
              <div className="field">
                <label htmlFor={`${id}-sso-connection`}>ArgoCD connection</label>
                <select
                  id={`${id}-sso-connection`}
                  value={oidcConnection}
                  onChange={(e) => setOidcConnection(e.target.value)}
                  aria-describedby={`${id}-sso-help`}
                >
                  {tool.oidcConnections?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <small id={`${id}-sso-help`} className="muted">
                  Signing in replaces your current ArgoCD account link.
                </small>
              </div>
            )}
            {tool.tool === "github" && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={workflowAccess}
                  onChange={(e) => setWorkflowAccess(e.target.checked)}
                />
                Allow editing workflow files (adds the GitHub workflow scope)
              </label>
            )}
            <div className="button-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={() =>
                  void run("signin", async () => {
                    const r = await request<{ url: string }>(
                      "POST",
                      `/api/profile/tools/${tool.tool}/login`,
                      tool.tool === "argocd"
                        ? { connectionId: oidcConnection }
                        : tool.tool === "github"
                          ? { workflowAccess }
                          : undefined,
                    );
                    window.location.assign(r.url);
                  })
                }
              >
                {busy === "signin" ? "Redirecting…" : `Sign in with ${name}`}
              </button>
            </div>
          </div>
        </>
      )}
      {ready && tokenForm && (
        <>
          <h3>
            {tool.oauthAvailable ? "Or link with an access token" : "Link with an access token"}
          </h3>
          <p className="muted small">
            {tool.tool === "github" && !tool.oauthAvailable
              ? "OAuth sign-in is not configured. Link a fine-grained GitHub token, or ask your administrator to configure OAuth sign-in. "
              : ""}
            Afe acts with your own {name} permissions; Afe grants still apply.
          </p>
          <form
            className="form"
            aria-busy={busy === "link"}
            onSubmit={(e) => {
              e.preventDefault();
              void run("link", async () => {
                await request("POST", `/api/profile/tools/${tool.tool}/token`, {
                  token,
                  ...(tool.tool === "argocd"
                    ? { connectionId: context }
                    : context
                      ? { teamId: context }
                      : {}),
                });
                setToken("");
                reload();
                return `${name} account linked.`;
              });
            }}
          >
            <div className="field">
              <label htmlFor={`${id}-token`}>
                {tool.tool === "github" ? "Personal access token" : "Access token"}
              </label>
              <input
                id={`${id}-token`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
                aria-describedby={tool.tool === "github" ? `${id}-token-help` : undefined}
              />
              {tool.tool === "github" && (
                <small id={`${id}-token-help`} className="muted">
                  Use a fine-grained token limited to the repositories you work on, with Actions
                  read and write, plus only the Contents, Workflows, Deployments or Environments
                  permissions you need.
                </small>
              )}
            </div>
            {tool.tool !== "github" && (
              <div className="field">
                <label htmlFor={`${id}-context`}>
                  {tool.tool === "argocd" ? "Connection ID" : "Team ID (optional)"}
                </label>
                <input
                  id={`${id}-context`}
                  required={tool.tool === "argocd"}
                  spellCheck={false}
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  aria-describedby={`${id}-context-help`}
                />
                <small id={`${id}-context-help`} className="muted">
                  {tool.tool === "argocd"
                    ? "Ask your administrator for the ID of the ArgoCD connection."
                    : "Leave empty for a personal Vercel account."}
                </small>
              </div>
            )}
            <div className="button-row">
              <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                {busy === "link"
                  ? "Linking…"
                  : tool.linked
                    ? "Replace linked account"
                    : "Link account"}
              </button>
              {disconnect}
            </div>
          </form>
        </>
      )}
      {error && <ErrorBox error={error.error} title={error.title} />}
      {tool.linked && !(ready && tokenForm) && <div className="button-row">{disconnect}</div>}
    </section>
  );
}
export function ProfilePage() {
  useDocumentTitle("Profile");
  const { data, error, loading, reload } = useAsync(
    (s) => request<ProfileInfo>("GET", "/api/profile", undefined, s),
    [],
  );
  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Profile</h1>
          <p className="lede">
            Link your own tool accounts so Afe can act with your permissions. They are separate from
            your Afe login.
          </p>
        </div>
      </div>
      {data?.administratorGitHub && (
        <section className="callout" role="note">
          <p>
            Link GitHub below using this administrator login. Anyone sharing the same Afe
            administrator credential shares this GitHub link. Linking enables repository discovery;
            operations also require explicit repository/action grants.
          </p>
          {data.administratorGitHub.username && (
            <p>
              To assign grants, select <code>{data.administratorGitHub.username}</code> in{" "}
              <Link to="/users">Users</Link>. Use source + custom to keep repository discovery and
              add operation grants.
            </p>
          )}
        </section>
      )}
      {error && <ErrorBox error={error} />}
      {loading ? (
        <Loading />
      ) : data?.tools.length ? (
        data.tools.map((t) => <ToolAccount key={t.tool} tool={t} reload={reload} />)
      ) : data?.administratorGitHub ? (
        <p>GitHub access is disabled for this identity. Update its permissions in Users.</p>
      ) : data && !data.managedUser ? (
        <p>Ask your administrator to create a named user and assign GitHub access.</p>
      ) : data ? (
        <p>No tools are assigned to your account. Contact your administrator for access.</p>
      ) : null}
    </div>
  );
}
