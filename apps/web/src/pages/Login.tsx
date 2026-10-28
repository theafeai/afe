import { useId, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client.ts";
import type { SessionInfo } from "../api/types.ts";
import { useDocumentTitle } from "../components.tsx";
import { useNavigate, useSearchParams } from "../router.tsx";

/**
 * Where to go after login: `next` (set by the server when it redirected an
 * unauthenticated browser, e.g. an install callback) if it is a same-origin
 * path, else the timeline.
 */
export function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  try {
    const u = new URL(next, "http://afe.invalid");
    return u.origin === "http://afe.invalid" ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

export function LoginPage({ onLogin }: { onLogin: (session: SessionInfo) => void }) {
  useDocumentTitle("Sign in");
  const id = useId();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(token.trim());
      setToken("");
      onLogin(session);
      const next = safeNext(params.get("next"));
      if (next?.startsWith("/api/")) {
        // A server route (install/OAuth callback): let the browser load it.
        window.location.assign(next);
      } else if (next) {
        navigate(next, { replace: true });
      } else if (window.location.pathname === "/login") {
        navigate("/", { replace: true });
      }
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That token is not valid."
          : err instanceof Error
            ? err.message
            : "Sign-in failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>Sign in to Afe</h1>
      <p className="lede">Enter the access credential provided by your Afe administrator.</p>
      <section className="card">
        <form className="form" onSubmit={(e) => void submit(e)}>
          <div className="field">
            <label htmlFor={`${id}-token`}>Access token</label>
            <input
              id={`${id}-token`}
              type="password"
              required
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              aria-describedby={`${id}-help`}
            />
            <small id={`${id}-help`} className="muted">
              Afe keeps you signed in with a secure cookie; the token is not stored in the browser.
            </small>
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {error && (
          <div className="callout callout-error" role="alert">
            <strong>Not signed in.</strong> {error}
          </div>
        )}
      </section>
    </div>
  );
}
