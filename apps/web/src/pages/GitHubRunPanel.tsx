import { useEffect, useState } from "react";
import type { CanonicalEvent } from "@afe/core/types";
import { ApiError } from "../api/client.ts";
import {
  fetchWorkflowJobLog,
  fetchWorkflowProgress,
  type WorkflowProgress,
  type WorkflowStep,
} from "../api/github-runs.ts";
import { Empty, ErrorBox, Loading, OutcomeBadge } from "../components.tsx";
import { formatDateTime, formatDuration, humanize } from "../format.ts";
import "./GitHubRunPanel.css";

/** Only exact source run metadata enables this panel; a commit can have many workflows. */
export function hasGitHubRun(event: CanonicalEvent) {
  return (
    event.source === "github" &&
    Boolean(event.connectionId) &&
    Boolean(event.data.run || event.data.job)
  );
}

function ProgressState({
  status,
  conclusion,
}: {
  status: string | null;
  conclusion: string | null;
}) {
  const result = conclusion ?? status ?? "unknown";
  const outcome =
    result === "success"
      ? "succeeded"
      : ["failure", "timed_out", "startup_failure", "action_required"].includes(result)
        ? "failed"
        : result === "cancelled"
          ? "cancelled"
          : result === "in_progress"
            ? "in_progress"
            : result === "skipped"
              ? "skipped"
              : result === "neutral" || result === "completed"
                ? "unknown"
                : "pending";
  return (
    <>
      <OutcomeBadge outcome={outcome} />
      {["neutral", "completed", "timed_out", "action_required"].includes(result) && (
        <span className="small"> {humanize(result)}</span>
      )}
    </>
  );
}

function duration(step: Pick<WorkflowStep, "startedAt" | "completedAt">, now: string) {
  if (!step.startedAt) return "—";
  const ms = Date.parse(step.completedAt ?? now) - Date.parse(step.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : "—";
}

export function GitHubRunPanel({ eventId }: { eventId: string }) {
  const [data, setData] = useState<WorkflowProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [automatic, setAutomatic] = useState(true);
  const [revision, setRevision] = useState(0);
  const [jobId, setJobId] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async () => {
      let delay: number | null = 5000;
      try {
        const next = await fetchWorkflowProgress(eventId, controller.signal);
        if (controller.signal.aborted) return;
        setData(next);
        setError(null);
        failures = 0;
        delay = next.nextPollMs;
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err as Error);
        failures++;
        const denied = err instanceof ApiError && [401, 403, 404].includes(err.status);
        if (denied) {
          setData(null);
          setJobId(null);
          delay = null;
        } else
          delay = Math.max(
            Math.min(60_000, 5000 * 2 ** Math.min(failures, 4)),
            err instanceof ApiError ? Number(err.body?.retryAfterMs) || 0 : 0,
          );
      }
      if (automatic && delay !== null && !controller.signal.aborted) {
        const tick = () => {
          if (document.visibilityState === "hidden") timer = setTimeout(tick, delay!);
          else void poll();
        };
        timer = setTimeout(tick, delay);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [eventId, automatic, revision]);

  return (
    <section className="card" aria-labelledby="github-run-heading">
      <div className="page-header">
        <div>
          <h2 id="github-run-heading">GitHub workflow progress</h2>
          <p className="small muted">
            Step progress refreshes while the workflow runs. Command logs are available after it
            finishes.
          </p>
        </div>
        <div className="toolbar">
          <button className="btn-ghost" onClick={() => setRevision((n) => n + 1)}>
            Refresh progress
          </button>
          {data?.run.status !== "completed" && (
            <button
              className="btn-ghost"
              aria-pressed={automatic}
              onClick={() => setAutomatic((v) => !v)}
            >
              {automatic ? "Pause updates" : "Resume updates"}
            </button>
          )}
        </div>
      </div>
      {error && (
        <ErrorBox
          error={error}
          title="Could not refresh workflow progress"
          onRetry={() => setRevision((n) => n + 1)}
        />
      )}
      {!data && !error && <Loading label="Loading workflow progress…" />}
      {data && (
        <>
          <p>
            <strong>{data.run.name}</strong> · Run {data.run.id} · Attempt {data.run.attempt} ·{" "}
            <ProgressState status={data.run.status} conclusion={data.run.conclusion} />{" "}
            <a href={data.run.url} target="_blank" rel="noreferrer noopener">
              View on GitHub
            </a>
          </p>
          <p className="small muted">
            Last checked {formatDateTime(data.checkedAt)}
            {automatic && data.nextPollMs
              ? " · Updates every 5 seconds"
              : data.nextPollMs
                ? " · Updates paused"
                : " · Workflow finished"}
            .
          </p>
          {data.partial && (
            <p className="callout" role="note">
              The job list is incomplete. Open GitHub to see the complete workflow.
            </p>
          )}
          {data.jobs.length === 0 && (
            <Empty title="No jobs reported yet">
              <p>Jobs and steps appear when GitHub reports them.</p>
            </Empty>
          )}
          {data.jobs.map((job) => (
            <div key={job.id}>
              <h3>
                {job.name} · <ProgressState status={job.status} conclusion={job.conclusion} />
              </h3>
              {job.steps.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <caption className="sr-only">Steps for {job.name}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Step</th>
                        <th scope="col">Result</th>
                        <th scope="col">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {job.steps.map((step) => (
                        <tr key={step.number}>
                          <td>
                            {step.number}. {step.name}
                          </td>
                          <td>
                            <ProgressState status={step.status} conclusion={step.conclusion} />
                          </td>
                          <td>{duration(step, data.checkedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">No steps reported for this job yet.</p>
              )}
              {data.run.status === "completed" && (
                <p>
                  <button
                    className="btn"
                    aria-expanded={jobId === job.id}
                    onClick={() => setJobId(jobId === job.id ? null : job.id)}
                  >
                    {jobId === job.id ? "Hide logs" : `View logs for ${job.name}`}
                  </button>
                </p>
              )}
              {jobId === job.id && (
                <JobLog key={`${eventId}:${job.id}`} eventId={eventId} jobId={job.id} />
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function JobLog({ eventId, jobId }: { eventId: string; jobId: number }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    setText(null);
    setError(null);
    const load = async () => {
      try {
        const next = await fetchWorkflowJobLog(eventId, jobId, controller.signal);
        if (!controller.signal.aborted) {
          setText(next.text);
          setError(null);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err as Error);
        if (
          err instanceof ApiError &&
          [404, 409, 429, 502].includes(err.status) &&
          err.code !== "logs_unsafe_destination" &&
          retries < 4
        ) {
          const delay = Math.max(2000 * 2 ** retries++, Number(err.body?.retryAfterMs) || 0);
          timer = setTimeout(() => {
            void load();
          }, delay);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [eventId, jobId, revision]);
  return (
    <div>
      {text === null && !error && <Loading label="Fetching job logs…" />}
      {error && (
        <ErrorBox
          error={error}
          title="Job logs unavailable"
          onRetry={() => setRevision((n) => n + 1)}
        />
      )}
      {text !== null &&
        (text ? (
          <pre className="json github-run-log" aria-label="Job log" tabIndex={0}>
            {text}
          </pre>
        ) : (
          <p className="muted">This job has no log output.</p>
        ))}
    </div>
  );
}
