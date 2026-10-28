import { ScopeNotice, useAccess } from "../access.tsx";
/**
 * Environment matrix (AFE-24), the landing view: services × environments,
 * what is live in each cell, since when, how it got there and how sure Afe
 * is. Built on `GET /api/environments/state` (docs/correlation.md). Rows and
 * columns come from the mapping; targets no rule maps are shown in an
 * explicit "Unmapped" row/column, never guessed. Uncertainty (ambiguous,
 * unknown, weak, observation gaps, a stale computation) is always visible.
 *
 * The open cell is kept in the URL (`/?service=…&environment=…[&target=…]`),
 * so the history panel can be linked to and the back button closes it.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from "react";
import { api } from "../api/client.ts";
import {
  environmentsApi,
  type EnvironmentColumn,
  type EnvironmentStateResponse,
  type MatrixCell,
  type ServiceColumn,
} from "../api/environments.ts";
import {
  Empty,
  ErrorBox,
  GapBanners,
  Loading,
  toolLabel,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { formatDateTime } from "../format.ts";
import { Link, useSearchParams } from "../router.tsx";
import {
  CertaintyBadge,
  certaintyOf,
  GapFlagBadges,
  KindBadge,
  liveLabel,
  TimeAgo,
} from "./environments-ui.tsx";
import { PlacementHistoryPanel } from "./PlacementHistory.tsx";
import "./EnvironmentMatrix.css";

/** How often a stale computation is re-requested (the server throttles recompute to ~2 s). */
const STALE_RETRY_MS = 5000;

const cellKey = (service: string, environment: string) => `${service}\u0000${environment}`;

const LIVE_TYPE: Record<string, string> = {
  commit: "commit",
  image: "image",
  deployment: "deployment",
  config: "",
  none: "",
};

