/**
 * Placement history of one matrix cell (AFE-24): how what is live got
 * there, newest first, paginated. Each step links to its event and, for
 * commits, to the commit's journey (AFE-25).
 */
import { useEffect, useRef, useState } from "react";
import {
  environmentsApi,
  type HistoryItem,
  type HistoryResponse,
  type MatrixCell,
} from "../api/environments.ts";
import { ErrorBox, Loading, ToolBadge, toolLabel } from "../components.tsx";
import { humanize } from "../format.ts";
import { Link } from "../router.tsx";
import { usePaged } from "../usePaged.ts";
import {
  CertaintyBadge,
  ConfidenceBadge,
  GapList,
  howText,
  KindBadge,
  PlacementContent,
  TimeAgo,
} from "./environments-ui.tsx";

const CHANGE_LABEL: Record<HistoryItem["change"], string> = {
  first: "first seen",
  new_content: "new content",
  same_content: "same content (restart or redeploy)",
};

export const HISTORY_PAGE_SIZE = 20;

function Step({ item, multiTarget }: { item: HistoryItem; multiTarget: boolean }) {
  const p = item.placement;
  const detail = p.commits[0]?.via ?? p.notes[0];
  return (
    <li className={`env-step${item.current ? " env-step-current" : ""}`}>
      <div className="env-step-head">
        <Link to={`/events/${item.event.id}`} className="env-step-time">
          <TimeAgo iso={p.at} />
        </Link>
        <KindBadge kind={p.kind} />
        <CertaintyBadge attribution={p.attribution} detail={detail} />
        {item.current && <span className="badge env-current">live now</span>}
        <span className="muted small">{CHANGE_LABEL[item.change]}</span>
      </div>
      <div className="small">
        <code>{item.event.action}</code> · {howText(p)}
        {multiTarget && (
          <>
            {" "}
            · <ToolBadge source={item.target.source} /> {item.target.label}
          </>
        )}
      </div>
      <PlacementContent p={p} />
      <GapList gaps={p.gaps} />
      {item.causes.length > 0 && (
        <details className="env-causes">
          <summary className="small">
            Linked earlier events ({item.causes.length}): what led to this
          </summary>
          <ul className="plain small">
            {item.causes.map((c) => (
              <li key={c.event.id}>
                <span className="muted">{c.stage}</span>{" "}
                <Link to={`/events/${c.event.id}`}>
                  <code>{c.event.action}</code>
                </Link>{" "}
                {toolLabel(c.event.source)} · {c.event.target.label}
                {c.event.actor ? ` · ${c.event.actor}` : ""} · <TimeAgo iso={c.event.at} />{" "}
                <ConfidenceBadge confidence={c.confidence} />{" "}
                <span className="muted">{c.evidence.map((e) => humanize(e.kind)).join(", ")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export function PlacementHistoryPanel({
  service,
  environment,
  cell,
  title,
  target,
  onTarget,
  onClose,
}: {
  service: string;
  environment: string;
  /** The cell as shown in the matrix (absent when opened by URL for an empty cell). */
  cell: MatrixCell | null;
  title: string;
  target: string | null;
  onTarget: (target: string | null) => void;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<HistoryResponse | null>(null);
  const key = `${service}/${environment}/${target ?? ""}`;
  const page = usePaged<HistoryItem>(
    key,
    () => new URLSearchParams(target ? { target } : {}),
    async (params, signal) => {
      const res = await environmentsApi.history(service, environment, params, signal);
      setMeta(res);
      return { items: res.items, nextCursor: res.nextCursor, snapshotSeq: res.window.asOfSeq };
    },
    HISTORY_PAGE_SIZE,
  );
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [service, environment]);

  const targets = meta?.targets ?? [];
  const multiTarget = targets.length > 1 || (cell?.targets.length ?? 0) > 1;

  return (
    <aside
      className="env-panel card"
      aria-labelledby="env-panel-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="env-panel-head">
        <div>
          <p className="muted small env-panel-kicker">How it got here</p>
          <h2 id="env-panel-title" ref={heading} tabIndex={-1}>
            {title}
          </h2>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
          aria-label="Close placement history"
        >
          Close
        </button>
      </div>
      {cell && !cell.consistent && (
        <p className="callout callout-gap small">
          The targets of this cell do not run the same content right now.
        </p>
      )}
      {multiTarget && (
        <div className="field env-target-filter">
          <label htmlFor="env-target">Target</label>
          <select
            id="env-target"
            value={target ?? ""}
            onChange={(e) => onTarget(e.target.value || null)}
          >
            <option value="">All targets</option>
            {targets.map((t) => (
              <option key={t.key} value={t.key}>
                {toolLabel(t.source)}: {t.label} ({t.toolEnvironment}, {t.placements})
              </option>
            ))}
          </select>
        </div>
      )}
      {page.loading ? (
        <Loading label="Loading placement history…" />
      ) : page.error && page.items.length === 0 ? (
        <ErrorBox error={page.error} onRetry={page.reload} title="Could not load the history" />
      ) : page.items.length === 0 ? (
        <p className="muted">No placements recorded for this cell in the retention window.</p>
      ) : (
        <>
          <p className="small muted" aria-live="polite">
            {page.items.length} of {meta?.total ?? page.items.length} placements, newest first
          </p>
          <ol className="env-steps">
            {page.items.map((item) => (
              <Step key={item.event.id} item={item} multiTarget={multiTarget} />
            ))}
          </ol>
          {page.error && (
            <ErrorBox error={page.error} onRetry={page.loadMore} title="Could not load more" />
          )}
          {page.hasMore && (
            <button
              type="button"
              className="btn btn-wide"
              onClick={page.loadMore}
              disabled={page.loadingMore}
            >
              {page.loadingMore ? "Loading…" : "Load older placements"}
            </button>
          )}
        </>
      )}
    </aside>
  );
}
