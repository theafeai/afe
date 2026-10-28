import { useEffect, useState, type FormEvent } from "react";
import { request } from "../api/client.ts";
import { ErrorBox, useDocumentTitle } from "../components.tsx";
import { Link } from "../router.tsx";

export function AccountEmailPage({ redeem = false }: { redeem?: boolean }) {
  useDocumentTitle(redeem ? "Accept invitation or reset credential" : "Reset credential");
  const [token] = useState(() => (redeem ? window.location.hash.slice(1) : ""));
  const [email, setEmail] = useState("");
  const [credential, setCredential] = useState<string | null>(null);
  const [done, setDone] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (redeem) window.history.replaceState(null, "", window.location.pathname);
  }, [redeem]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (redeem) {
        const result = await request<{ token: string }>("POST", "/api/account/redeem", { token });
        setCredential(result.token);
      } else await request("POST", "/api/account/reset", { email });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e : new Error("Request failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page narrow">
      <h1>{redeem ? "Your Afe access credential" : "Reset your access credential"}</h1>
      {credential ? (
        <section className="card">
          <h2>Save this credential now</h2>
          <p>
            It is shown only once. Use it to sign in to Afe. Your previous credential and sessions
            have ended.
          </p>
          <textarea aria-label="New access credential" readOnly value={credential} />
          <Link to="/login">Continue to sign in</Link>
        </section>
      ) : done ? (
        <p role="status">
          If an active account uses that email address, a reset link will arrive shortly. Check your
          inbox or contact your administrator.
        </p>
      ) : (
        <form className="form card" onSubmit={(e) => void submit(e)}>
          {redeem ? (
            <p>
              Continue to accept your invitation or reset your credential. This ends any existing
              sessions for this account.
            </p>
          ) : (
            <>
              <label htmlFor="reset-email">Email address</label>
              <input
                id="reset-email"
                type="email"
                required
                autoComplete="email"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </>
          )}
          <button className="btn btn-primary" disabled={busy || (redeem && !token)}>
            {busy ? "Please wait…" : redeem ? "Continue" : "Email reset link"}
          </button>
          {redeem && !token && <p>This link is missing. Open the complete link from your email.</p>}
        </form>
      )}
      {error && <ErrorBox error={error} />}
      <p>
        <Link to="/login">Back to sign in</Link>
      </p>
    </div>
  );
}

export function EmailRecoveryLink() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void request<{ enabled: boolean }>("GET", "/api/account/email", undefined, c.signal)
      .then((r) => setEnabled(r.enabled))
      .catch(() => {});
    return () => c.abort();
  }, []);
  return enabled ? (
    <p>
      <Link to="/account/reset">Forgot your access credential?</Link>
    </p>
  ) : null;
}
