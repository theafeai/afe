/**
 * Drift findings (AFE-26): placements whose content does not trace to Git
 * (manual overrides, untracked deploys, unknown images, ambiguous
 * attribution, out-of-band changes), with filters, severity and evidence.
 */
import { useEffect, useId, useState } from "react";
import {
  DEFAULT_DRIFT_FILTERS,
  DRIFT_TYPES,
  DRIFT_TYPE_LABELS,
  SEVERITIES,
  driftFiltersToSearch,
  fetchDriftFinding,
  fetchDriftFindings,
  journeyPath,
  parseDriftFilters,
  type DriftFilters,
  type DriftFindingSummary,
} from "../api/drift.ts";
import { mappingApi, type MappingState } from "../api/mapping.ts";
import { Empty, ErrorBox, Loading, ToolBadge, useAsync, useDocumentTitle } from "../components.tsx";
import { formatDateTime, humanize, shortHash } from "../format.ts";
import { Link, useSearchParams } from "../router.tsx";

const UNMAPPED = "_unmapped";

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function typeLabel(type: string): string {
  return DRIFT_TYPE_LABELS[type] ?? humanize(type);
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`badge severity severity-${severity}`}>{capitalize(severity)}</span>;
}

function DriftStatus({ status }: { status: string }) {
  return (
    <span className={`badge drift-status drift-status-${status}`}>
      {status === "open" ? "Open" : "Resolved"}
    </span>
  );
}

function where(f: DriftFindingSummary) {
  return (
    <>
      <span className={f.service ? undefined : "muted"}>
        {f.service?.name ?? "unmapped service"}
      </span>{" "}
      ·{" "}
      <span className={f.environment ? undefined : "muted"}>
        {f.environment?.name ?? "unmapped environment"}
      </span>
    </>
  );
}

function Filters({
  filters,
  mapping,
  onChange,
}: {
  filters: DriftFilters;
  mapping: MappingState | null;
  onChange: (f: DriftFilters) => void;
}) {
  const id = useId();
  const select = (
    key: keyof DriftFilters,
    label: string,
    options: { value: string; label: string }[],
  ) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <select
        id={`${id}-${key}`}
        value={filters[key]}
        onChange={(e) => onChange({ ...filters, [key]: e.target.value })}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <form className="filters" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
      {select("status", "Status", [
        { value: "open", label: "Open" },
        { value: "resolved", label: "Resolved" },
        { value: "all", label: "All" },
      ])}
      {select("type", "Type", [
        { value: "", label: "All types" },
        ...DRIFT_TYPES.map((t) => ({ value: t, label: typeLabel(t) })),
      ])}
      {select("severity", "Severity", [
        { value: "", label: "Any severity" },
        ...SEVERITIES.map((s) => ({ value: s, label: capitalize(s) })),
      ])}
      {select("service", "Service", [
        { value: "", label: "All services" },
        ...(mapping?.services ?? []).map((s) => ({ value: s.id, label: s.name })),
        { value: UNMAPPED, label: "Unmapped" },
      ])}
      {select("environment", "Environment", [
        { value: "", label: "All environments" },
        ...(mapping?.environments ?? []).map((e) => ({ value: e.id, label: e.name })),
        { value: UNMAPPED, label: "Unmapped" },
      ])}
    </form>
  );
}

