import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "./api/client.ts";
import type { ConnectionWithHealth, HealthState, ObservationMethod } from "./api/types.ts";
import { formatDateTime, formatRelative, humanize } from "./format.ts";
import { Link } from "./router.tsx";

// --- Data loading -------------------------------------------------------------

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` when `deps` change; aborts the previous request. */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    loadRef.current(ctrl.signal).then(
      (data) => {
        if (!ctrl.signal.aborted) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        });
      },
    );
    return () => ctrl.abort();
    // `load` is read through a ref; `deps` decide when to reload.
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
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

// --- Badges --------------------------------------------------------------------

const TOOL_LABEL: Record<string, string> = {
  github: "GitHub",
  argocd: "ArgoCD",
  vercel: "Vercel",
  terraform: "Terraform",
  afe: "Afe",
};

export function toolLabel(source: string): string {
  return TOOL_LABEL[source] ?? source;
}

export function ToolBadge({ source }: { source: string }) {
  return <span className={`badge tool tool-${source}`}>{toolLabel(source)}</span>;
}

const METHOD_HELP: Record<ObservationMethod, string> = {
  webhook: "Pushed by the tool as a webhook",
  poll: "Found by routine polling",
  stream: "Received on a live watch stream",
  reconciliation: "Found by reconciliation: it should have arrived by webhook or poll but did not",
  backfill: "Imported afterwards by a backfill (history or after an observation gap)",
  internal: "Recorded by Afe itself",
};

export function MethodBadge({ method }: { method: ObservationMethod }) {
  return (
    <span className={`badge method method-${method}`} title={METHOD_HELP[method]}>
      {method === "reconciliation" ? "reconciled" : method}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "none") return null;
  return <span className={`badge outcome outcome-${outcome}`}>{humanize(outcome)}</span>;
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

export function HealthBadge({ state }: { state: HealthState }) {
  return (
    <span className={`badge health health-${state}`}>
      <span className="dot" aria-hidden="true" />
      {HEALTH_LABEL[state] ?? state}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status status-${status}`}>{status}</span>;
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