function windowDays(w: EnvironmentStateResponse["window"]): number {
  return Math.max(1, Math.round((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000));
}

function CellButton({
  cell,
  setRef,
  onOpen,
  pos,
  active,
  onFocusPos,
}: {
  cell: MatrixCell;
  setRef: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  pos: [number, number];
  active: boolean;
  onFocusPos: () => void;
}) {
  const p = cell.live;
  const label = liveLabel(p);
  const certainty = certaintyOf(cell.live.attribution);
  const evidence = p.commits[0]?.via ?? p.notes[0];
  const uncertain = certainty.level === "ambiguous" || certainty.level === "unknown";
  const others = cell.targets.length - 1 + cell.targetsOmitted;
  return (
    <button
      type="button"
      ref={setRef}
      className={`env-cell env-cell-${certainty.level}${cell.gap.flagged ? " env-cell-gap" : ""}`}
      data-r={pos[0]}
      data-c={pos[1]}
      tabIndex={active ? 0 : -1}
      onFocus={onFocusPos}
      onClick={onOpen}
    >
      <span className="env-cell-what">
        <code title={label.title}>{label.text}</code>{" "}
        {LIVE_TYPE[label.type] && <span className="muted small">{LIVE_TYPE[label.type]}</span>}
      </span>
      <span className="env-cell-badges">
        <CertaintyBadge attribution={cell.live.attribution} detail={evidence} />
        <KindBadge kind={p.kind} />
      </span>
      <span className="env-cell-since small">
        since <TimeAgo iso={cell.since} />
        {cell.contentSince !== cell.since && (
          <span className="muted" title={formatDateTime(cell.contentSince)}>
            {" "}
            (same content since <TimeAgo iso={cell.contentSince} />)
          </span>
        )}
      </span>
      <span className="env-cell-target small muted">
        {toolLabel(p.source)} · {p.label}
        {others > 0 && ` · +${others} more target${others > 1 ? "s" : ""}`}
      </span>
      {(cell.gap.flagged || !cell.consistent) && (
        <span className="env-cell-flags">
          <GapFlagBadges
            evidenceInGap={cell.gap.evidenceInGap}
            possiblyStale={cell.gap.possiblyStale}
          />
          {!cell.consistent && (
            <span
              className="badge env-inconsistent"
              title="The targets of this cell do not run the same content"
            >
              targets differ
            </span>
          )}
        </span>
      )}
      {uncertain && evidence && (
        <span className="env-cell-note small">
          {evidence.replace(
            /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi,
            (id) => `event ${id.slice(0, 8)}`,
          )}
        </span>
      )}
    </button>
  );
}

function HeaderUnmappedHint({ what }: { what: "service" | "environment" }) {
  return (
    <span className="env-unmapped-hint small">
      Targets no mapping rule assigns to {what === "service" ? "a service" : "an environment"}.{" "}
      <Link to="/settings/mapping">Set up mapping</Link>
    </span>
  );
}

function Matrix({
  data,
  cells,
  selected,
  onOpen,
  cellRefs,
}: {
  data: EnvironmentStateResponse;
  cells: Map<string, MatrixCell>;
  selected: string | null;
  onOpen: (service: ServiceColumn, environment: EnvironmentColumn) => void;
  cellRefs: MutableRefObject<Map<string, HTMLElement>>;
}) {
  const rows = data.services;
  const cols = data.environments;
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const table = useRef<HTMLTableElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-r]");
    if (!el) return;
    let r = Number(el.dataset.r);
    let c = Number(el.dataset.c);
    switch (e.key) {
      case "ArrowRight":
        c++;
        break;
      case "ArrowLeft":
        c--;
        break;
      case "ArrowDown":
        r++;
        break;
      case "ArrowUp":
        r--;
        break;
      case "Home":
        c = 0;
        if (e.ctrlKey) r = 0;
        break;
      case "End":
        c = cols.length - 1;
        if (e.ctrlKey) r = rows.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    r = Math.max(0, Math.min(rows.length - 1, r));
    c = Math.max(0, Math.min(cols.length - 1, c));
    setActive([r, c]);
    table.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)?.focus();
  };

  return (
    <div className="env-scroll">
      <table
        ref={table}
        className="env-matrix"
        role="grid"
        aria-labelledby="env-matrix-caption"
        aria-describedby="env-matrix-help"
        onKeyDown={onKeyDown}
      >
        <caption id="env-matrix-caption" className="env-caption">
          What is live where: services (rows) by environments (columns)
        </caption>
        <thead>
          <tr role="row">
            <th scope="col" role="columnheader" className="env-corner">
              Service
            </th>
            {cols.map((env) => (
              <th
                key={env.id}
                scope="col"
                role="columnheader"
                className={env.unmapped ? "env-unmapped" : undefined}
              >
                <span className="env-col-name">{env.name}</span>
                {env.unmapped ? (
                  <HeaderUnmappedHint what="environment" />
                ) : (
                  env.kind !== "other" &&
                  env.kind !== env.name.toLowerCase() && (
                    <span className="muted small"> {env.kind}</span>
                  )
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((svc, r) => (
            <tr key={svc.id} role="row" className={svc.unmapped ? "env-row-unmapped" : undefined}>
              <th scope="row" role="rowheader" className="env-rowhead">
                <span className="env-row-name">{svc.name}</span>
                {svc.unmapped && <HeaderUnmappedHint what="service" />}
              </th>
              {cols.map((env, c) => {
                const k = cellKey(svc.id, env.id);
                const cell = cells.get(k);
                const isActive = active[0] === r && active[1] === c;
                const isSelected = selected === k;
                if (!cell) {
                  return (
                    <td
                      key={env.id}
                      role="gridcell"
                      className="env-empty"
                      data-r={r}
                      data-c={c}
                      tabIndex={isActive ? 0 : -1}
                      onFocus={() => setActive([r, c])}
                    >
                      <span aria-hidden="true">–</span>
                      <span className="env-sr">Nothing seen live</span>
                    </td>
                  );
                }
                return (
                  <td
                    key={env.id}
                    role="gridcell"
                    aria-selected={isSelected}
                    className={`env-cellwrap${isSelected ? " env-selected" : ""}`}
                  >
                    <CellButton
                      cell={cell}
                      pos={[r, c]}
                      active={isActive}
                      onFocusPos={() => setActive([r, c])}
                      setRef={(el) => {
                        if (el) cellRefs.current.set(k, el);
                        else cellRefs.current.delete(k);
                      }}
                      onOpen={() => onOpen(svc, env)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p id="env-matrix-help" className="env-sr">
        Use the arrow keys to move between cells, Home and End for the first and last environment.
        Press Enter on a cell for its placement history.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <details className="env-legend small">
      <summary>How to read this</summary>
      <dl className="kv">
        <div>
          <dt>What is live</dt>
          <dd>
            The app commit the live content traces to; otherwise the image or deployment id. Hover
            for the full value, open a cell for the evidence.
          </dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>
            <span className="badge conf conf-certain">certain</span> same deployment, run or commit;{" "}
            <span className="badge conf conf-strong">strong</span> same image digest or deployment
            URL; <span className="badge conf conf-probable">probable</span> image tag or GitOps
            reference; <span className="badge conf conf-weak">weak</span> mutable tag or timing
            only; <span className="badge conf conf-ambiguous">ambiguous</span> several candidate
            commits; <span className="badge conf conf-unknown">unknown</span> nothing traces to a
            commit (e.g. an image no observed build produced).
          </dd>
        </div>
        <div>
          <dt>How it got there</dt>
          <dd>
            <span className="badge kind kind-deploy">deploy</span>{" "}
            <span className="badge kind kind-promotion">promotion</span>{" "}
            <span className="badge kind kind-rollback">rollback</span>{" "}
            <span className="badge kind kind-redeploy">redeploy</span>{" "}
            <span className="badge kind kind-manual">manual</span>
          </dd>
        </div>
        <div>
          <dt>Gaps</dt>
          <dd>
            <span className="badge gap-badge">evidence in a gap</span> something this relies on
            happened while its tool was not observed;{" "}
            <span className="badge gap-badge">possibly stale</span> the tool cannot be observed
            right now, so a later deployment may be missing.
          </dd>
        </div>
      </dl>
    </details>
  );
}

function EmptyMatrix({ connected, days }: { connected: boolean | null; days: number }) {
  const { managed } = useAccess();
  if (managed)
    return (
      <Empty title="No permitted deployments">
        <p>
          Open your <Link to="/profile">profile</Link> to link assigned tool accounts, or contact
          your administrator for resource access.
        </p>
      </Empty>
    );
  return (
    <Empty
      title={
        connected === false
          ? "Connect your tools to see what is live where"
          : `Nothing was deployed in the last ${days} days`
      }
    >
      <p>
        This page shows, per service and environment, what is live, since when, how it got there and
        how sure Afe is. It fills in from the deployments your connected tools report.
      </p>
      <ol className="env-setup">
        <li>
          <strong>Connect your tools.</strong> <Link to="/connections/github">GitHub</Link> (pushes,
          CI, deployments and packages), <Link to="/connections/argocd">ArgoCD</Link> (syncs) and{" "}
          <Link to="/connections/vercel">Vercel</Link> (deployments). See{" "}
          <Link to="/connections">connections</Link>.
        </li>
        <li>
          <strong>Set up the mapping.</strong> <Link to="/settings/mapping">Mapping</Link> decides
          which service and environment each ArgoCD application, Vercel project or GitHub
          environment belongs to. Anything not mapped is shown in an “Unmapped” row, never guessed.
        </li>
        <li>
          <strong>Deploy.</strong> The next deployment, sync or rollback appears here. Recent
          activity is also on the <Link to="/events">event timeline</Link>.
        </li>
      </ol>
    </Empty>
  );
}

export function EnvironmentMatrix() {
  useDocumentTitle("Environments");
  const [params, setParams] = useSearchParams();
  const state = useAsync((s) => environmentsApi.state(s), []);
  const connections = useAsync((s) => api.connections(s), []);
  const cellRefs = useRef(new Map<string, HTMLElement>());

  const data = state.data;
  const { reload } = state;
  useEffect(() => {
    if (!data?.window.stale) return;
    const t = setTimeout(reload, STALE_RETRY_MS);
    return () => clearTimeout(t);
  }, [data, reload]);

  const cells = useMemo(
    () => new Map((data?.cells ?? []).map((c) => [cellKey(c.service, c.environment), c])),
    [data],
  );

  const selService = params.get("service");
  const selEnv = params.get("environment");
  const selTarget = params.get("target");
  const selected = selService && selEnv ? cellKey(selService, selEnv) : null;

  const open = useCallback(
    (svc: ServiceColumn, env: EnvironmentColumn) => {
      const next = new URLSearchParams(params);
      next.set("service", svc.id);
      next.set("environment", env.id);
      next.delete("target");
      setParams(next);
    },
    [params, setParams],
  );
  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("service");
    next.delete("environment");
    next.delete("target");
    setParams(next);
    if (selected) cellRefs.current.get(selected)?.focus();
  }, [params, setParams, selected]);
  const setTarget = useCallback(
    (t: string | null) => {
      const next = new URLSearchParams(params);
      if (t) next.set("target", t);
      else next.delete("target");
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const counts = useMemo(() => {
    const list = data?.cells ?? [];
    return {
      uncertain: list.filter((c) => c.status !== "attributed" || c.confidence === "weak").length,
      gaps: list.filter((c) => c.gap.flagged).length,
      unmapped: list.filter((c) => c.unmapped).length,
    };
  }, [data]);

  const nameOf = (list: { id: string; name: string }[] | undefined, id: string) =>
    list?.find((x) => x.id === id)?.name ?? (id === "_unmapped" ? "Unmapped" : id);
  const panelTitle =
    selService && selEnv
      ? `${nameOf(data?.services, selService)} in ${nameOf(data?.environments, selEnv)}`
      : "";
  const connected = connections.data ? connections.data.connections.length > 0 : null;
  const noMappingYet =
    data !== null &&
    data.cells.length > 0 &&
    data.services.every((s) => s.unmapped) &&
    data.environments.every((e) => e.unmapped);

  return (
    <div className="page env-page">
      <header className="page-header">
        <div>
          <h1>Environments</h1>
          <p className="lede">
            What is live where, since when, how it got there, and how sure Afe is.
          </p>
        </div>
        <div className="toolbar">
          {data && state.loading && <span className="muted small">Refreshing…</span>}
          <button type="button" className="btn" onClick={reload} disabled={state.loading}>
            Refresh
          </button>
        </div>
      </header>
      <ScopeNotice />

      {connections.data && <GapBanners connections={connections.data.connections} />}

      {!data && state.loading ? (
        <Loading label="Loading environments…" />
      ) : !data && state.error ? (
        <ErrorBox error={state.error} onRetry={reload} title="Could not load environments" />
      ) : data ? (
        <>
          {state.error && (
            <ErrorBox error={state.error} onRetry={reload} title="Could not refresh" />
          )}
          <p className="small muted env-freshness">
            Reflects events up to <span className="env-seq">#{data.window.asOfSeq}</span>, computed{" "}
            <TimeAgo iso={data.window.computedAt} /> from the last {windowDays(data.window)} days (
            {data.window.events} events since{" "}
            <time dateTime={data.window.from}>{formatDateTime(data.window.from)}</time>).
          </p>
          {data.window.stale && (
            <p className="callout callout-gap small" role="status">
              <strong>Not up to date:</strong> newer events have arrived that this view does not
              reflect yet. It refreshes automatically in a few seconds.
            </p>
          )}
          {data.window.truncated && (
            <p className="callout callout-gap small" role="status">
              <strong>Partial:</strong> this tenant has more events than Afe correlates at once; the
              oldest were left out, so older placements and history may be missing.
            </p>
          )}
          {data.cells.length === 0 ? (
            <EmptyMatrix connected={connected} days={windowDays(data.window)} />
          ) : (
            <>
              {noMappingYet && (
                <p className="callout small">
                  No services or environments are set up yet, so everything is in “Unmapped”.{" "}
                  <Link to="/settings/mapping">Set up the mapping</Link> to get one row per service
                  and one column per environment.
                </p>
              )}
              <ul className="inline-list small env-summary" aria-label="Summary">
                <li>
                  <strong>{data.cells.length}</strong> live placements
                </li>
                <li>
                  <strong>{counts.uncertain}</strong> weak, ambiguous or unknown
                </li>
                <li>
                  <strong>{counts.gaps}</strong> flagged by observation gaps
                </li>
                {counts.unmapped > 0 && (
                  <li>
                    <strong>{counts.unmapped}</strong> unmapped
                  </li>
                )}
              </ul>
              <div className={`env-layout${selected ? " env-layout-open" : ""}`}>
                <Matrix
                  data={data}
                  cells={cells}
                  selected={selected}
                  onOpen={open}
                  cellRefs={cellRefs}
                />
                {selService && selEnv && (
                  <PlacementHistoryPanel
                    key={selected!}
                    service={selService}
                    environment={selEnv}
                    cell={cells.get(selected!) ?? null}
                    title={panelTitle}
                    target={selTarget}
                    onTarget={setTarget}
                    onClose={close}
                  />
                )}
              </div>
              <Legend />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