export function DriftPage() {
  useDocumentTitle("Drift");
  const [params, setParams] = useSearchParams();
  const filters = parseDriftFilters(params);
  const key = driftFiltersToSearch(filters).toString();
  const mapping = useAsync((s) => mappingApi.get(s).catch(() => null), []);
  const page = useAsync((s) => fetchDriftFindings(filters, undefined, s), [key]);
  const [more, setMore] = useState<{ items: DriftFindingSummary[]; cursor: string | null }>({
    items: [],
    cursor: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setMore({ items: [], cursor: page.data?.nextCursor ?? null }), [page.data]);
  const items = [...(page.data?.findings ?? []), ...more.items];
  const filtered =
    filters.type || filters.severity || filters.service || filters.environment
      ? true
      : filters.status !== DEFAULT_DRIFT_FILTERS.status;

  const loadMore = () => {
    if (!more.cursor) return;
    setLoadingMore(true);
    fetchDriftFindings(filters, more.cursor)
      .then((p) => setMore((m) => ({ items: [...m.items, ...p.findings], cursor: p.nextCursor })))
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Drift</h1>
          <p className="lede">
            What is running that does not trace to Git: manual overrides, deploys without Git
            metadata, unknown images, ambiguous builds and out-of-band changes.
          </p>
        </div>
        {page.data && (
          <p className="muted small" aria-live="polite">
            {page.data.counts.open} open · {page.data.counts.resolved} resolved
            {page.data.evaluatedAt && <> · checked {formatDateTime(page.data.evaluatedAt)}</>}
          </p>
        )}
      </header>
      <Filters
        filters={filters}
        mapping={mapping.data}
        onChange={(f) => setParams(driftFiltersToSearch(f), { replace: true })}
      />
      {page.loading ? (
        <Loading label="Loading drift findings…" />
      ) : page.error ? (
        <ErrorBox error={page.error} onRetry={page.reload} title="Could not load drift findings" />
      ) : items.length === 0 ? (
        <Empty title={filtered ? "No findings match these filters" : "No drift found"}>
          <p>
            {filtered
              ? "Try another status or clear the filters."
              : "Everything deployed in the retention window traces to Git. Afe checks again every minute."}
          </p>
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Finding</th>
                  <th scope="col">Where</th>
                  <th scope="col">First seen</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td>
                      <Link to={`/drift/${f.id}`}>{f.title}</Link>
                      <div className="small muted">{typeLabel(f.type)}</div>
                    </td>
                    <td>
                      <ToolBadge source={f.target.source} /> {f.target.label}
                      <div className="small">{where(f)}</div>
                    </td>
                    <td>
                      <time dateTime={f.firstSeenAt}>{formatDateTime(f.firstSeenAt)}</time>
                    </td>
                    <td>
                      <time dateTime={f.lastSeenAt}>{formatDateTime(f.lastSeenAt)}</time>
                    </td>
                    <td>
                      <DriftStatus status={f.status} />
                      {f.resolvedAt && (
                        <div className="small muted">{formatDateTime(f.resolvedAt)}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more.cursor && (
            <p className="end">
              <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  placement: "Deploy",
  override: "Override",
  build: "Build",
  conflict: "Conflict",
  git_deploy: "Latest Git deploy",
  related: "Related",
  resolution: "Resolved by",
};

export function DriftFindingPage({ id }: { id: string }) {
  const state = useAsync((s) => fetchDriftFinding(id, s), [id]);
  const f = state.data?.finding;
  useDocumentTitle(f ? f.title : "Drift finding");
  return (
    <div className="page">
      <p className="small">
        <Link to="/drift">← Drift</Link>
      </p>
      {state.loading ? (
        <Loading label="Loading finding…" />
      ) : state.error || !f ? (
        <ErrorBox
          error={state.error ?? new Error("Not found")}
          onRetry={state.reload}
          title="Could not load this finding"
        />
      ) : (
        <>
          <header className="page-header">
            <div>
              <h1>{f.title}</h1>
              <p className="row-badges">
                <SeverityBadge severity={f.severity} /> <DriftStatus status={f.status} />{" "}
                <span className="badge">{typeLabel(f.type)}</span>
              </p>
            </div>
          </header>
          <section className="card" aria-labelledby="drift-what">
            <h2 id="drift-what">What Afe found</h2>
            <p>{f.explanation}</p>
            <dl className="small">
              <dt>Where</dt>
              <dd>
                <ToolBadge source={f.target.source} /> {f.target.label} ({f.target.toolEnvironment})
                · {where(f)}
              </dd>
              <dt>First seen</dt>
              <dd>{formatDateTime(f.firstSeenAt)}</dd>
              <dt>Last seen</dt>
              <dd>{formatDateTime(f.lastSeenAt)}</dd>
              {f.resolvedAt && (
                <>
                  <dt>Resolved</dt>
                  <dd>
                    {formatDateTime(f.resolvedAt)}
                    {f.resolvedByEventId && (
                      <>
                        {" "}
                        by <Link to={`/events/${f.resolvedByEventId}`}>a later deploy</Link>
                      </>
                    )}
                  </dd>
                </>
              )}
              <dt>Alerts</dt>
              <dd>
                {f.alert.enabled
                  ? `sent${f.alert.openedNotifiedAt ? ` ${formatDateTime(f.alert.openedNotifiedAt)}` : " (pending)"}`
                  : "not alerted for this finding"}
              </dd>
            </dl>
          </section>
          <section className="card" aria-labelledby="drift-evidence">
            <h2 id="drift-evidence">Evidence</h2>
            {f.eventsPurged > 0 && (
              <p className="muted small">
                Some events are older than the retention window and were deleted; their summaries
                are kept here.
              </p>
            )}
            <ol className="drift-evidence">
              {f.evidence.map((e) => (
                <li key={`${e.eventId}-${e.role}`}>
                  <strong>{ROLE_LABELS[e.role] ?? humanize(e.role)}</strong>{" "}
                  <time dateTime={e.at} className="muted small">
                    {formatDateTime(e.at)}
                  </time>
                  <div>{e.summary}</div>
                  {e.available && e.url ? (
                    <Link className="small" to={`/events/${e.eventId}`}>
                      View event
                    </Link>
                  ) : (
                    <span className="small muted">Event no longer retained</span>
                  )}
                </li>
              ))}
            </ol>
            {f.evidenceOmitted > 0 && (
              <p className="muted small">{f.evidenceOmitted} more events are not listed.</p>
            )}
          </section>
          {f.journeys.length > 0 && (
            <section className="card" aria-labelledby="drift-journeys">
              <h2 id="drift-journeys">Commits involved</h2>
              <ul>
                {f.journeys.map((j) => (
                  <li key={`${j.repository}@${j.commitSha}`}>
                    <Link to={journeyPath(j.url)}>
                      {j.repository} <code>{shortHash(j.commitSha)}</code>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
