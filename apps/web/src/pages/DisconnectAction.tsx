import { useRef, useState } from "react";
import { useAccess } from "../access.tsx";
import { api } from "../api/client.ts";
import type { ConnectionWithHealth } from "../api/types.ts";
import { OperationDialog } from "../OperationDialog.tsx";
import { toolLabel } from "../components.tsx";

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
  const [open, setOpen] = useState(false);
  const submitting = useRef(false);
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
      setOpen(false);
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
          setOpen(true);
        }}
      >
        Disconnect
      </button>
      {open && (
        <OperationDialog
          title={`Disconnect ${toolLabel(c.source)} “${c.name}”?`}
          description={
            <div className="callout callout-gap">
              <p>{consequences[c.source]}</p>
              <p>
                Observation stops until you reconnect. Recorded events remain until their retention
                window expires.
              </p>
            </div>
          }
          confirmLabel="Disconnect connection"
          pendingLabel="Disconnecting…"
          destructive
          busy={busy}
          error={error}
          onConfirm={() => void disconnect()}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}
