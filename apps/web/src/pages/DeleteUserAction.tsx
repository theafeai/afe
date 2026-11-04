import { useId, useRef, useState } from "react";
import { request } from "../api/client.ts";
import { ErrorBox } from "../components.tsx";

export type UserDeletionProtection = "self" | "administrator" | null;
const PROTECTION = {
  self: "You cannot delete your own user account.",
  administrator:
    "Administrator-linked accounts are protected. Unlink personal GitHub access in Profile; manage administrator access through its authentication provider.",
};

export function DeleteUserAction({
  user,
  disabled,
  onBusy,
  onDeleted,
}: {
  user: { id: string; username: string; deletionProtection?: UserDeletionProtection };
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onDeleted: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const protection = user.deletionProtection ? PROTECTION[user.deletionProtection] : null;

  async function remove() {
    if (submitting.current || disabled || protection) return;
    submitting.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      await request("DELETE", `/api/admin/users/${user.id}`);
      dialog.current?.close();
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Request failed"));
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-danger"
        disabled={disabled || Boolean(protection)}
        aria-describedby={protection ? `${id}-protection` : undefined}
        onClick={() => {
          setError(null);
          dialog.current?.showModal();
        }}
      >
        Delete user
      </button>
      {protection && (
        <span className="small muted" id={`${id}-protection`}>
          {protection}
        </span>
      )}
      <dialog
        ref={dialog}
        className="confirm-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-consequences`}
        onCancel={(e) => {
          if (submitting.current) e.preventDefault();
        }}
      >
        <h2 id={`${id}-title`}>Delete user “{user.username}”?</h2>
        <div id={`${id}-consequences`}>
          <p>This permanently deletes this Afe user. This cannot be undone.</p>
          <ul className="plain">
            <li>Their access credential and active sessions stop working.</li>
            <li>
              Their permission settings, linked tool accounts, sign-in/recovery links and associated
              queued emails are removed. Afe destroys its stored copies of linked tokens.
            </li>
            <li>
              Recorded deployment events and historical attribution remain until their normal
              retention expiry.
            </li>
          </ul>
          <p>
            Upstream accounts and tokens are kept. Revoke tokens at the tool separately if needed.
          </p>
        </div>
        {error && <ErrorBox title={`Could not delete ${user.username}`} error={error} />}
        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy}
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "Deleting user…" : "Delete permanently"}
          </button>
        </div>
      </dialog>
    </>
  );
}
