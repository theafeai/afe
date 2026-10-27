/**
 * Per-commit journey (AFE-25): change → CI → artifact → config → deploy →
 * runtime, with the confidence and evidence of every edge, where the commit
 * went, what was ruled out and what it continues as.
 * Route: `/journeys?repository=owner/name&commit=<sha or unique prefix>`
 * (`view=diagram|list|placements`, `containment=1` to ask GitHub whether
 * later live commits include this one). Data: `GET /api/journeys`.
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api/client.ts";
import {
  CONFIDENCE_ORDER,
  displayRepository,
  fetchEnvironmentState,
  fetchJourney,
  journeyPath,
  type Confidence,
  type EnvironmentStateLite,
  type EventSummary,
  type Journey,
  type JourneyResponse,
  type JourneyStep,
} from "../api/journeys.ts";
import {
  Empty,
  ErrorBox,
  Loading,
  OutcomeBadge,
  ToolBadge,
  gapReason,
  toolLabel,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { formatDateTime, formatRelative, humanize } from "../format.ts";
import { Link, useSearchParams } from "../router.tsx";
import {
  CARD_H,
  CARD_W,
  CONFIDENCE_HELP,
  RELATION_LABEL,
  STAGE_LABEL,
  VIA_LABEL,
  WHERE_LABEL,
  evidenceText,
  layoutJourney,
  prefersPlacementList,
  shortSha,
  whereItWent,
  type EdgePath,
  type WhereRow,
} from "./journey-model.ts";
import "./Journey.css";

export type JourneyView = "diagram" | "list" | "placements";
const VIEWS: { id: JourneyView; label: string }[] = [
  { id: "diagram", label: "Diagram" },
  { id: "list", label: "Step list" },
  { id: "placements", label: "Placements" },
];

export function ConfidenceBadge({ value, title }: { value: Confidence | null; title?: string }) {
  if (!value) return <span className="badge conf conf-none">no confidence</span>;
  return (
    <span className={`badge conf conf-${value}`} title={title ?? CONFIDENCE_HELP[value]}>
      {value}
    </span>
  );
}

function EventLink({ e, children }: { e: EventSummary; children?: ReactNode }) {
  return <Link to={`/events/${e.id}`}>{children ?? <code>{e.action}</code>}</Link>;
}

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={at}>
      {formatDateTime(at)}
    </time>
  );
}

// --- Page ----------------------------------------------------------------------

export function JourneyPage() {
  const [params, setParams] = useSearchParams();
  const repository = params.get("repository")?.trim() ?? "";
  const commit = params.get("commit")?.trim().toLowerCase() ?? "";
  const containment = params.get("containment") === "1";
  const viewParam = params.get("view");
  useDocumentTitle(commit ? `Journey ${commit.slice(0, 7)}` : "Journey");

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };

  if (!repository || !commit) return <JourneyForm repository={repository} commit={commit} />;
  return (
    <JourneyLoader
      key={`${repository}@${commit}`}
      repository={repository}
      commit={commit}
      containment={containment}
      view={VIEWS.some((v) => v.id === viewParam) ? (viewParam as JourneyView) : null}
      onView={(v) => setParam("view", v)}
      onContainment={() => setParam("containment", "1")}
    />
  );
}

function JourneyForm({ repository, commit }: { repository: string; commit: string }) {
  const [, setParams] = useSearchParams();
  const [repo, setRepo] = useState(repository);
  const [sha, setSha] = useState(commit);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (repo.trim() && sha.trim())
      setParams(new URLSearchParams({ repository: repo.trim(), commit: sha.trim() }));
  };
  return (
    <div className="page narrow">
      <header className="page-header">
        <div>
          <h1>Commit journey</h1>
          <p className="lede">
            Where a commit went: change → CI → artifact → config → deploy → runtime, with how sure
            Afe is about every step. Open one from the timeline or an event, or enter a commit.
          </p>
        </div>
      </header>
      <form className="form card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="journey-repo">Repository</label>
          <input
            id="journey-repo"
            placeholder="owner/name"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="journey-commit">Commit SHA (at least 7 characters)</label>
          <input
            id="journey-commit"
            placeholder="4f2c9b8"
            value={sha}
            onChange={(e) => setSha(e.target.value)}
          />
        </div>
        <div className="button-row">
          <button type="submit" className="btn btn-primary">
            Show journey
          </button>
        </div>
      </form>
    </div>
  );
}

function JourneyLoader(props: {
  repository: string;
  commit: string;
  containment: boolean;
  view: JourneyView | null;
  onView: (v: JourneyView) => void;
  onContainment: () => void;
}) {
  const { repository, commit, containment } = props;
  const res = useAsync(
    (s) => fetchJourney(repository, commit, { containment }, s),
    [repository, commit, containment],
  );
  const services = useMemo(
    () =>
      [
        ...new Set(
          (res.data?.journey.environments ?? [])
            .map((e) => e.service)
            .filter((s) => s !== "_unmapped"),
        ),
      ].slice(0, 3),
    [res.data],
  );
  const state = useAsync(
    async (s): Promise<EnvironmentStateLite | null> => {
      if (services.length === 0) return null;
      const parts = await Promise.all(
        services.map((id) => fetchEnvironmentState(id, s).catch(() => null)),
      );
      const ok = parts.filter((p): p is EnvironmentStateLite => p !== null);
      if (ok.length === 0) return null;
      return {
        window: ok[0]!.window,
        services: ok.flatMap((p) => p.services),
        environments: ok[0]!.environments,
        cells: ok.flatMap((p) => p.cells),
      };
    },
    [services.join(",")],
  );

  const back = (
    <p>
      <Link to="/events">← Events</Link>
    </p>
  );
  if (res.loading && !res.data)
    return (
      <div className="page">
        {back}
        <Loading label="Following the commit…" />
      </div>
    );
  if (res.error) {
    const err = res.error;
    const candidates =
      err instanceof ApiError && Array.isArray(err.body?.candidates)
        ? (err.body.candidates as string[])
        : null;
    return (
      <div className="page">
        {back}
        <h1>Commit journey</h1>
        {err instanceof ApiError && err.status === 404 ? (
          <Empty title="No journey for this commit">
            <p>
              No event in the retention window carries commit <code>{commit}</code> in{" "}
              <code>{repository}</code>. It may be older than the window, or the repository is not
              connected.
            </p>
            <p>
              <Link to="/journeys">Look up another commit</Link>
            </p>
          </Empty>
        ) : candidates ? (
          <div className="callout" role="alert">
            <strong>
              <code>{commit}</code> matches several commits of {repository}.
            </strong>{" "}
            Pick one:
            <ul className="plain">
              {candidates.map((c) => (
                <li key={c}>
                  <Link to={journeyPath(repository, c)}>
                    <code>{c}</code>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ErrorBox error={err} onRetry={res.reload} title="Could not load the journey" />
        )}
      </div>
    );
  }
  if (!res.data) return null;
  return (
    <JourneyContent
      data={res.data}
      state={state.data}
      view={props.view}
      onView={props.onView}
      containmentRequested={containment}
      containmentLoading={res.loading}
      onContainment={props.onContainment}
    />
  );
}

export function JourneyContent({
  data,
  state = null,
  view,
  onView,
  containmentRequested = false,
  containmentLoading = false,
  onContainment,
}: {
  data: JourneyResponse;
  state?: EnvironmentStateLite | null;
  view: JourneyView | null;
  onView: (v: JourneyView) => void;
  containmentRequested?: boolean;
  containmentLoading?: boolean;
  onContainment?: () => void;
}) {
  const j = data.journey;
  const manyPlacements = prefersPlacementList(j);
  const current: JourneyView = view ?? (manyPlacements ? "placements" : "diagram");
  const where = useMemo(() => whereItWent(j, state), [j, state]);
  const repo = displayRepository(j.repository);
  const timelineLink = `/events?${new URLSearchParams({ journey: `${repo}@${j.commitSha}` }).toString()}`;

  return (
    <div className="page journey-page">
      <p>
        <Link to="/events">← Events</Link>
      </p>
      <header className="page-header">
        <div>
          <h1>
            Journey of <code className="journey-sha">{shortSha(j.commitSha)}</code>
          </h1>
          <p className="lede">
            <code>{repo}</code>
            {j.ref && (
              <>
                {" "}
                on <code>{j.ref.replace(/^refs\/heads\//, "")}</code>
              </>
            )}{" "}
            · first seen <When at={j.startedAt} /> ({formatRelative(j.startedAt)}) in{" "}
            <EventLink e={j.root} />
          </p>
          <p className="small muted mono-wrap" title="Full commit SHA">
            {j.commitSha}
          </p>
        </div>
        <div className="toolbar">
          <Link className="btn" to={timelineLink}>
            Highlight in timeline
          </Link>
        </div>
      </header>

      {(j.truncated || data.window.truncated || data.window.stale) && (
        <div className="callout" role="note">
          {j.truncated && (
            <p>
              <strong>Journey cut short.</strong> It has more steps than Afe follows in one request;
              later steps are missing.
            </p>
          )}
          {data.window.truncated && (
            <p>
              Afe keeps a limited number of events per tenant in memory; the oldest are left out.
            </p>
          )}
          {data.window.stale && <p>Newer events are still being correlated; reload in a moment.</p>}
        </div>
      )}
      {j.gaps.length > 0 && (
        <div className="callout callout-gap" role="status">
          <strong>Some steps happened while a source was not observed.</strong> Related events may
          be missing from this journey.
          <ul>
            {j.gaps.map((g) => (
              <li key={g.gapId}>
                {toolLabel(g.source)}: <When at={g.startedAt} /> –{" "}
                {g.endedAt ? <When at={g.endedAt} /> : "still open"} ({gapReason(g.reason)})
              </li>
            ))}
          </ul>
        </div>
      )}

      <WhereItWent
        rows={where}
        containmentRequested={containmentRequested}
        containmentLoading={containmentLoading}
        onContainment={onContainment}
        repository={repo}
      />

      <section className="card" aria-labelledby="journey-flow">
        <div className="journey-flow-head">
          <h2 id="journey-flow">Steps</h2>
          <div className="segmented" role="group" aria-label="Show steps as">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className="btn"
                aria-pressed={current === v.id}
                onClick={() => onView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        {manyPlacements && current !== "diagram" && (
          <p className="small muted" role="note">
            This commit was deployed {j.environments.length} times; a list of placements reads
            better than a diagram here.
          </p>
        )}
        {current === "diagram" ? (
          <JourneyDiagram journey={j} />
        ) : current === "list" ? (
          <StepList journey={j} />
        ) : (
          <PlacementList journey={j} />
        )}
      </section>

      <div className="grid-2">
        <ExcludedList journey={j} />
        <ContinuesAs journey={j} />
      </div>
      {j.conflicts.length > 0 && <ConflictList journey={j} />}
    </div>
  );
}

// --- Where it went ---------------------------------------------------------------

function WhereItWent({
  rows,
  containmentRequested,
  containmentLoading,
  onContainment,
  repository,
}: {
  rows: WhereRow[];
  containmentRequested: boolean;
  containmentLoading: boolean;
  onContainment?: () => void;
  repository: string;
}) {
  return (
    <section className="card" aria-labelledby="where-heading">
      <div className="journey-flow-head">
        <h2 id="where-heading">Where it went</h2>
        {onContainment &&
          (containmentRequested ? (
            <span className="small muted" role="status">
              {containmentLoading
                ? "Comparing with live commits…"
                : "Compared with later live commits (GitHub compare)."}
            </span>
          ) : (
            <button type="button" className="btn" onClick={onContainment}>
              Check later commits
            </button>
          ))}
      </div>
      {rows.length === 0 ? (
        <p className="muted">
          No environment has run this commit as far as Afe can tell.{" "}
          {!containmentRequested &&
            `A later commit of ${repository} may include it: check later commits.`}
        </p>
      ) : (
        <ul className="where-list">
          {rows.map((r) => (
            <li key={r.key} className={`where where-${r.status}`}>
              <span className={`where-status where-status-${r.status}`}>
                {WHERE_LABEL[r.status]}
              </span>
              <span className="where-env">
                <strong>{r.environmentName}</strong>
                <span className="muted">
                  {" "}
                  {r.serviceName}
                  {r.targets.length > 0 && ` · ${r.targets.join(", ")}`}
                </span>
              </span>
              <span className="where-detail">
                {r.confidence && <ConfidenceBadge value={r.confidence} />} {r.detail}
                {r.at && (
                  <>
                    {" "}
                    <span className="muted">
                      {r.status === "live" ? "since" : "at"} <When at={r.at} />
                    </span>
                  </>
                )}
                {r.placementEventId && (
                  <>
                    {" "}
                    <Link to={`/events/${r.placementEventId}`}>placement</Link>
                  </>
                )}
                {r.liveCommit && (
                  <>
                    {" "}
                    <Link to={journeyPath(repository, r.liveCommit)}>
                      journey of {shortSha(r.liveCommit)}
                    </Link>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Diagram ---------------------------------------------------------------------

type Active = { kind: "step"; id: string } | { kind: "edge"; index: number } | null;

function edgeLabel(p: EdgePath, byId: Map<string, JourneyStep>): string {
  const from = byId.get(p.edge.from)?.event.action ?? "step";
  const to = byId.get(p.edge.to)?.event.action ?? "step";
  if (p.conflict) return `Conflict between ${from} and ${to}: ${p.conflict.detail}`;
  return `${p.edge.confidence} link from ${from} to ${to}: ${p.edge.evidence.map(evidenceText).join("; ")}`;
}

export function JourneyDiagram({ journey }: { journey: Journey }) {
  const layout = useMemo(() => layoutJourney(journey), [journey]);
  const byId = useMemo(() => new Map(journey.steps.map((s) => [s.eventId, s])), [journey]);
  const [active, setActive] = useState<Active>(null);
  const activeStep = active?.kind === "step" ? active.id : null;
  const touches = (p: EdgePath) =>
    active === null
      ? null
      : active.kind === "edge"
        ? layout.edges[active.index] === p
        : p.edge.from === active.id || p.edge.to === active.id;

  return (
    <div className="journey-diagram-wrap">
      <Legend />
      <div className="journey-scroll" tabIndex={-1}>
        <div
          className="journey-canvas"
          style={{ width: layout.width, height: layout.height }}
          onMouseLeave={() => setActive(null)}
        >
          {layout.columns.map((c) => (
            <div key={c.stage} className="journey-col-head" style={{ left: c.x, width: CARD_W }}>
              {STAGE_LABEL[c.stage]} <span className="muted">({c.count})</span>
            </div>
          ))}
          <svg
            className="journey-edges"
            width={layout.width}
            height={layout.height}
            role="group"
            aria-label="Links between steps"
          >
            <defs>
              {[...CONFIDENCE_ORDER, "conflict"].map((c) => (
                <marker
                  key={c}
                  id={`arrow-${c}`}
                  className={`arrow arrow-${c}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              ))}
            </defs>
            {layout.edges.map((p, i) => {
              const t = touches(p);
              const cls = p.conflict ? "conflict" : p.edge.confidence;
              return (
                <g
                  key={`${p.edge.from}-${p.edge.to}-${i}`}
                  className={`edge edge-${cls}${t === true ? " is-active" : t === false ? " is-dim" : ""}`}
                  data-testid="journey-edge"
                  data-confidence={cls}
                  tabIndex={0}
                  role="img"
                  aria-label={edgeLabel(p, byId)}
                  onMouseEnter={() => setActive({ kind: "edge", index: i })}
                  onFocus={() => setActive({ kind: "edge", index: i })}
                >
                  <title>{edgeLabel(p, byId)}</title>
                  <path className="edge-hit" d={p.d} />
                  <path className="edge-line" d={p.d} markerEnd={`url(#arrow-${cls})`} />
                  <text x={p.lx} y={p.ly - 4} textAnchor="middle" className="edge-label">
                    {p.conflict ? "conflict" : p.edge.confidence}
                  </text>
                </g>
              );
            })}
          </svg>
          {[...layout.cards.values()].map(({ step, x, y }) => {
            const e = step.event;
            const dim =
              activeStep !== null &&
              activeStep !== step.eventId &&
              !journey.edges.some(
                (ed) =>
                  (ed.from === activeStep && ed.to === step.eventId) ||
                  (ed.to === activeStep && ed.from === step.eventId),
              );
            return (
              <Link
                key={step.eventId}
                to={`/events/${e.id}`}
                className={`journey-card tool-edge-${e.source} conf-edge-${step.confidence}${dim ? " is-dim" : ""}${activeStep === step.eventId ? " is-active" : ""}`}
                style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
                data-testid="journey-card"
                aria-label={`${STAGE_LABEL[step.stage]}: ${e.action} on ${e.target.label}, ${humanize(e.outcome)}, ${formatDateTime(e.at)}, ${step.confidence}`}
                onMouseEnter={() => setActive({ kind: "step", id: step.eventId })}
                onFocus={() => setActive({ kind: "step", id: step.eventId })}
              >
                <span className="jc-top">
                  <ToolBadge source={e.source} />
                  <ConfidenceBadge value={step.confidence} />
                </span>
                <span className="jc-action">{e.action}</span>
                <span className="jc-meta">
                  {e.target.label}
                  {e.actor ? ` · ${e.actor}` : ""}
                </span>
                <span className="jc-meta">
                  <time dateTime={e.at}>{formatDateTime(e.at)}</time>{" "}
                  <OutcomeBadge outcome={e.outcome} />
                </span>
              </Link>
            );
          })}
        </div>
      </div>
      <Inspector journey={journey} layout={layout.edges} active={active} byId={byId} />
    </div>
  );
}

function Legend() {
  return (
    <ul className="journey-legend small" aria-label="Edge styles">
      {CONFIDENCE_ORDER.map((c) => (
        <li key={c}>
          <svg width="34" height="10" aria-hidden="true" className={`edge edge-${c}`}>
            <path className="edge-line" d="M 1 5 L 33 5" />
          </svg>{" "}
          <span title={CONFIDENCE_HELP[c]}>{c}</span>
        </li>
      ))}
      <li>
        <svg width="34" height="10" aria-hidden="true" className="edge edge-conflict">
          <path className="edge-line" d="M 1 5 L 33 5" />
        </svg>{" "}
        conflict
      </li>
      <li className="muted">Hover or focus a step or link for its evidence.</li>
    </ul>
  );
}

function EvidenceList({
  evidence,
}: {
  evidence: { kind: string; key: string; confidence: Confidence; detail?: string }[];
}) {
  if (evidence.length === 0) return <p className="muted small">No evidence recorded.</p>;
  return (
    <ul className="evidence">
      {evidence.map((ev, i) => (
        <li key={`${ev.kind}-${ev.key}-${i}`}>
          <ConfidenceBadge value={ev.confidence} /> {evidenceText(ev)}
        </li>
      ))}
    </ul>
  );
}

function Inspector({
  journey,
  layout,
  active,
  byId,
}: {
  journey: Journey;
  layout: EdgePath[];
  active: Active;
  byId: Map<string, JourneyStep>;
}) {
  let body: ReactNode = (
    <p className="muted small">
      Hover or focus a step or a link to see how Afe connected it to this commit.
    </p>
  );
  if (active?.kind === "edge") {
    const p = layout[active.index];
    if (p) {
      const from = byId.get(p.edge.from)?.event;
      const to = byId.get(p.edge.to)?.event;
      body = p.conflict ? (
        <>
          <h3>
            Conflict: <code>{humanize(p.conflict.kind)}</code>
          </h3>
          <p>{p.conflict.detail}</p>
          <p className="small">
            Key <code>{p.conflict.key}</code>. Conflicting identifiers are reported, never linked.
          </p>
        </>
      ) : (
        <>
          <h3>
            <code>{from?.action}</code> → <code>{to?.action}</code>{" "}
            <ConfidenceBadge value={p.edge.confidence} />
          </h3>
          <EvidenceList evidence={p.edge.evidence} />
        </>
      );
    }
  } else if (active?.kind === "step") {
    const s = byId.get(active.id);
    if (s) {
      const incoming = journey.edges.filter((e) => e.to === s.eventId);
      const outgoing = journey.edges.filter((e) => e.from === s.eventId);
      body = (
        <>
          <h3>
            <code>{s.event.action}</code> <ConfidenceBadge value={s.confidence} />
          </h3>
          <p className="small">
            {toolLabel(s.event.source)} · {s.event.target.label} · {humanize(s.event.outcome)} ·{" "}
            {formatDateTime(s.event.at)}
            {s.event.actor ? ` · by ${s.event.actor}` : ""}
          </p>
          {s.reachedFrom ? (
            <>
              <p className="small">
                Reached from <code>{byId.get(s.reachedFrom)?.event.action ?? s.reachedFrom}</code>{" "}
                (path confidence {s.confidence}, the weakest link on the way):
              </p>
              <EvidenceList evidence={s.via} />
            </>
          ) : (
            <p className="small">Carries the commit itself.</p>
          )}
          {incoming.length + outgoing.length > s.via.length && (
            <p className="small muted">
              {incoming.length} incoming and {outgoing.length} outgoing links in this journey.
            </p>
          )}
        </>
      );
    }
  }
  return (
    <div className="journey-inspector" aria-live="polite" data-testid="journey-inspector">
      {body}
    </div>
  );
}

// --- Text alternatives ------------------------------------------------------------

export function StepList({ journey }: { journey: Journey }) {
  const byId = new Map(journey.steps.map((s) => [s.eventId, s]));
  return (
    <ol className="step-list">
      {journey.stages.map((st) => (
        <li key={st.stage}>
          <h3>{STAGE_LABEL[st.stage]}</h3>
          <ul>
            {st.steps
              .flatMap((id) => byId.get(id) ?? [])
              .sort((a, b) => (a.event.at < b.event.at ? -1 : 1))
              .map((s) => (
                <li key={s.eventId} className="step-item">
                  <span>
                    <ToolBadge source={s.event.source} /> <EventLink e={s.event} />{" "}
                    <OutcomeBadge outcome={s.event.outcome} /> on {s.event.target.label}
                    {s.event.actor ? ` by ${s.event.actor}` : ""}, <When at={s.event.at} />{" "}
                    <ConfidenceBadge value={s.confidence} />
                  </span>
                  {s.reachedFrom && (
                    <span className="small muted">
                      reached from <code>{byId.get(s.reachedFrom)?.event.action}</code> via{" "}
                      {s.via.map(evidenceText).join("; ")}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export function PlacementList({ journey }: { journey: Journey }) {
  const placements = [...journey.environments].sort((a, b) => (a.at < b.at ? 1 : -1));
  const before = journey.stages.filter((s) =>
    ["change", "ci", "artifact", "config"].includes(s.stage),
  );
  const byId = new Map(journey.steps.map((s) => [s.eventId, s]));
  return (
    <>
      {before.length > 0 && (
        <p className="small">
          Before deployment:{" "}
          {before.map((st, i) => {
            const first = st.steps.flatMap((id) => byId.get(id) ?? [])[0];
            return (
              <span key={st.stage}>
                {i > 0 && " → "}
                {STAGE_LABEL[st.stage]} ({st.steps.length})
                {first && (
                  <>
                    {" "}
                    <EventLink e={first.event} />
                  </>
                )}
              </span>
            );
          })}
        </p>
      )}
      {placements.length === 0 ? (
        <p className="muted">No placement of this commit was found.</p>
      ) : (
        <div className="table-wrap">
          <table className="table" data-testid="placement-list">
            <caption className="sr-only">Placements of this commit, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Environment</th>
                <th scope="col">Placement</th>
                <th scope="col">How it relates</th>
                <th scope="col">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {placements.map((p) => (
                <tr key={`${p.placementEventId}-${p.via}`}>
                  <td>
                    <When at={p.at} />
                  </td>
                  <td>
                    {p.environment === "_unmapped" ? p.target.label : p.environment}{" "}
                    <span className="muted small">
                      {p.service === "_unmapped" ? "" : p.service} · {p.target.label}
                    </span>
                  </td>
                  <td>
                    <ToolBadge source={p.event.source} /> <EventLink e={p.event} />{" "}
                    {p.current && <span className="badge where-status-live">live now</span>}
                  </td>
                  <td className="small">{p.detail ?? VIA_LABEL[p.via]}</td>
                  <td>
                    <ConfidenceBadge value={p.confidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// --- Excluded, continues as, conflicts ----------------------------------------------

function ExcludedList({ journey }: { journey: Journey }) {
  return (
    <section className="card" aria-labelledby="excluded-heading">
      <h2 id="excluded-heading">Excluded</h2>
      {journey.excluded.length === 0 ? (
        <p className="muted small">Nothing that looked related was ruled out.</p>
      ) : (
        <>
          <p className="small muted">Looked related through links, but ruled out:</p>
          <ul className="plain excluded-list">
            {journey.excluded.map((x) => (
              <li key={x.eventId}>
                <ToolBadge source={x.event.source} /> <EventLink e={x.event} /> on{" "}
                {x.event.target.label}, <When at={x.event.at} />
                <div className="small">{x.reason}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ContinuesAs({ journey }: { journey: Journey }) {
  return (
    <section className="card" aria-labelledby="continues-heading">
      <h2 id="continues-heading">Continues as</h2>
      {journey.continuesAs.length === 0 ? (
        <p className="muted small">No later commit carries this change on.</p>
      ) : (
        <ul className="plain continues-list">
          {journey.continuesAs.map((c) => (
            <li key={`${c.journeyId}-${c.relation}`}>
              {RELATION_LABEL[c.relation] ?? humanize(c.relation)}{" "}
              <Link to={journeyPath(c.repository, c.commitSha)}>
                <code>
                  {displayRepository(c.repository)}@{shortSha(c.commitSha)}
                </code>
              </Link>{" "}
              <Link className="small" to={`/events/${c.eventId}`}>
                (event)
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConflictList({ journey }: { journey: Journey }) {
  return (
    <section className="card callout-conflict" aria-labelledby="conflicts-heading">
      <h2 id="conflicts-heading">Conflicting identifiers</h2>
      <ul className="plain">
        {journey.conflicts.map((c, i) => (
          <li key={`${c.key}-${i}`}>
            <span className="badge conf conf-conflict">{humanize(c.kind)}</span> {c.detail}{" "}
            <span className="small muted">
              (<code>{c.key}</code>; <Link to={`/events/${c.events[0]}`}>first</Link>,{" "}
              <Link to={`/events/${c.events[1]}`}>second</Link> event)
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
