import { GitHubRunControls } from "./GitHubRunControls.tsx";
import { useAccess } from "../access.tsx";
import { api } from "../api/client.ts";
import type { ActorRef, Correlation } from "@afe/core/types";
import {
  ErrorBox,
  KeyValue,
  Loading,
  MethodBadge,
  OutcomeBadge,
  ToolBadge,
  toolLabel,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { formatBytes, formatDateTime, formatDuration, humanize } from "../format.ts";
import { Link } from "../router.tsx";
import { ContainmentPanel, containmentSubject } from "./ContainmentPanel.tsx";
import { JourneyLinks } from "./JourneyLinks.tsx";

function actorText(a: ActorRef | undefined) {
  if (!a) return null;
  const bits = [a.login, a.name && a.name !== a.login ? a.name : null, a.email].filter(Boolean);
  return (
    <>
      {bits.join(" · ") || a.id || "—"}{" "}
      <span className="muted">
        ({a.type}
        {a.id ? `, id ${a.id}` : ""})
      </span>
    </>
  );
}

/**
 * Correlation key list → API filter parameter, so each key links to related
 * events. Keys without a filter parameter (yet) are shown without a link.
 */
const CORRELATION_PARAMS: Partial<Record<keyof Correlation, string>> = {
  commitShas: "commitSha",
  refs: "ref",
  repositories: "repository",
  environments: "environment",
  imageRefs: "imageRef",
  imageDigests: "imageDigest",
  deploymentIds: "deploymentId",
  runIds: "runId",
  pullRequests: "pullRequest",
};

export function EventDetailPage({ id }: { id: string }) {
  const { managed } = useAccess();
  const { data, error, loading, reload } = useAsync((s) => api.event(id, s), [id]);
  useDocumentTitle(data ? data.event.action : "Event");
  if (loading) return <Loading label="Loading event…" />;
  if (error)
    return (
      <div className="page">
        <p>
          <Link to="/events">← Events</Link>
        </p>
        <ErrorBox error={error} onRetry={reload} title="Could not load this event" />
      </div>
    );
  if (!data) return null;
  const { event: e, provenance: p, rawPayload: raw } = data;
  const lag = new Date(e.observedAt).getTime() - new Date(e.occurredAt).getTime();
  const correlation = Object.entries(e.correlation ?? {}).filter(
    ([, v]) => Array.isArray(v) && v.length > 0,
  ) as [keyof Correlation, string[]][];
  const subject = containmentSubject(e);

  return (
    <div className="page">
      <p>
        <Link to="/events">← Events</Link>
      </p>
      <header className="page-header">
        <div>
          <h1 className="mono-title">{e.action}</h1>
          <p className="lede">
            <ToolBadge source={e.source} /> <OutcomeBadge outcome={e.outcome} />{" "}
            <MethodBadge method={p.method} /> occurred{" "}
            <time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time>
          </p>
        </div>
      </header>

      {p.discoveredByReconciliation && (
        <div className="callout callout-reconciled" role="note">
          <strong>Discovered by reconciliation.</strong> This event should have arrived by webhook
          or polling but did not; a reconciliation pass found it later.
        </div>
      )}

      <div className="grid-2">
        <section className="card">
          <h2>Who</h2>
          <KeyValue
            items={[
              ["Actor", actorText(e.actor)],
              ["On behalf of", actorText(e.actor.onBehalfOf)],
              ["Triggered by", actorText(e.actor.triggeredBy)],
            ]}
          />
        </section>
        <section className="card">
          <h2>What and where</h2>
          <KeyValue
            items={[
              [
                "Target",
                `${e.target.name ?? e.target.id} (${humanize(e.target.type)}, id ${e.target.id})`,
              ],
              ["Repository", e.target.repository],
              ["Project", e.target.project],
              ["Application", e.target.application],
              ["Environment", e.target.environment],
              [
                "Cluster / namespace",
                [e.target.cluster, e.target.namespace].filter(Boolean).join(" / "),
              ],
              ["Ref", e.target.ref],
              [
                "URL",
                e.target.url ? (
                  <a href={e.target.url} target="_blank" rel="noreferrer noopener">
                    {e.target.url}
                  </a>
                ) : null,
              ],
            ]}
          />
        </section>
        <section className="card">
          <h2>How</h2>
          <KeyValue
            items={[
              ["Trigger", humanize(e.trigger.type)],
              ["Source's term", e.trigger.sourceValue],
              ["Detail", e.trigger.detail],
              ["Outcome", humanize(e.outcome)],
            ]}
          />
        </section>
        <section className="card">
          <h2>Provenance</h2>
          <KeyValue
            items={[
              ["Observed by", <MethodBadge key="m" method={p.method} />],
              ["Tool", toolLabel(p.source)],
              ["Source event id", <code key="s">{p.sourceEventId}</code>],
              ["Occurred at", formatDateTime(e.occurredAt)],
              [
                "Observed at",
                <>
                  {formatDateTime(e.observedAt)}{" "}
                  <span className="muted">
                    (
                    {lag >= 0
                      ? `${formatDuration(lag)} after it occurred`
                      : `${formatDuration(lag)} before (clock skew)`}
                    )
                  </span>
                </>,
              ],
              ["Recorded at", formatDateTime(e.recordedAt)],
              [
                "Connection",
                p.connectionId ? (
                  <Link key="c" to={`/connections/${p.connectionId}`}>
                    {p.connectionId}
                  </Link>
                ) : null,
              ],
              ["Delivery id", p.deliveryId ? <code key="d">{p.deliveryId}</code> : null],
              ["Job id", p.jobId ? <code key="j">{p.jobId}</code> : null],
              ["Observation note", e.observation.detail],
            ]}
          />
        </section>
      </div>

      <section className="card">
        <h2>Raw payload</h2>
        {raw ? (
          <KeyValue
            items={[
              ["Content type", raw.contentType ?? "unknown type"],
              ["Size", formatBytes(raw.sizeBytes)],
              [
                "SHA-256",
                <code key="h" className="hash">
                  {raw.sha256}
                </code>,
              ],
              [
                "Download",
                <a key="d" href={raw.url} download>
                  Download raw payload
                </a>,
              ],
            ]}
          />
        ) : (
          <p className="muted">None (recorded by Afe itself).</p>
        )}
        <p className="small muted">
          The payload as received from the source, kept for debugging. It is deleted together with
          the event when the event leaves the retention window.
        </p>
      </section>

      <section className="card">
        <h2>Correlation keys</h2>
        {correlation.length === 0 ? (
          <p className="muted">No correlation keys.</p>
        ) : (
          <KeyValue
            items={correlation.map(([k, values]) => [
              humanize(k),
              <ul key={k} className="inline-list">
                {values.map((v) => {
                  const param = CORRELATION_PARAMS[k];
                  return (
                    <li key={v}>
                      {param ? (
                        <Link
                          to={`/events?${new URLSearchParams({ [param]: v }).toString()}`}
                          title="Show related events"
                        >
                          <code>{v}</code>
                        </Link>
                      ) : (
                        <code>{v}</code>
                      )}
                    </li>
                  );
                })}
              </ul>,
            ])}
          />
        )}
      </section>

      {e.source === "github" && e.target.type === "workflow_run" && (
        <>
          <p>
            <Link
              to={`/github?${new URLSearchParams({ connectionId: e.connectionId ?? "", repository: e.target.repository ?? "" })}`}
            >
              Open full GitHub Actions workspace
            </Link>
          </p>
          <GitHubRunControls key={e.id} eventId={e.id} />
        </>
      )}
      <JourneyLinks event={e} />
      {!managed && subject && (
        <ContainmentPanel repository={subject.repository} commit={subject.commit} />
      )}

      <section className="card">
        <h2>Event data</h2>
        <details>
          <summary>Action-specific data and the full canonical event</summary>
          <pre className="json">{JSON.stringify(e, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
