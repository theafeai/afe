import type { CanonicalEvent } from "@afe/core/types";
import { ApiError } from "../api/client.ts";
import { fetchContainment, type Contained } from "../api/containment.ts";
import { ErrorBox, Loading, ToolBadge, useAsync } from "../components.tsx";
import { formatDateTime, shortHash } from "../format.ts";
import { Link } from "../router.tsx";

/**
 * The GitHub repository ("owner/name") and commit an event is about, when it
 * names both: the first github.com repository and the first commit SHA.
 */
export function containmentSubject(
  e: Pick<CanonicalEvent, "correlation">,
): { repository: string; commit: string } | null {
  const repo = (e.correlation.repositories ?? []).find((r) => r.startsWith("github.com/"));
  const commit = e.correlation.commitShas?.[0];
  if (!repo || !commit) return null;
  return { repository: repo.slice("github.com/".length), commit };
}

function ContainedBadge({ value }: { value: Contained }) {
  if (value === true) return <span className="badge outcome outcome-succeeded">Included</span>;
  if (value === false) return <span className="badge outcome outcome-failed">Not included</span>;
  return <span className="badge">Unknown</span>;
}

/** "Where is this commit live?" (AFE-22), for events with a commit and a GitHub repository. */
export function ContainmentPanel({ repository, commit }: { repository: string; commit: string }) {
  const { data, error, loading, reload } = useAsync(
    (s) => fetchContainment(repository, commit, s),
    [repository, commit],
  );
  return (
    <section className="card" aria-labelledby="containment-heading">
      <h2 id="containment-heading">Where is this commit live?</h2>
      <p className="small muted">
        Commit <code>{shortHash(commit)}</code> of <code>{repository}</code>, compared with the
        commit currently live in each environment (GitHub compare API).
      </p>
      {loading ? (
        <Loading label="Checking environments…" />
      ) : error ? (
        error instanceof ApiError && error.status === 404 ? (
          <p className="muted">
            Afe has no recent deployments of this repository and no GitHub connection for it.
          </p>
        ) : (
          <ErrorBox error={error} onRetry={reload} title="Could not check where this commit is" />
        )
      ) : data && data.environments.length === 0 ? (
        <p className="muted">
          This repository is not live in any environment Afe has seen recently.
        </p>
      ) : data ? (
        <>
          {data.partial && (
            <div className="callout" role="note">
              <strong>Partial answer.</strong> Some environments could not be checked in this
              request.
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Environment</th>
                  <th scope="col">Live commit</th>
                  <th scope="col">Live since</th>
                  <th scope="col">This commit</th>
                  <th scope="col">Why</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {data.environments.map((env) => (
                  <tr key={`${env.environmentId ?? ""}:${env.environment}`}>
                    <td>
                      {env.environment} <ToolBadge source={env.source} />
                    </td>
                    <td>{env.liveCommit ? <code>{shortHash(env.liveCommit)}</code> : "—"}</td>
                    <td>
                      <time dateTime={env.liveSince}>{formatDateTime(env.liveSince)}</time>
                    </td>
                    <td>
                      <ContainedBadge value={env.contained} />
                    </td>
                    <td className="small">{env.reason}</td>
                    <td>
                      {env.evidence.slice(0, 1).map((id) => (
                        <Link key={id} to={`/events/${id}`}>
                          deployment event
                        </Link>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.notes.length > 0 && (
            <ul className="small muted">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
