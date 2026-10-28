import { useRef, useState } from "react";
import type {
  GitHubRunAction,
  GitHubRunControls as Controls,
  GitHubActionReceipt,
} from "@afe/core";
import { request } from "../api/client.ts";
import { ErrorBox, Loading, useAsync } from "../components.tsx";

const labels: Record<GitHubRunAction, string> = {
  "github.cancel": "Cancel run",
  "github.rerun": "Re-run all jobs",
  "github.rerun_failed": "Re-run failed jobs",
};
export function GitHubRunControls({ eventId }: { eventId: string }) {
  const url = `/api/actions/github/events/${encodeURIComponent(eventId)}`;
  const { data, error, loading, reload } = useAsync(
    (s) => request<Controls>("GET", url, undefined, s),
    [url],
  );
  const [selected, setSelected] = useState<GitHubRunAction | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [receipt, setReceipt] = useState<GitHubActionReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  // Keep the same id across an ambiguous network result, including manual resubmission.
  const intent = useRef<{ action: GitHubRunAction; attempt: number; requestId: string } | null>(
    null,
  );
  const submitting = useRef(false);
  async function execute() {
    if (!selected || !data || submitting.current) return;
    const action = selected,
      attempt = data.context.runAttempt;
    if (intent.current?.action !== action || intent.current.attempt !== attempt)
      intent.current = { action, attempt, requestId: crypto.randomUUID() };
    submitting.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await request<GitHubActionReceipt>("POST", url, {
        action,
        expectedAttempt: attempt,
        requestId: intent.current.requestId,
        confirmed: true,
      });
      setReceipt(result);
      setSelected(null);
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err : new Error("Request failed"));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="GitHub run controls">
      <h2>GitHub run controls</h2>
      {loading && <Loading label="Checking GitHub run…" />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <p>
            {data.context.repository} · Run {data.context.runId} · Current attempt{" "}
            {data.context.runAttempt} · {data.status}
            {data.conclusion ? ` (${data.conclusion})` : ""}
          </p>
          <p className="muted">
            Controls apply to the current attempt. Earlier attempt logs remain separate.
          </p>
          <div className="actions">
            {data.capabilities.map((c) => (
              <span key={c.action}>
                <button
                  className="btn"
                  disabled={busy || !c.enabled}
                  onClick={() => {
                    setSelected(c.action);
                    setReceipt(null);
                    setFailure(null);
                  }}
                >
                  {labels[c.action]}
                </button>
                {c.reason && <small className="muted"> {c.reason}</small>}
              </span>
            ))}
          </div>
          {selected && (
            <div role="group" aria-label="Confirm GitHub action">
              <p>
                {labels[selected]} for {data.context.repository}, run {data.context.runId}, attempt{" "}
                {data.context.runAttempt}?
              </p>
              <button className="btn btn-primary" disabled={busy} onClick={() => void execute()}>
                {busy ? "Submitting…" : `Confirm ${labels[selected].toLowerCase()}`}
              </button>{" "}
              <button className="btn" disabled={busy} onClick={() => setSelected(null)}>
                Go back
              </button>
            </div>
          )}
        </>
      )}
      {failure && <ErrorBox error={failure} />}
      {receipt && <p role="status">{receipt.message}</p>}
      <button
        className="btn"
        disabled={busy || loading}
        onClick={() => {
          setSelected(null);
          reload();
        }}
      >
        Refresh run state
      </button>
    </section>
  );
}
