import { api } from "../api/client.ts";
import type { CanonicalEvent, EventItem, ObservationGap } from "../api/types.ts";
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
import { dayKey, formatDateTime, formatDay, formatTime, humanize } from "../format.ts";
import { Link, useSearchParams } from "../router.tsx";
import { usePaged } from "../usePaged.ts";
import { useJourneyHighlight, type RowDecoration } from "./JourneyHighlight.tsx";

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

export function EventRow({ item, decoration }: { item: EventItem; decoration?: RowDecoration }) {
  const e = item.event;
  if (isGapEvent(e)) return <GapRow e={e} />;
  const m = e.observation.method;
  const late = m === "reconciliation" || m === "backfill";
  const hl = decoration?.highlight;
  return (
    <li
      className={`event-row${late ? ` row-${m}` : ""}${hl ? ` row-hl-${hl}` : ""}${decoration?.action ? " has-action" : ""}`}
    >
      <Link to={`/events/${e.id}`} className="row-link">
        <time className="row-time" dateTime={e.occurredAt} title={e.occurredAt}>
          {formatTime(e.occurredAt)}
        </time>
        <span className="row-main">
          <span className="row-title">
            <span className="action">{e.action}</span> <OutcomeBadge outcome={e.outcome} />
            {hl === "on" && <span className="hl-tag"> · on the journey</span>}
            {hl === "excluded" && <span className="hl-tag"> · ruled out of the journey</span>}
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
      {decoration?.action && <span className="row-action">{decoration.action}</span>}
    </li>
  );
}

/** Reverse-chronological list grouped by local day. */
export function EventList({
  items,
  decorate,
}: {
  items: EventItem[];
  decorate?: (item: EventItem) => RowDecoration;
}) {
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
              <EventRow key={it.event.id} item={it} decoration={decorate?.(it)} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function Timeline() {
  useDocumentTitle("Events");
  const [params, setParams] = useSearchParams();
  const filters = parseFilters(params);
  const key = filtersToSearch(filters).toString();
  const connections = useAsync((s) => api.connections(s), []);
  const page = usePaged(
    key,
    () => filtersToApiParams(parseFilters(new URLSearchParams(key))),
    (p, s) => api.events(p, s),
  );
  const highlight = useJourneyHighlight(params, setParams, page.items);
  const setFilters = (f: Filters) =>
    setParams(highlight.keep(filtersToSearch(f)), { replace: true });
  const filtered = activeFilterCount(filters) > 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Events</h1>
          <p className="lede">
            Recent activity across your connected tools, newest first. Events older than the
            retention window are deleted.
          </p>
        </div>
      </header>

      {connections.data && <GapBanners connections={connections.data.connections} />}
      {connections.error && (
        <div className="callout callout-gap" role="status">
          Could not load connection health ({connections.error.message}), so open observation gaps
          cannot be shown. Data may be missing.
        </div>
      )}

      <FilterBar filters={filters} onChange={setFilters} />
      {highlight.banner}

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
          <EventList items={page.items} decorate={highlight.decorate} />
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
