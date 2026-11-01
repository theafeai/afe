import { useId, useRef, useState } from "react";
import { useAccess } from "../access.tsx";
import { api } from "../api/client.ts";
import type { ConnectionWithHealth } from "../api/types.ts";
import { ErrorBox, toolLabel } from "../components.tsx";

type Disconnectable = Pick<ConnectionWithHealth, "id" | "name" | "source" | "status">;

const consequences: Record<string, string> = {
  github:
    "Afe stops observing this installation and ignores its webhooks. The GitHub App stays installed and its shared App credentials are kept. You can uninstall it in GitHub Settings → GitHub Apps. Reconnect through Afe to resume observation.",
  argocd:
    "Afe revokes its stored API token or agent secret and stops observing this instance. An agent can no longer send reports. This does not delete the token in ArgoCD or uninstall an agent; remove those separately if needed.",
  vercel:
    "Afe deletes its stored credentials and stops observing this account. For an Integration connection, Afe also attempts to remove the integration in Vercel. A personal token must be deleted in Vercel separately; if integration removal fails, remove it in Vercel Settings → Integrations.",
  terraform:
    "Afe revokes the reporter secret, rejects new reports and deletes pending reports. Previously ingested events are kept. Remove the reporter configuration from your local or CI runs separately.",
};

/** One confirmation flow for list, detail and connector setup screens. */
export function DisconnectAction({
  connection: c,
  onDone,
}: {
  connection: Disconnectable;
  onDone: (note: string) => void;
}) {
  const { admin } = useAccess();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (!admin || c.status === "disconnected" || !consequences[c.source]) return null;

  async function disconnect() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      let note: string;
      switch (c.source) {
        case "github":
          note = (await api.githubDisconnect(c.id)).note;
          break;
        case "argocd":
          await api.argocdDisconnect(c.id);
          note =
            "Afe revoked its stored API token or agent secret. Remove the upstream token or agent separately if needed.";
          break;
        case "terraform":
          note = (await api.terraformDisconnect(c.id)).note;
          break;
        default:
          note = (await api.vercelDisconnect(c.id)).note ?? "Vercel integration removed.";
      }
      dialog.current?.close();
      onDone(`${toolLabel(c.source)} “${c.name}” disconnected. ${note}`);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Request failed"));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-danger"
        aria-label={`Disconnect ${c.name}`}
        onClick={() => {
          setError(null);
          dialog.current?.showModal();
        }}
      >
        Disconnect
      </button>
      <dialog
        ref={dialog}
        className="disconnect-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-warning`}
        onCancel={(event) => {
          if (submitting.current) event.preventDefault();
        }}
      >
        <h2 id={`${id}-title`}>
          Disconnect {toolLabel(c.source)} “{c.name}”?
        </h2>
        <div id={`${id}-warning`} className="callout callout-gap">
          <p>{consequences[c.source]}</p>
          <p>
            Observation stops until you reconnect. Recorded events remain until their retention
            window expires.
          </p>
        </div>
        {error && <ErrorBox error={error} title="Could not disconnect" />}
        <div className="button-row">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => dialog.current?.close()}
            autoFocus
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {busy ? "Disconnecting…" : "Disconnect connection"}
          </button>
        </div>
      </dialog>
    </>
  );
}
