import { useState, type FormEvent } from "react";
import { useAccess } from "../access.tsx";
import { request } from "../api/client.ts";
import {
  Empty,
  ErrorBox,
  KeyValue,
  Loading,
  SectionHead,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { useToast } from "../toast.tsx";

type EmailDelivery = {
  enabled: boolean;
  configured: boolean;
  from: string | null;
  deliveries: { id: string; state: string; attempts: number }[];
};

export function SettingsPage() {
  useDocumentTitle("Settings");
  const { admin } = useAccess();
  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="lede">Manage account-level configuration.</p>
        </div>
      </div>
      {admin ? <EmailDeliverySettings /> : <p>Administrator access required</p>}
    </div>
  );
}

function EmailDeliverySettings() {
  const { data, error, loading, reload } = useAsync(
    (signal) => request<EmailDelivery>("GET", "/api/admin/email", undefined, signal),
    [],
  );
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const toast = useToast();

  async function sendTest(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await request("POST", "/api/admin/email/test", { email });
      toast("Test email queued.");
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err : new Error("Request failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="email-delivery-title">
      <SectionHead title="Email delivery" id="email-delivery-title" />
      {loading ? (
        <Loading label="Loading email delivery settings…" />
      ) : error ? (
        <ErrorBox
          title="Email delivery settings could not be loaded"
          error={error}
          onRetry={reload}
        />
      ) : data?.configured ? (
        <div className="form">
          <KeyValue items={[["Sender", data.from]]} />
          <form className="form" onSubmit={(e) => void sendTest(e)}>
            <div className="field">
              <label htmlFor="test-email">Test recipient</label>
              <input
                id="test-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="button-row">
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Sending test email…" : "Send test email"}
              </button>
            </div>
          </form>
          {failure && <ErrorBox title="Test email was not queued" error={failure} />}
          <section aria-labelledby="recent-deliveries-title">
            <SectionHead
              id="recent-deliveries-title"
              title="Recent deliveries"
              action={
                <button className="btn btn-sm" onClick={reload} disabled={busy}>
                  Refresh delivery status
                </button>
              }
            />
            {data.deliveries.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">
                        Attempts
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.deliveries.map((delivery) => (
                      <tr key={delivery.id}>
                        <td>{delivery.state}</td>
                        <td className="num">{delivery.attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No recent deliveries">
                <p>Send a test email to check delivery, then refresh its status.</p>
              </Empty>
            )}
          </section>
        </div>
      ) : (
        <p>
          Email is disabled. An operator can configure SMTP to enable invitations and reset links.
        </p>
      )}
    </section>
  );
}
