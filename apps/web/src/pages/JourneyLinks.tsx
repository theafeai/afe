/**
 * Journey links on the event detail page (AFE-25): the journey of the
 * event's own commit and, for placements (deploys, syncs), of the commits its
 * live content is attributed to (`GET /api/events/:id/links`).
 */
import type { CanonicalEvent } from "@afe/core/types";
import {
  displayRepository,
  fetchEventLinks,
  journeyPath,
  journeySubject,
} from "../api/journeys.ts";
import { useAsync } from "../components.tsx";
import { Link } from "../router.tsx";
import { ConfidenceBadge } from "./Journey.tsx";
import { highlightValue } from "./JourneyHighlight.tsx";
import { shortSha } from "./journey-model.ts";

export function JourneyLinks({ event }: { event: CanonicalEvent }) {
  const own = journeySubject(event);
  const links = useAsync((s) => fetchEventLinks(event.id, s), [event.id]);
  const placement = links.data?.placement ?? null;
  const attributed = (placement?.commits ?? []).filter(
    (c) => c.repository && !(own && c.commitSha === own.commit),
  );
  if (!own && attributed.length === 0 && !links.loading && !links.data?.total) return null;
  return (
    <section className="card journey-links" aria-labelledby="journey-links-heading">
      <h2 id="journey-links-heading">Journey</h2>
      <ul>
        {own && (
          <li>
            Where commit <code>{shortSha(own.commit)}</code> of <code>{own.repository}</code> went:{" "}
            <Link to={journeyPath(own.repository, own.commit)}>view journey</Link> ·{" "}
            <Link
              to={`/events?${new URLSearchParams({ journey: highlightValue(own.repository, own.commit) }).toString()}`}
            >
              highlight in timeline
            </Link>
          </li>
        )}
        {attributed.map((c) => (
          <li key={`${c.repository}@${c.commitSha}`}>
            {placement?.current ? "Live content" : "Content deployed here"} is attributed to{" "}
            <Link to={journeyPath(c.repository!, c.commitSha)}>
              <code>
                {displayRepository(c.repository!)}@{shortSha(c.commitSha)}
              </code>
            </Link>{" "}
            <ConfidenceBadge value={c.confidence} /> <span className="small muted">{c.via}</span>
          </li>
        ))}
        {placement && placement.commits.length === 0 && (
          <li className="muted">
            What this placement made live is not attributed to any commit (
            {placement.attribution.status})
            {placement.notes.length > 0 && `: ${placement.notes.join("; ")}`}.
          </li>
        )}
      </ul>
      {links.data && links.data.total > 0 && (
        <p className="small muted">
          Linked to {links.data.total} other event{links.data.total === 1 ? "" : "s"} by shared
          identifiers (commits, runs, images, deployments).
        </p>
      )}
    </section>
  );
}
