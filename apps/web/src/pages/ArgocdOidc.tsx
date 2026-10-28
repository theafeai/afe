import { useEffect, useState, type FormEvent } from "react";
import { request } from "../api/client.ts";
import { ErrorBox, Loading, useAsync } from "../components.tsx";
interface Config {
  issuer: string;
  clientId: string;
  scopes: string[];
  authMethod: string;
  caPem?: string;
}
export function ArgocdOidcSettings({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsync(
    (s) =>
      request<{
        config: Config | null;
        clientSecretConfigured: boolean;
        callbackUrl: string | null;
      }>("GET", `/api/connections/argocd/${id}/oidc`, undefined, s),
    [id],
  );
  const [issuer, setIssuer] = useState(""),
    [clientId, setClientId] = useState(""),
    [secret, setSecret] = useState(""),
    [scopes, setScopes] = useState("openid profile email groups"),
    [method, setMethod] = useState("none"),
    [ca, setCa] = useState("");
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<Error | null>(null),
    [notice, setNotice] = useState("");
  useEffect(() => {
    if (data) {
      setIssuer(data.config?.issuer ?? "");
      setClientId(data.config?.clientId ?? "");
      setScopes(data.config?.scopes.join(" ") ?? "openid profile email groups");
      setMethod(data.config?.authMethod ?? "none");
      setCa(data.config?.caPem ?? "");
    }
  }, [data]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    setNotice("");
    try {
      await request("PUT", `/api/connections/argocd/${id}/oidc`, {
        issuer,
        clientId,
        authMethod: method,
        scopes: scopes.split(/\s+/).filter(Boolean),
        caPem: ca,
        ...(secret ? { clientSecret: secret } : {}),
      });
      setSecret("");
      setNotice("SSO settings saved. Users must link their ArgoCD account again.");
      reload();
    } catch (e) {
      setFailure(e instanceof Error ? e : new Error("Could not save SSO settings"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>Personal ArgoCD SSO</h2>
      <p>
        Configure a dedicated OIDC client whose ID tokens ArgoCD accepts. Saving publishes this
        connection's name as a sign-in choice for users assigned ArgoCD source permissions.
      </p>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <>
          <p>
            Register this callback with your identity provider:{" "}
            <code>{data?.callbackUrl ?? "Set AFE_PUBLIC_URL to your HTTPS origin first."}</code>
          </p>
          <form className="form" onSubmit={(e) => void submit(e)}>
            <label htmlFor="oidc-issuer">OIDC issuer</label>
            <input
              id="oidc-issuer"
              type="url"
              required
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
            />
            <label htmlFor="oidc-client">OIDC client ID</label>
            <input
              id="oidc-client"
              required
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <label htmlFor="oidc-method">Client authentication</label>
            <select id="oidc-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="none">Public client (PKCE)</option>
              <option value="client_secret_basic">Client secret (HTTP Basic)</option>
              <option value="client_secret_post">Client secret (POST)</option>
            </select>
            {method !== "none" && (
              <>
                <label htmlFor="oidc-secret">
                  Client secret{" "}
                  {data?.clientSecretConfigured ? "(leave blank to keep current)" : ""}
                </label>
                <input
                  id="oidc-secret"
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  required={!data?.clientSecretConfigured}
                />
              </>
            )}
            <label htmlFor="oidc-scopes">OIDC scopes</label>
            <input
              id="oidc-scopes"
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
              required
            />
            <p>
              Use openid and only the supported profile, email and groups scopes your provider
              needs.
            </p>
            <label htmlFor="oidc-ca">Extra identity-provider CA certificates (PEM, optional)</label>
            <textarea id="oidc-ca" value={ca} onChange={(e) => setCa(e.target.value)} />
            <button className="btn" disabled={busy || !data?.callbackUrl}>
              Save SSO settings
            </button>
          </form>
          {data?.config && (
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailure(null);
                void request("DELETE", `/api/connections/argocd/${id}/oidc`)
                  .then(() => {
                    setSecret("");
                    setNotice("Browser SSO disabled. Existing SSO source grants are invalidated.");
                    reload();
                  })
                  .catch((e) => setFailure(e as Error))
                  .finally(() => setBusy(false));
              }}
            >
              Disable browser SSO
            </button>
          )}
        </>
      )}
      {failure && <ErrorBox error={failure} />} {notice && <p role="status">{notice}</p>}
    </section>
  );
}
