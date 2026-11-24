import type { ReactNode } from "react";
import { toolLinkState } from "../api/client.ts";
import { Empty, ErrorBox, toolLabel } from "../components.tsx";
import { icons } from "../icons.tsx";
import { Link } from "../router.tsx";

/**
 * The first-run state of a tool page (AFE-118). Afe acts in each tool with the
 * person's own login (D-0022), so "not linked yet" is expected: it is shown as a
 * calm empty state with the way to Profile, not as an error. Every other error,
 * including real permission denials, still renders `ErrorBox`.
 */
export function ToolPageError({
  error,
  onRetry,
  title,
  shows,
}: {
  error: Error;
  onRetry?: () => void;
  title?: string;
  /** What the page lists once linked, e.g. "your Vercel projects". */
  shows: string;
}) {
  const link = toolLinkState(error);
  if (!link)
    return (
      <ErrorBox error={error} {...(onRetry ? { onRetry } : {})} {...(title ? { title } : {})} />
    );
  const name = toolLabel(link.tool);
  let body: ReactNode;
  if (link.reason === "named_user_required")
    body = (
      <p>
        Afe acts in {name} with each person&apos;s own {name} login. This session uses a shared Afe
        credential, which cannot hold one. Sign in as a named Afe user, then link {name} in Profile
        to see {shows} here.
      </p>
    );
  else
    body = (
      <p>
        Afe acts in {name} with your own {name} login, so you see and do only what {name} already
        allows you. Link your account in Profile to see {shows} here.
      </p>
    );
  return (
    <Empty
      icon={icons.profile}
      title={
        link.reason === "named_user_required"
          ? `Sign in as a named user to use ${name}`
          : `Link your ${name} account`
      }
    >
      {body}
      <Link className="btn" to="/profile">
        {link.reason === "named_user_required" ? "Open Profile" : `Link ${name} in Profile`}
      </Link>
    </Empty>
  );
}
