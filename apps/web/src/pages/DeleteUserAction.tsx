import { useId, useRef, useState } from "react";
import { request } from "../api/client.ts";
import { ErrorBox } from "../components.tsx";
import { OperationDialog } from "../OperationDialog.tsx";

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
  const [open, setOpen] = useState(false);
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
      setOpen(false);
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
          setOpen(true);
        }}
      >
        Delete user
      </button>
      {protection && (
        <span className="small muted" id={`${id}-protection`}>
          {protection}
        </span>
      )}
      {open && (
        <OperationDialog
          title={`Delete user “${user.username}”?`}
          confirmLabel="Delete permanently"
          pendingLabel="Deleting user…"
          destructive
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setOpen(false)}
          description={
            <>
              <p>This permanently deletes this Afe user. This cannot be undone.</p>
              <ul className="plain">
                <li>Their access credential and active sessions stop working.</li>
                <li>
                  Their permission settings, linked tool accounts, sign-in/recovery links and
                  associated queued emails are removed. Afe destroys its stored copies of linked
                  tokens.
                </li>
                <li>
                  Recorded deployment events and historical attribution remain until their normal
                  retention expiry.
                </li>
              </ul>
              <p>
                Upstream accounts and tokens are kept. Revoke tokens at the tool separately if
                needed.
              </p>
            </>
          }
        >
          {error && <ErrorBox title={`Could not delete ${user.username}`} error={error} />}
        </OperationDialog>
      )}
    </>
  );
}
