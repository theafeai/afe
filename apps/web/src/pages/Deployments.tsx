import { api } from "../api/client.ts";
import type { DeploymentRow } from "../api/types.ts";
import {
  Empty,
  ErrorBox,
  Loading,
  MethodBadge,
  OutcomeBadge,
  ToolBadge,
  useDocumentTitle,
} from "../components.tsx";
import { FilterBar } from "../FilterBar.tsx";
import {
  activeFilterCount,
  filtersToApiParams,
  filtersToSearch,
  parseFilters,
} from "../filters.ts";
import { formatDateTime, humanize } from "../format.ts";
import { Link, useSearchParams } from "../router.tsx";
import { usePaged } from "../usePaged.ts";

function who(r: DeploymentRow) {
  const w = r.who;
  const main = w.login ?? w.name ?? w.id ?? w.type;
  const obo = w.onBehalfOf ? (w.onBehalfOf.login ?? w.onBehalfOf.id) : null;
  return obo ? `${main} for ${obo}` : main;
}

function what(r: DeploymentRow) {
  const sha = r.what.commitShas[0];
  const ref = r.what.refs[0]?.replace(/^refs\/(heads|tags)\//, "");
  const img = r.what.imageRefs[0];
  return [sha ? sha.slice(0, 7) : null, ref, img].filter(Boolean).join(" · ") || "—";
}

function where(r: DeploymentRow) {
  const w = r.where;
  const thing = w.application ?? w.project ?? w.targetName ?? w.repository ?? w.targetId;
  return { thing, env: w.environment, cluster: w.cluster };
}

export function Deployments() {
  useDocumentTitle("Deployments");
  const [params, setParams] = useSearchParams();
  const filters = parseFilters(params);
  const key = filtersToSearch(filters).toString();
  const page = usePaged(
    key,
    () => filtersToApiParams(parseFilters(new URLSearchParams(key))),
    (p, s) => api.deployments(p, s),
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Deployments</h1>
          <p className="lede">
            Who deployed what, to where, and when — across your available tools.
          </p>
        </div>
      </header>
      <FilterBar
        filters={filters}
        onChange={(f) => setParams(filtersToSearch(f), { replace: true })}
      />
      {page.loading ? (
        <Loading label="Loading deployments…" />
      ) : page.error && page.items.length === 0 ? (
        <ErrorBox error={page.error} onRetry={page.reload} title="Could not load deployments" />
      ) : page.items.length === 0 ? (
        <Empty
          title={
            activeFilterCount(filters)
              ? "No deployments match these filters"
              : "No deployments recorded yet"
          }
        >
          <p>
            Deployments appear here once a connected tool reports one. See{" "}
            <Link to="/connections">connections</Link>.
          </p>
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">Where</th>
                  <th scope="col">How</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((r) => {
                  const w = where(r);
                  const late =
                    r.provenance.method === "reconciliation" || r.provenance.method === "backfill";
                  return (
                    <tr key={r.eventId} className={late ? `row-${r.provenance.method}` : undefined}>
                      <td>
                        <Link to={`/events/${r.eventId}`}>
                          <time dateTime={r.when}>{formatDateTime(r.when)}</time>
                        </Link>
                      </td>
                      <td>{who(r)}</td>
                      <td>
                        <code>{what(r)}</code>
                      </td>
                      <td>
                        {w.thing}
                        {w.env && (
                          <>
                            {" "}
                            → <strong>{w.env}</strong>
                          </>
                        )}
                        {w.cluster && <span className="muted"> ({w.cluster})</span>}
                        {r.placement && (
                          <div className="small">
                            <span className={r.placement.service ? undefined : "muted"}>
                              {r.placement.service?.name ?? "unmapped service"}
                            </span>{" "}
                            ·{" "}
                            <span className={r.placement.environment ? undefined : "muted"}>
                              {r.placement.environment?.name ?? "unmapped environment"}
                            </span>
                          </div>
                        )}
                      </td>
                      <td>
                        <ToolBadge source={r.source} /> {humanize(r.how.type)}
                      </td>
                      <td>
                        <span className="muted small">{r.action}</span>{" "}
                        <OutcomeBadge outcome={r.outcome} />{" "}
                        <MethodBadge method={r.provenance.method} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
              {page.loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
