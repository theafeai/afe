import { EmailRecoveryLink } from "./AccountEmail.tsx";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api, ApiError, request } from "../api/client.ts";
import type { SessionInfo } from "../api/types.ts";
import { useDocumentTitle } from "../components.tsx";
import { BrandMark } from "../icons.tsx";
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

const GITHUB_ERRORS: Record<string, string> = {
  not_linked: "No Afe account is linked to this GitHub account. Ask your administrator.",
  not_member: "Your GitHub account is not an active member of an allowed organization.",
  disabled: "This Afe account is disabled.",
  github_disabled: "GitHub access is turned off for this Afe account.",
  identity_in_use: "This GitHub account is linked to another Afe user.",
  invalid_state: "The sign-in link expired or was opened in another browser. Try again.",
  rate_limited: "Too many sign-in attempts. Try again later.",
  unavailable: "Sign in with GitHub is not enabled.",
  failed: "GitHub sign-in failed. Try again.",
};

/** "Sign in with GitHub", shown only when the server has it enabled (M1). */
function GitHubSignIn({ next }: { next: string | null }) {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void request<{ available: boolean }>("GET", "/api/login/github/available", undefined, c.signal)
      .then((r) => setAvailable(r.available))
      .catch(() => {});
    return () => c.abort();
  }, []);
  if (!available) return null;
  const start = async () => {
    setBusy(true);
    try {
      const { url } = await request<{ url: string }>("POST", "/api/login/github", {
        next: next && !next.startsWith("/api/") ? next : "/",
      });
      window.location.assign(url);
    } catch {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn btn-wide" disabled={busy} onClick={() => void start()}>
      {busy ? "Opening GitHub…" : "Sign in with GitHub"}
    </button>
  );
}

export function LoginPage({ onLogin }: { onLogin: (session: SessionInfo) => void }) {
  useDocumentTitle("Sign in");
  const id = useId();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const githubError = params.get("github_error");
  const [error, setError] = useState<string | null>(
    githubError ? (GITHUB_ERRORS[githubError] ?? GITHUB_ERRORS.failed!) : null,
  );
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
    <div className="login">
      <section className="card login-card">
        <BrandMark />
        <h1>Sign in to Afe</h1>
        <p className="lede">Enter the access credential provided by your Afe administrator.</p>
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
          <button type="submit" className="btn btn-primary btn-wide" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <GitHubSignIn next={safeNext(params.get("next"))} />
        {error && (
          <div className="callout callout-error" role="alert">
            <strong>Not signed in.</strong> {error}
          </div>
        )}
        <EmailRecoveryLink />
      </section>
      <p className="login-foot">Live deployment visibility across your delivery tools.</p>
    </div>
  );
}
