/**
 * "Highlight journey" on the timeline (AFE-25). URL-driven:
 * `/events?journey=owner/name@<sha>` loads the commit's journey (the link
 * graph walked from the commit, `GET /api/journeys`) and marks the events on
 * it; every other event is dimmed. Events the journey ruled out are marked
 * as such. Filters keep working; the parameter is kept when they change.
 */
import type { ReactNode } from "react";
import { ApiError } from "../api/client.ts";
import { fetchJourney, journeyPath, journeySubject, type Journey } from "../api/journeys.ts";
import type { EventItem } from "../api/types.ts";
import { useAsync } from "../components.tsx";
import { Link } from "../router.tsx";
import { shortSha } from "./journey-model.ts";
import "./Journey.css";

export const HIGHLIGHT_PARAM = "journey";

export type RowHighlight = "on" | "dim" | "excluded";

export interface RowDecoration {
  highlight?: RowHighlight;
  action?: ReactNode;
}

/** `owner/name@sha` → parts (the repository may contain `@` only before the last one). */
export function parseHighlight(
  value: string | null,
): { repository: string; commit: string } | null {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const repository = value.slice(0, at).trim();
  const commit = value
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!repository || !/^[0-9a-f]{7,64}$/.test(commit)) return null;
  return { repository, commit };
}

export function highlightValue(repository: string, commit: string): string {
  return `${repository}@${commit}`;
}

/** Event ids on a journey (steps and placements) and the ones it excluded. */
export function journeyEventIds(j: Journey): { on: Set<string>; excluded: Map<string, string> } {
  const on = new Set<string>(j.steps.map((s) => s.eventId));
  for (const e of j.environments) on.add(e.placementEventId);
  const excluded = new Map(j.excluded.map((x) => [x.eventId, x.reason]));
  return { on, excluded };
}

/** First and last event time of a journey (steps, placements, excluded), widened by a minute. */
export function journeySpan(j: Journey): { from: string; to: string } {
  const times = [
    ...j.steps.map((s) => s.event.at),
    ...j.environments.map((e) => e.event.at),
    ...j.excluded.map((x) => x.event.at),
  ].map((t) => Date.parse(t));
  const min = Math.min(...times);
  const max = Math.max(...times);
  return {
    from: new Date(min - 60_000).toISOString(),
    to: new Date(max + 60_000).toISOString(),
  };
}

export function useJourneyHighlight(
  params: URLSearchParams,
  setParams: (next: URLSearchParams, options?: { replace?: boolean }) => void,
  /** Events loaded on the page, to say how many of the journey's are visible. */
  loaded: EventItem[] = [],
): {
  banner: ReactNode;
  decorate: (item: EventItem) => RowDecoration;
  /** Re-adds the highlight to a new query (when filters change). */
  keep: (next: URLSearchParams) => URLSearchParams;
} {
  const raw = params.get(HIGHLIGHT_PARAM);
  const subject = parseHighlight(raw);
  const res = useAsync(
    (s) =>
      subject ? fetchJourney(subject.repository, subject.commit, {}, s) : Promise.resolve(null),
    [subject?.repository, subject?.commit],
  );
  const ids = res.data ? journeyEventIds(res.data.journey) : null;
  const fullSha = res.data?.journey.commitSha ?? subject?.commit ?? null;

  const set = (value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(HIGHLIGHT_PARAM, value);
    else next.delete(HIGHLIGHT_PARAM);
    setParams(next, { replace: true });
  };

  const keep = (next: URLSearchParams) => {
    if (raw) next.set(HIGHLIGHT_PARAM, raw);
    return next;
  };

  let banner: ReactNode = null;
  if (raw && !subject) {
    banner = (
      <div className="callout highlight-banner" role="status">
        <span>
          Cannot highlight <code>{raw}</code>: expected <code>owner/name@commit</code>.
        </span>
        <button type="button" className="btn" onClick={() => set(null)}>
          Clear highlight
        </button>
      </div>
    );
  } else if (subject) {
    const label = (
      <code>
        {subject.repository}@{shortSha(fullSha ?? subject.commit)}
      </code>
    );
    banner = (
      <div className="callout highlight-banner" role="status" data-testid="highlight-banner">
        <span>
          {res.loading ? (
            <>Loading the journey of {label}…</>
          ) : res.error ? (
            res.error instanceof ApiError && res.error.status === 404 ? (
              <>No event in the retention window carries {label}; nothing to highlight.</>
            ) : (
              <>
                Could not load the journey of {label} ({res.error.message}).
              </>
            )
          ) : ids ? (
            <>
              Highlighting the journey of {label}: {ids.on.size} related event
              {ids.on.size === 1 ? "" : "s"}
              {ids.excluded.size > 0 && `, ${ids.excluded.size} ruled out`} (
              {loaded.filter((it) => ids.on.has(it.event.id)).length} loaded below). Other events
              are dimmed.
            </>
          ) : null}
        </span>
        <span className="button-row">
          {res.data && (
            <button
              type="button"
              className="btn"
              title="Limit the timeline to the time between the journey's first and last event"
              onClick={() => {
                const span = journeySpan(res.data!.journey);
                const next = new URLSearchParams(params);
                next.delete("range");
                next.set("from", span.from);
                next.set("to", span.to);
                setParams(next, { replace: true });
              }}
            >
              Show its time span
            </button>
          )}
          <Link className="btn" to={journeyPath(subject.repository, fullSha ?? subject.commit)}>
            View journey
          </Link>
          <button type="button" className="btn" onClick={() => set(null)}>
            Clear highlight
          </button>
        </span>
      </div>
    );
  }

  const decorate = (item: EventItem): RowDecoration => {
    const e = item.event;
    let highlight: RowHighlight | undefined;
    if (ids) highlight = ids.on.has(e.id) ? "on" : ids.excluded.has(e.id) ? "excluded" : "dim";
    const own = journeySubject(e);
    let action: ReactNode;
    if (own) {
      const same =
        subject !== null &&
        own.repository.toLowerCase() === subject.repository.toLowerCase() &&
        own.commit.startsWith(subject.commit);
      action = same ? (
        <Link className="btn" to={journeyPath(own.repository, own.commit)}>
          View journey
        </Link>
      ) : (
        <button
          type="button"
          className="btn"
          title={`Highlight the events linked to commit ${shortSha(own.commit)}`}
          onClick={() => set(highlightValue(own.repository, own.commit))}
        >
          Highlight journey
        </button>
      );
    }
    return { highlight, action };
  };

  return { banner, decorate, keep };
}
