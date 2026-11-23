import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "./api/client.ts";
import type { ConnectionWithHealth, HealthState, ObservationMethod } from "./api/types.ts";
import { formatDateTime, formatRelative, humanize } from "./format.ts";
import { Link } from "./router.tsx";
import { ToolMark, icons, statusGlyphs } from "./icons.tsx";

// --- Data loading -------------------------------------------------------------

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Resource changes clear data immediately; same-resource refreshes retain valid data. */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  refreshKey?: unknown,
): AsyncState<T> {
  const resource = useMemo(() => ({}), deps);
  const [state, setState] = useState<{
    resource: object;
    tick: number;
    refreshKey: unknown;
    data: T | null;
    error: Error | null;
    loading: boolean;
  }>({
    resource,
    tick: 0,
    refreshKey,
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({
      resource,
      tick,
      refreshKey,
      data: s.resource === resource ? s.data : null,
      loading: true,
      error: null,
    }));
    loadRef.current(ctrl.signal).then(
      (data) => {
        if (!ctrl.signal.aborted)
          setState({ resource, tick, refreshKey, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({
          resource,
          tick,
          refreshKey,
          // Do not retain data after access was revoked or the resource disappeared.
          data: error instanceof ApiError && [401, 403, 404].includes(error.status) ? null : s.data,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        }));
      },
    );
    return () => ctrl.abort();
    // `load` is read through a ref; `deps` decide when to reload.
  }, [resource, tick, refreshKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  if (state.resource !== resource) return { data: null, error: null, loading: true, reload };
  return {
    data: state.data,
    error: state.tick === tick && Object.is(state.refreshKey, refreshKey) ? state.error : null,
    loading: state.loading || state.tick !== tick || !Object.is(state.refreshKey, refreshKey),
    reload,
  };
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Afe` : "Afe";
  }, [title]);
}

// --- States ---------------------------------------------------------------------

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="state state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </p>
  );
}

export function ErrorBox({
  error,
  onRetry,
  title = "Something went wrong",
}: {
  error: Error;
  onRetry?: () => void;
  title?: string;
}) {
  const status = error instanceof ApiError && error.status ? ` (HTTP ${error.status})` : "";
  return (
    <div className="callout callout-error" role="alert">
      <strong>
        {title}
        {status}
      </strong>
      <p>{error.message}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon">{icon}</span>}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

// --- Tools ---------------------------------------------------------------------

const TOOL_LABEL: Record<string, string> = {
  github: "GitHub",
  ghactions: "GitHub Actions",
  argocd: "ArgoCD",
  vercel: "Vercel",
  terraform: "Terraform",
  afe: "Afe",
};

export function toolLabel(source: string): string {
  return TOOL_LABEL[source] ?? source;
}

/** The tool's logo on its brand tile plus its name (ADR 0017 decision 4). */
export function ToolBadge({ source }: { source: string }) {
  return (
    <span className={`tool-badge t-${source}`} data-tool={source}>
      <ToolMark source={source} tile />
      {toolLabel(source)}
    </span>
  );
}

/**
 * The legend (ADR 0017 decision 3): shown, sticky, on every screen that colour-codes
 * tools. It lists the tenant's connected tools (from `sources`, or loaded from the
 * connections API when the page has not loaded them), each with its logo, name and
 * stroke swatch, then the screen's own `keys` and Afe's key. Hovering or focusing a
 * tool fades everything on the page from the other tools.
 */
export function ToolLegend({
  sources,
  counts,
  keys,
}: {
  sources?: readonly string[];
  counts?: Readonly<Record<string, number>>;
  keys?: ReactNode;
}) {
  const loaded = useAsync(
    (signal) => (sources ? Promise.resolve(null) : api.connections(signal)),
    [sources === undefined],
  );
  const fromApi = Array.isArray(loaded.data?.connections)
    ? loaded.data.connections.map((c) => c.source)
    : [];
  const tools = [...new Set(sources ?? fromApi)];
  const ref = useRef<HTMLElement>(null);
  const fade = useCallback((tool: string | null) => {
    const root = ref.current?.closest("main") ?? document;
    for (const el of root.querySelectorAll<HTMLElement>("[data-tool]"))
      el.classList.toggle("dim", tool !== null && el.dataset.tool !== tool);
  }, []);
  useEffect(() => () => fade(null), [fade]);
  if (tools.length === 0) return null;
  return (
    <section className="legend" aria-label="Legend" ref={ref}>
      <span className="legend-title">
        {icons.layers}
        <strong>Colour = source</strong>
        <span>
          · {tools.length} {tools.length === 1 ? "tool" : "tools"} connected
        </span>
      </span>
      <ul className="legend-tools">
        {tools.map((t) => (
          <li
            key={t}
            className={`lg t-${t}`}
            tabIndex={0}
            onMouseEnter={() => fade(t)}
            onMouseLeave={() => fade(null)}
            onFocus={() => fade(t)}
            onBlur={() => fade(null)}
          >
            <ToolMark source={t} tile />
            {toolLabel(t)}
            <i className="lg-sw" aria-hidden="true" />
            {counts?.[t] !== undefined && <span className="lg-n">{counts[t]}</span>}
          </li>
        ))}
      </ul>
      <span className="legend-sep" aria-hidden="true" />
      <span className="legend-keys">
        {keys}
        <span>
          <i className="key-sp" aria-hidden="true" />
          Afe: all tools, live, selected
        </span>
      </span>
    </section>
  );
}

/** Live (ADR 0017 decision 5.3): Afe is watching this happen now. */
export function LiveIndicator({ children = "Live" }: { children?: ReactNode }) {
  return (
    <span className="live">
      <span className="pulse" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * Where a value came from (ADR 0017 decision 9): Afe inferred it (spectrum dot,
 * "inferred" and its confidence) or a person set it (person icon, "set by").
 */
export function ProvenancePill({
  inferred,
  confidence,
  setBy,
}:
  | { inferred: true; confidence?: string; setBy?: undefined }
  | { inferred?: false; confidence?: undefined; setBy: string }) {
  if (inferred)
    return (
      <span className="prov">
        <i className="inf-dot" aria-hidden="true" />
        inferred
        {confidence && <span className={`badge conf conf-${confidence}`}>{confidence}</span>}
      </span>
    );
  return (
    <span className="prov prov-set">
      {icons.person}
      set by {setBy}
    </span>
  );
}

// --- Status ------------------------------------------------------------------------

/** The tones a status can take; each is a solid shape (ADR 0017 decision 8). */
export type StatusTone = "ok" | "warn" | "bad" | "wait" | "idle" | "live";

/**
 * The status shape: a filled disc for ok, bad, waiting and neutral states, a filled
 * triangle for warn, a spectrum ring for in progress. Always next to a word.
 */
export function StatusMark({ tone }: { tone: StatusTone }) {
  if (tone === "warn") return statusGlyphs.triangle;
  if (tone === "live") return <span className="spin" aria-hidden="true" />;
  const glyph =
    tone === "ok"
      ? statusGlyphs.check
      : tone === "bad"
        ? statusGlyphs.cross
        : tone === "wait"
          ? statusGlyphs.clock
          : statusGlyphs.minus;
  return (
    <span className="si" aria-hidden="true">
      {glyph}
    </span>
  );
}

/** A status word with its shape. `className` names the family (outcome, health, …). */
export function StatusWord({
  tone,
  className,
  title,
  children,
}: {
  tone: StatusTone;
  className: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`badge ${className} s-${tone}`} title={title}>
      <StatusMark tone={tone} />
      {children}
    </span>
  );
}

const OUTCOME_TONE: Record<string, StatusTone> = {
  succeeded: "ok",
  failed: "bad",
  in_progress: "live",
  pending: "wait",
  cancelled: "idle",
  skipped: "idle",
  unknown: "idle",
};

export function outcomeTone(outcome: string): StatusTone {
  return OUTCOME_TONE[outcome] ?? "idle";
}

const METHOD_HELP: Record<ObservationMethod, string> = {
  webhook: "Pushed by the tool as a webhook",
  poll: "Found by routine polling",
  stream: "Received on a live watch stream",
  reconciliation: "Found by reconciliation: it should have arrived by webhook or poll but did not",
  backfill: "Imported afterwards by a backfill (history or after an observation gap)",
  internal: "Recorded by Afe itself",
};

const METHOD_ICON: Partial<Record<ObservationMethod, ReactNode>> = {
  webhook: icons.webhook,
  reconciliation: icons.search,
  backfill: icons.history,
};

export function MethodBadge({ method }: { method: ObservationMethod }) {
  return (
    <span className={`badge method method-${method}`} title={METHOD_HELP[method]}>
      {METHOD_ICON[method]}
      {method === "reconciliation" ? "reconciled" : method}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "none") return null;
  return (
    <StatusWord tone={outcomeTone(outcome)} className={`outcome outcome-${outcome}`}>
      {humanize(outcome)}
    </StatusWord>
  );
}

const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unreachable: "Unreachable",
  rate_limited: "Rate limited",
  unauthorized: "Unauthorized",
  revoked: "Access revoked",
  unknown: "Not checked yet",
};

const HEALTH_TONE: Record<HealthState, StatusTone> = {
  healthy: "ok",
  degraded: "warn",
  rate_limited: "warn",
  unreachable: "bad",
  unauthorized: "bad",
  revoked: "bad",
  unknown: "idle",
};

export function HealthBadge({ state }: { state: HealthState }) {
  return (
    <StatusWord tone={HEALTH_TONE[state] ?? "idle"} className={`health health-${state}`}>
      {HEALTH_LABEL[state] ?? state}
    </StatusWord>
  );
}

const CONNECTION_TONE: Record<string, StatusTone> = {
  active: "ok",
  pending: "wait",
  suspended: "bad",
  revoked: "bad",
  disconnected: "idle",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <StatusWord tone={CONNECTION_TONE[status] ?? "idle"} className={`status status-${status}`}>
      {status}
    </StatusWord>
  );
}

// --- Gaps ------------------------------------------------------------------------

export const GAP_REASON: Record<string, string> = {
  connection_error: "cannot reach the source",
  auth_failed: "credentials rejected or access revoked",
  permission_denied: "missing permissions",
  rate_limited: "rate limited by the source",
  source_unavailable: "the source returned errors",
  webhook_delivery_failed: "webhook deliveries failed",
  history_unavailable: "history no longer available at the source",
  afe_unavailable: "Afe itself was not running",
  connection_paused: "connection paused",
  unknown: "unknown reason",
};

export function gapReason(reason: string | null | undefined): string {
  return reason ? (GAP_REASON[reason] ?? humanize(reason)) : "unknown reason";
}

/**
 * One panel for connections that currently cannot be observed: a single gap
 * reads as a sentence, several as a compact list. Never hidden.
 */
export function GapBanners({ connections }: { connections: ConnectionWithHealth[] }) {
  const open = connections.filter((c) => c.health.openGap);
  if (open.length === 0) return null;
  const since = (c: ConnectionWithHealth) => (
    <time dateTime={c.health.openGap!.startedAt} title={c.health.openGap!.startedAt}>
      {formatDateTime(c.health.openGap!.startedAt)}
    </time>
  );
  if (open.length === 1) {
    const c = open[0]!;
    return (
      <section className="gap-banners" aria-label="Open observation gaps">
        <div className="callout callout-gap" role="status">
          {statusGlyphs.triangle}
          <strong>
            Data may be missing from {toolLabel(c.source)} “{c.name}”
          </strong>{" "}
          — Afe has not been able to observe it since {since(c)} (
          {formatRelative(c.health.openGap!.startedAt)}; {gapReason(c.health.openGap!.reason)}).
          Events from that period will be backfilled when the connection recovers.{" "}
          <Link to={`/connections/${c.id}`}>Connection details</Link>
          {c.alert && <span className="alert-tag"> · Alert open</span>}
        </div>
      </section>
    );
  }
  return (
    <section className="gap-banners" aria-label="Open observation gaps">
      <div className="callout callout-gap" role="status">
        <p className="gap-head">
          {statusGlyphs.triangle}
          <strong>Data may be missing from {open.length} connections</strong> — Afe cannot observe
          them right now. Events from those periods will be backfilled when each connection
          recovers.
        </p>
        <ul className="gap-list">
          {open.map((c) => (
            <li key={c.id}>
              <span className="gap-who">
                <ToolBadge source={c.source} />
                <span className="sr-only">Data may be missing from {toolLabel(c.source)}</span>
                <strong>“{c.name}”</strong>
              </span>
              <span className="gap-why">
                {gapReason(c.health.openGap!.reason)} · since {since(c)} (
                {formatRelative(c.health.openGap!.startedAt)})
                {c.alert && <span className="alert-tag"> · Alert open</span>}
              </span>
              <Link to={`/connections/${c.id}`}>Details</Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v === null || v === undefined || v === "" ? "—" : v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Section title with a count and the section's creation action on the right. */
export function SectionHead({
  id,
  title,
  count,
  hint,
  action,
}: {
  id: string;
  title: string;
  count?: number;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        <div className="section-title">
          <h2 id={id}>{title}</h2>
          {count !== undefined && <span className="count">{count}</span>}
        </div>
        {hint && <p className="muted small">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
