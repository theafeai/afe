import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ErrorBox } from "./components.tsx";

/** Mount while an operation is being reviewed. Only the explicit action submits. */
export function OperationDialog({
  title,
  description,
  children,
  confirmLabel,
  pendingLabel = "Submitting…",
  destructive = false,
  busy = false,
  confirmDisabled = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  error?: Error | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // A ref also closes the gap before React commits the pending state.
  const submitted = useRef(false);
  useEffect(() => {
    if (!busy) submitted.current = false;
  }, [busy]);
  useEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current!;
    node.showModal();
    cancel.current?.focus({ preventScroll: true });
    return () => {
      node.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
  function dismiss() {
    if (!busy && !submitted.current) onCancel();
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="operation-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-modal="true"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dismiss();
      }}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <div id={`${id}-description`}>{description}</div>
      {children}
      {error && <ErrorBox error={error} />}
      {busy && <p role="status">{pendingLabel}</p>}
      <div className="button-row form-end">
        <button ref={cancel} type="button" className="btn" aria-disabled={busy} onClick={dismiss}>
          Cancel
        </button>
        <button
          type="button"
          className={destructive ? "btn btn-danger" : "btn btn-primary"}
          disabled={busy || confirmDisabled}
          onClick={() => {
            if (busy || confirmDisabled || submitted.current) return;
            submitted.current = true;
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
