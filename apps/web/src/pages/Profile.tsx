import { useState } from "react";
import { request } from "../api/client.ts";
import { ErrorBox, Loading, useAsync, useDocumentTitle } from "../components.tsx";
import type { ProfileInfo, ProfileTool } from "../access.tsx";
function ToolAccount({ tool, reload }: { tool: ProfileTool; reload: () => void }) {
  const [token, setToken] = useState("");
  const [workflowAccess, setWorkflowAccess] = useState(false);
  const [context, setContext] = useState("");
  const [oidcConnection, setOidcConnection] = useState(tool.oidcConnections?.[0]?.id ?? "");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>{tool.tool}</h2>
      <p>
        Permission: {tool.mode}.{" "}
        {tool.linked ? `Linked as ${tool.accountName}.` : "No account linked."}
      </p>
      {error && <ErrorBox error={error} />}
      {tool.sourceEnabled && tool.sourceAvailable === false && (
        <p>This tool has no personal sign-in. Ask your administrator for custom resource access.</p>
      )}
      {tool.sourceEnabled && tool.sourceAvailable !== false && (
        <>
          {tool.tool === "argocd" && tool.oauthAvailable && (
            <>
              <label htmlFor="argocd-sso-connection">ArgoCD connection</label>
              <select
                id="argocd-sso-connection"
                value={oidcConnection}
                onChange={(e) => setOidcConnection(e.target.value)}
              >
                {tool.oidcConnections?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p>Signing in replaces your current ArgoCD account link.</p>
            </>
          )}
          {tool.tool === "github" && tool.oauthAvailable && (
            <label className="check">
              <input
                type="checkbox"
                checked={workflowAccess}
                onChange={(e) => setWorkflowAccess(e.target.checked)}
              />
              Allow editing workflow files when signing in (adds GitHub workflow scope)
            </label>
          )}
          {tool.oauthAvailable && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
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
              Sign in with{" "}
              {tool.tool === "github" ? "GitHub" : tool.tool === "argocd" ? "ArgoCD" : "Vercel"}
            </button>
          )}
          {tool.tool === "github" && !tool.oauthAvailable && (
            <p>
              Use a fine-grained GitHub token below, or ask your administrator to configure OAuth
              sign-in.
            </p>
          )}
          {["github", "vercel", "argocd"].includes(tool.tool) && (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
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
                });
              }}
            >
              <p>Use your own {tool.tool} access token to inherit your existing permissions.</p>
              <label htmlFor={`${tool.tool}-token`}>Your tool access token</label>
              <input
                id={`${tool.tool}-token`}
                type="password"
                autoComplete="off"
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              {tool.tool !== "github" && (
                <>
                  <label htmlFor={`${tool.tool}-context`}>
                    {tool.tool === "argocd"
                      ? "Connection ID (ask your admin)"
                      : "Team ID (optional)"}
                  </label>
                  <input
                    id={`${tool.tool}-context`}
                    required={tool.tool === "argocd"}
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                  />
                </>
              )}
              {tool.tool === "github" && (
                <p>
                  Prefer a fine-grained token limited to the selected repositories, with Actions
                  read/write and only the additional Contents, Workflows, Deployments or
                  Environments permissions you use. Afe grants remain required.
                </p>
              )}
              <button className="btn" disabled={busy}>
                Link account
              </button>
            </form>
          )}
        </>
      )}
      {tool.linked && (
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await request("DELETE", `/api/profile/tools/${tool.tool}`);
              reload();
            })
          }
        >
          Disconnect account
        </button>
      )}
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
      <h1>Profile</h1>
      <p>
        Your Afe login opens the dashboard. Tool access is assigned separately by your
        administrator.
      </p>
      {error && <ErrorBox error={error} />}{" "}
      {loading ? (
        <Loading />
      ) : data?.tools.length ? (
        data.tools.map((t) => <ToolAccount key={t.tool} tool={t} reload={reload} />)
      ) : (
        <p>No tools are assigned to your account. Contact your administrator for access.</p>
      )}
    </div>
  );
}
