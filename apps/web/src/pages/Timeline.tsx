import { useState } from "react";
import { api } from "../api/client.ts";
import type { AuditVerifyResult, CanonicalEvent, EventItem, ObservationGap } from "../api/types.ts";
import {
  Empty,
  ErrorBox,
  GapBanners,
  Loading,
  MethodBadge,
  OutcomeBadge,
  ToolBadge,
  gapReason,
  toolLabel,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { FilterBar } from "../FilterBar.tsx";
import {
  activeFilterCount,
  filtersToApiParams,
  filtersToSearch,
  parseFilters,
  type Filters,
} from "../filters.ts";
import { dayKey, formatDateTime, formatDay, formatTime, humanize, shortHash } from "../format.ts";
import { Link, useSearchParams } from "../router.tsx";
import { usePaged } from "../usePaged.ts";

export function actorLabel(e: CanonicalEvent): string {
  const a = e.actor;
  const main = a.login ?? a.name ?? a.id ?? a.type;
  const via = a.onBehalfOf
    ? ` on behalf of ${a.onBehalfOf.login ?? a.onBehalfOf.name ?? a.onBehalfOf.id ?? a.onBehalfOf.type}`
    : a.triggeredBy
      ? ` (triggered by ${a.triggeredBy.login ?? a.triggeredBy.name ?? a.triggeredBy.id ?? a.triggeredBy.type})`
      : "";
  return main + via;
}

export function targetLabel(e: CanonicalEvent): string {
  const t = e.target;
  const name = t.application ?? t.project ?? t.name ?? t.repository ?? t.id;
  return name;
}

function gapOf(e: CanonicalEvent): Partial<ObservationGap> | null {
  const g = e.data?.gap;
  return g && typeof g === "object" && !Array.isArray(g) ? (g as Partial<ObservationGap>) : null;
}

export function isGapEvent(e: CanonicalEvent): boolean {
  return e.action === "observation_gap.opened" || e.action === "observation_gap.closed";
}

function GapRow({ e }: { e: CanonicalEvent }) {
  const g = gapOf(e);
  const opened = e.action === "observation_gap.opened";
  return (
    <li className={`event-row row-gap ${opened ? "row-gap-opened" : "row-gap-closed"}`}>
      <Link to={`/events/${e.id}`} className="row-link">
        <time className="row-time" dateTime={e.occurredAt} title={e.occurredAt}>
          {formatTime(e.occurredAt)}
        </time>
        <span className="row-main">
          <span className="row-title">
            <span className="gap-icon" aria-hidden="true">
              {opened ? "⚠" : "✓"}
            </span>{" "}
            {opened ? "Observation gap opened" : "Observation gap closed"}
            {g?.source ? ` — ${toolLabel(g.source)}` : ""} “{e.target.name ?? e.target.id}”
          </span>
          <span className="row-meta">
            {opened
              ? `Events since ${formatDateTime(g?.startedAt)} may be missing (${gapReason(g?.reason)}).`
              : `Gap from ${formatDateTime(g?.startedAt)} to ${formatDateTime(g?.endedAt)} closed; a backfill re-reads that period.`}
          </span>
        </span>
        <span className="row-badges">
          <ToolBadge source={e.source} />
          <span className="badge gap-badge">{opened ? "gap opened" : "gap closed"}</span>
        </span>
      </Link>
    </li>
  );
}

export function EventRow({ item }: { item: EventItem }) {
  const e = item.event;
  if (isGapEvent(e)) return <GapRow e={e} />;
  const m = e.observation.method;
  const late = m === "reconciliation" || m === "backfill";
  return (
    <li className={`event-row${late ? ` row-${m}` : ""}`}>
      <Link to={`/events/${e.id}`} className="row-link">
        <time className="row-time" dateTime={e.occurredAt} title={e.occurredAt}>
          {formatTime(e.occurredAt)}
        </time>
        <span className="row-main">
          <span className="row-title">
            <span className="action">{e.action}</span> <OutcomeBadge outcome={e.outcome} />
          </span>
          <span className="row-meta">
            <span>
              <span className="muted">by</span> {actorLabel(e)}
            </span>
            <span>
              <span className="muted">on</span> {targetLabel(e)}
              {e.target.environment && (
                <>
                  {" "}
                  <span className="muted">→</span> <strong>{e.target.environment}</strong>
                </>
              )}
            </span>
            <span>
              <span className="muted">trigger</span> {humanize(e.trigger.type)}
            </span>
          </span>
          {late && (
            <span className="row-note">
              {m === "reconciliation"
                ? "Found by reconciliation — the tool's webhook/poll did not deliver it."
                : "Imported by backfill after the fact."}
            </span>
          )}
        </span>
        <span className="row-badges">
          <ToolBadge source={e.source} />
          <MethodBadge method={m} />
        </span>
      </Link>
    </li>
  );
}

/** Reverse-chronological list grouped by local day. */
export function EventList({ items }: { items: EventItem[] }) {
  const groups: { key: string; label: string; items: EventItem[] }[] = [];
  for (const it of items) {
    const key = dayKey(it.event.occurredAt);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: formatDay(it.event.occurredAt), items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  return (
    <div className="timeline">
      {groups.map((g) => (
        <section key={g.key} className="day" aria-label={g.label}>
          <h3 className="day-heading">{g.label}</h3>
          <ol className="events">
            {g.items.map((it) => (
              <EventRow key={it.event.id} item={it} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function VerifyResult({ result }: { result: AuditVerifyResult }) {
  const v = result.verification;
  if (result.ok) {
    return (
      <div className="callout callout-ok" role="status">
        <strong>Audit log intact.</strong> {v.count} event{v.count === 1 ? "" : "s"} verified (hash
        chain, links and raw payloads). Chain head: seq {result.head?.seq ?? v.lastSeq}, hash{" "}
        <code title={result.head?.hash ?? v.lastHash}>
          {shortHash(result.head?.hash ?? v.lastHash, 16)}
        </code>
        . Write the head down to check later that history was not rewritten.
      </div>
    );
  }
  return (
    <div className="callout callout-error" role="alert">
      <strong>Audit log verification FAILED.</strong>{" "}
      {v.break
        ? `${humanize(v.break.kind)} at seq ${v.break.seq ?? "?"}: ${v.break.message}`
        : "The chain head does not match."}{" "}
      {v.count} event(s) before the break verified.
      {v.break?.eventId && (
        <>
          {" "}
          <Link to={`/events/${v.break.eventId}`}>Open the event</Link>
        </>
      )}
    </div>
  );
}

export function Timeline() {
  useDocumentTitle("Events");
  const [params, setParams] = useSearchParams();
  const filters = parseFilters(params);
  const key = filtersToSearch(filters).toString();
  const setFilters = (f: Filters) => setParams(filtersToSearch(f), { replace: true });
  const connections = useAsync((s) => api.connections(s), []);
  const page = usePaged(
    key,
    () => filtersToApiParams(parseFilters(new URLSearchParams(key))),
    (p, s) => api.events(p, s),
  );
  const [verify, setVerify] = useState<{
    running: boolean;
    result: AuditVerifyResult | null;
    error: Error | null;
  }>({ running: false, result: null, error: null });

  const runVerify = () => {
    setVerify({ running: true, result: null, error: null });
    api.verifyAuditLog().then(
      (result) => setVerify({ running: false, result, error: null }),
      (error: Error) => setVerify({ running: false, result: null, error }),
    );
  };
  const exportParams = filtersToApiParams(filters);
  const filtered = activeFilterCount(filters) > 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Events</h1>
          <p className="lede">Everything Afe recorded across your connected tools, newest first.</p>
        </div>
        <div className="toolbar">
          <details className="menu">
            <summary className="btn">Export</summary>
            <div className="menu-body" role="menu">
              <p className="small muted">
                Exports {filtered ? "the events matching the current filters" : "all events"}, with
                an integrity manifest (verify with <code>afe verify-export</code>).
              </p>
              <a
                role="menuitem"
                className="btn"
                href={api.exportUrl(exportParams, "json")}
                download
              >
                JSON Lines
              </a>
              <a role="menuitem" className="btn" href={api.exportUrl(exportParams, "csv")} download>
                CSV
              </a>
            </div>
          </details>
          <button type="button" className="btn" onClick={runVerify} disabled={verify.running}>
            {verify.running ? "Verifying…" : "Verify audit log"}
          </button>
        </div>
      </header>

      {verify.running && <Loading label="Verifying every event in the hash chain…" />}
      {verify.result && <VerifyResult result={verify.result} />}
      {verify.error && <ErrorBox title="Could not verify the audit log" error={verify.error} />}

      {connections.data && <GapBanners connections={connections.data.connections} />}
      {connections.error && (
        <div className="callout callout-gap" role="status">
          Could not load connection health ({connections.error.message}), so open observation gaps
          cannot be shown. Data may be missing.
        </div>
      )}

      <FilterBar filters={filters} onChange={setFilters} />

      {page.loading ? (
        <Loading label="Loading events…" />
      ) : page.error && page.items.length === 0 ? (
        <ErrorBox error={page.error} onRetry={page.reload} title="Could not load events" />
      ) : page.items.length === 0 ? (
        filtered ? (
          <Empty title="No events match these filters">
            <p>Widen the time range or clear some filters.</p>
          </Empty>
        ) : connections.data && connections.data.connections.length === 0 ? (
          <Empty title="Nothing recorded yet">
            <p>
              Afe records events once a tool is connected.{" "}
              <Link to="/connections">Connect GitHub, ArgoCD or Vercel</Link> to start.
            </p>
          </Empty>
        ) : (
          <Empty title="No events recorded yet">
            <p>
              Your connections have not delivered any events so far. Check their{" "}
              <Link to="/connections">health</Link>; new deployments appear here as they happen.
            </p>
          </Empty>
        )
      ) : (
        <>
          <EventList items={page.items} />
          {page.error && (
            <ErrorBox error={page.error} onRetry={page.loadMore} title="Could not load more" />
          )}
          {page.hasMore ? (
            <button
              type="button"
              className="btn btn-wide"
              onClick={page.loadMore}
              disabled={page.loadingMore}
            >
              {page.loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : (
            <p className="end muted">
              End of the log for these filters ({page.items.length} events).
            </p>
          )}
        </>
      )}
    </div>
  );
}
