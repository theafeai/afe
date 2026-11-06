import { useRef, useState } from "react";
import type {
  GitHubRunAction,
  GitHubRunControls as Controls,
  GitHubActionReceipt,
} from "@afe/core";
import { OperationDialog } from "../OperationDialog.tsx";
import { request } from "../api/client.ts";
import { ErrorBox, Loading, useAsync } from "../components.tsx";

const CANCEL_ACTION: GitHubRunAction = "github.cancel";
const labels: Record<GitHubRunAction, string> = {
  "github.cancel": "Cancel run",
  "github.rerun": "Re-run all jobs",
  "github.rerun_failed": "Re-run failed jobs",
};
export function GitHubRunControls({ eventId }: { eventId: string }) {
  return <RunControls key={eventId} eventId={eventId} />;
}

function RunControls({ eventId }: { eventId: string }) {
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
    if (
      !selected ||
      !data ||
      loading ||
      error ||
      submitting.current ||
      !data.capabilities.some((c) => c.action === selected && c.enabled)
    )
      return;
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
      {loading && <Loading label={data ? "Refreshing GitHub run…" : "Checking GitHub run…"} />}
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
                  className={c.action === CANCEL_ACTION ? "btn btn-danger" : "btn"}
                  disabled={busy || loading || !!error || !c.enabled}
                  aria-busy={loading}
                  onClick={() => {
                    setSelected(c.action);
                    setReceipt(null);
                    setFailure(null);
                  }}
                >
                  {labels[c.action]}
                </button>
                {!loading && c.reason && <small className="muted"> {c.reason}</small>}
              </span>
            ))}
          </div>
          {selected && (
            <OperationDialog
              title={labels[selected]}
              description={
                <>
                  <p>
                    {labels[selected]} for {data.context.repository}, run {data.context.runId},
                    attempt {data.context.runAttempt}?
                  </p>
                  <p className="small muted">
                    {selected === CANCEL_ACTION
                      ? "GitHub will be asked to stop this run. Jobs that have already finished are kept."
                      : "GitHub will start another attempt. This may trigger a deployment."}
                  </p>
                </>
              }
              confirmLabel={labels[selected]}
              destructive={selected === CANCEL_ACTION}
              busy={busy}
              confirmDisabled={loading || !!error}
              error={failure}
              onConfirm={() => void execute()}
              onCancel={() => {
                setSelected(null);
                setFailure(null);
              }}
            />
          )}
        </>
      )}
      {failure && !selected && <ErrorBox error={failure} />}
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
