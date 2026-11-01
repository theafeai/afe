import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { icons } from "./icons.tsx";
import { Link } from "./router.tsx";

/**
 * Toasts: short-lived confirmations of an action the user just took ("Saved",
 * "Invitation queued"). Persistent state (observation gaps, failed loads, form
 * errors) stays in callouts on the page; see docs/design-system.md.
 */
export type ToastKind = "ok" | "info" | "error";

export interface ToastInput {
  message: string;
  kind?: ToastKind;
  /** Optional next step, shown as a link after the message. */
  action?: { label: string; to: string };
}

export interface Toast extends Required<Pick<ToastInput, "message" | "kind">> {
  id: number;
  action?: ToastInput["action"];
  createdAt: number;
}

export type ShowToast = (toast: ToastInput | string) => void;

const KIND_LABEL: Record<ToastKind, string> = { ok: "Done", info: "Note", error: "Failed" };
/** Milliseconds a toast stays up; errors stay until dismissed. */
const DURATION: Record<ToastKind, number | null> = { ok: 6000, info: 6000, error: null };
const MAX_VISIBLE = 4;

const ToastContext = createContext<ShowToast>(() => {});

/** Show a toast. Outside a `ToastProvider` (isolated component tests) it does nothing. */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}

/**
 * Holds the toast stack for the app shell. `onToast` is called once for every
 * toast shown, so a host can keep a history of them.
 */
export function ToastProvider({
  children,
  onToast,
}: {
  children: ReactNode;
  onToast?: (toast: Toast) => void;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ShowToast>((input) => {
    const { message, kind = "ok", action } = typeof input === "string" ? { message: input } : input;
    const toast: Toast = { id: nextId.current++, message, kind, action, createdAt: Date.now() };
    // The same message twice in a row (a double click, a retry) replaces the first.
    setToasts((ts) =>
      [...ts.filter((t) => t.message !== message || t.kind !== kind), toast].slice(-MAX_VISIBLE),
    );
    onToastRef.current?.(toast);
  }, []);

  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <section className="toasts" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const duration = DURATION[toast.kind];
  useEffect(() => {
    if (duration === null || paused) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), duration);
    return () => window.clearTimeout(timer);
  }, [duration, paused, toast.id, onDismiss]);

  return (
    <div
      className={`toast toast-${toast.kind}`}
      role={toast.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-icon" aria-hidden="true">
        {toast.kind === "error" ? icons.alert : toast.kind === "ok" ? icons.check : icons.info}
      </span>
      <p className="toast-body">
        <span className="sr-only">{KIND_LABEL[toast.kind]}: </span>
        {toast.message}
        {toast.action && (
          <>
            {" "}
            <Link to={toast.action.to} onClick={() => onDismiss(toast.id)}>
              {toast.action.label}
            </Link>
          </>
        )}
      </p>
      <button
        type="button"
        className="btn btn-ghost btn-icon toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        {icons.close}
      </button>
    </div>
  );
}
