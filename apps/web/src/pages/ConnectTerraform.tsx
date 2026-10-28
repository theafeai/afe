import { useState } from "react";
import { api } from "../api/client.ts";
import { ErrorBox, useDocumentTitle } from "../components.tsx";
import { Link } from "../router.tsx";

export function ConnectTerraform() {
  useDocumentTitle("Connect Terraform");
  const [form, setForm] = useState({ workspace: "", environment: "", repository: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.terraformConnect>> | null>(
    null,
  );
  return (
    <div className="page">
      <h1>Connect Terraform</h1>
      <p>
        Afe receives signed reports from your Terraform CLI runs. It does not run Terraform or read
        state, plans or logs.
      </p>
      <p>
        Reports appear in Events and can link to Git journeys. A successful report does not prove
        what is currently deployed.
      </p>
      {result ? (
        <section className="card">
          <h2>Save your reporter secret</h2>
          <p>
            This secret is shown once. Store it in your local secret manager or CI secrets. It can
            only submit reports for this connection.
          </p>
          <label htmlFor="terraform-secret">Reporter secret</label>
          <input
            id="terraform-secret"
            type="password"
            value={result.secret}
            readOnly
            autoComplete="off"
          />
          <p>Use this reporting endpoint with the Terraform reporter:</p>
          <code>
            {window.location.origin}
            {result.reportPath}
          </code>
          <p>
            Connection health stays unknown until a report is processed. Idle time does not
            establish that a runner is reachable.
          </p>
          <Link to={`/connections/${result.connection.id}`}>
            I saved the secret — open connection
          </Link>
        </section>
      ) : (
        <form
          className="form card"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              setResult(
                await api.terraformConnect({
                  workspace: form.workspace.trim(),
                  ...(form.environment.trim() ? { environment: form.environment.trim() } : {}),
                  ...(form.repository.trim() ? { repository: form.repository.trim() } : {}),
                }),
              );
            } catch (e) {
              setError(e instanceof Error ? e : new Error("Could not connect"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="terraform-workspace">Workspace name</label>
          <input
            id="terraform-workspace"
            required
            value={form.workspace}
            maxLength={128}
            onChange={(e) => setForm({ ...form, workspace: e.target.value })}
            placeholder="afe-demo"
          />
          <label htmlFor="terraform-environment">Environment (optional)</label>
          <input
            id="terraform-environment"
            value={form.environment}
            maxLength={128}
            onChange={(e) => setForm({ ...form, environment: e.target.value })}
            placeholder="development"
          />
          <label htmlFor="terraform-repository">GitHub repository (optional)</label>
          <input
            id="terraform-repository"
            value={form.repository}
            onChange={(e) => setForm({ ...form, repository: e.target.value })}
            placeholder="owner/repository"
          />
          <p>
            Use a separate connection for each workspace/environment. Identifiers use letters,
            digits, underscores, dots and hyphens.
          </p>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Connecting…" : "Create reporter connection"}
          </button>
          {error && <ErrorBox error={error} title="Could not connect Terraform" />}
        </form>
      )}
    </div>
  );
}
