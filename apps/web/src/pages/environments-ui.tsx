/**
 * Small building blocks of the environment matrix (AFE-24): what is live,
 * confidence and placement-kind badges, gap flags. Uncertainty is always
 * shown as text (never colour alone) and with the evidence behind it.
 */
import type {
  AttributionStatus,
  Confidence,
  GapFlagView,
  PlacementKind,
  PlacementSummary,
} from "../api/environments.ts";
import { journeyHref } from "../api/environments.ts";
import { gapReason, toolLabel } from "../components.tsx";
import { formatDateTime, formatRelative } from "../format.ts";
import { Link } from "../router.tsx";

/** A repository key such as `github.com/acme/shop` shown as `acme/shop`. */
export function shortRepo(repo: string | undefined): string {
  if (!repo) return "";
  return repo.replace(/^github\.com\//, "");
}

export const shortSha = (sha: string) => sha.slice(0, 7);

function shortImage(ref: string | undefined, digest: string | undefined): string {
  if (ref) {
    const name = ref.split("/").pop() ?? ref;
    // name:tag@sha256:… → name:tag
    return name.replace(/@sha256:[0-9a-f]+$/, "");
  }
  if (digest) return digest.slice(0, 19);
  return "image";
}

function shortDeployment(id: string): string {
  const rest = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return rest.length > 24 ? `${rest.slice(0, 23)}…` : rest;
}

export interface LiveLabel {
  /** What kind of identifier `text` is. */
  type: "commit" | "image" | "deployment" | "config" | "none";
  text: string;
  /** Full value for the tooltip. */
  title: string;
}

/** The short "what is live" identifier of a placement: commit, else image, else deployment. */
export function liveLabel(p: PlacementSummary): LiveLabel {
  const c = p.commits[0];
  if (c) {
    const more = p.commits.length > 1 ? ` +${p.commits.length - 1}` : "";
    return {
      type: "commit",
      text: `${shortSha(c.commitSha)}${more}`,
      title: p.commits.map((x) => `${shortRepo(x.repository)}@${x.commitSha}`).join("\n"),
    };
  }
  const img = p.images[0];
  if (img) {
    return {
      type: "image",
      text: shortImage(img.ref, img.digest),
      title: [img.ref, img.digest].filter(Boolean).join("\n"),
    };
  }
  const dep = p.deploymentIds[0];
  if (dep) return { type: "deployment", text: shortDeployment(dep), title: dep };
  if (p.configRevision) {
    return {
      type: "config",
      text: `config ${shortSha(p.configRevision.commitSha)}`,
      title: `${shortRepo(p.configRevision.repository)}@${p.configRevision.commitSha}`,
    };
  }
  return { type: "none", text: "—", title: "Nothing identifies the live content" };
}

const CONFIDENCE_HELP: Record<Confidence, string> = {
  certain: "Certain: same deployment, run or commit in the same repository",
  strong: "Strong: same image digest, same commit across repositories or same deployment URL",
  probable: "Probable: image tag with one producer, a tag naming the commit, or a GitOps reference",
  weak: "Weak: mutable tag or time proximity only",
};

export interface Certainty {
  /** CSS modifier and badge text. */
  level: Confidence | "ambiguous" | "unknown";
  label: string;
  help: string;
}

/** The one badge a placement gets: its confidence, or why there is none. */
export function certaintyOf(attribution: {
  status: AttributionStatus;
  confidence: Confidence | null;
}): Certainty {
  switch (attribution.status) {
    case "ambiguous":
      return {
        level: "ambiguous",
        label: "ambiguous",
        help: "Ambiguous: the image traces to several commits (mutable tag)",
      };
    case "unknown":
      return {
        level: "unknown",
        label: "unknown",
        help: "Unknown: nothing observed traces the live content to a commit",
      };
    case "guess":
      return {
        level: "weak",
        label: "weak guess",
        help: "Guess: no Git metadata; a weak guess from time proximity only",
      };
    default: {
      const c = attribution.confidence ?? "weak";
      return { level: c, label: c, help: CONFIDENCE_HELP[c] };
    }
  }
}

export function CertaintyBadge({
  attribution,
  detail,
}: {
  attribution: { status: AttributionStatus; confidence: Confidence | null };
  /** Evidence (e.g. `commits[0].via` or a note) appended to the tooltip. */
  detail?: string;
}) {
  const c = certaintyOf(attribution);
  return (
    <span className={`badge conf conf-${c.level}`} title={detail ? `${c.help}\n${detail}` : c.help}>
      {c.label}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span className={`badge conf conf-${confidence}`} title={CONFIDENCE_HELP[confidence]}>
      {confidence}
    </span>
  );
}

const KIND_HELP: Record<PlacementKind, string> = {
  deploy: "Deployed (automatic sync or pipeline)",
  promotion: "Promoted from another environment",
  rollback: "Rolled back to earlier content",
  redeploy: "Redeployed the same content",
  manual: "Changed manually (outside the usual pipeline)",
};

export function KindBadge({ kind }: { kind: PlacementKind }) {
  return (
    <span className={`badge kind kind-${kind}`} title={KIND_HELP[kind] ?? kind}>
      {kind}
    </span>
  );
}

export function GapFlagBadges({
  evidenceInGap,
  possiblyStale,
}: {
  evidenceInGap: boolean;
  possiblyStale: boolean;
}) {
  return (
    <>
      {evidenceInGap && (
        <span
          className="badge gap-badge"
          title="An event this placement relies on happened while its connection was not observed; related events may be missing"
        >
          evidence in a gap
        </span>
      )}
      {possiblyStale && (
        <span
          className="badge gap-badge"
          title="The connection had an observation gap after this went live: a later deployment may have been missed"
        >
          possibly stale
        </span>
      )}
    </>
  );
}

export function TimeAgo({ iso, prefix }: { iso: string; prefix?: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {prefix}
      {formatRelative(iso)}
    </time>
  );
}

/** One line per gap flag, with the gap's period and reason. */
export function GapList({ gaps }: { gaps: GapFlagView[] }) {
  if (gaps.length === 0) return null;
  return (
    <ul className="plain env-gaps">
      {gaps.map((g) => (
        <li key={`${g.gapId}:${g.relation}:${g.eventId}`} className="small">
          <span className="badge gap-badge">
            {g.relation === "evidence_in_gap" ? "evidence in a gap" : "possibly stale"}
          </span>{" "}
          {toolLabel(g.source)} was not observed from{" "}
          <time dateTime={g.startedAt}>{formatDateTime(g.startedAt)}</time>{" "}
          {g.endedAt ? (
            <>
              to <time dateTime={g.endedAt}>{formatDateTime(g.endedAt)}</time>
            </>
          ) : (
            "until now (gap still open)"
          )}{" "}
          ({gapReason(g.reason)}).{" "}
          {g.relation === "evidence_in_gap" ? (
            <Link to={`/events/${g.eventId}`}>Event in the gap</Link>
          ) : (
            "A later deployment may have been missed."
          )}
        </li>
      ))}
    </ul>
  );
}

/** Commits, images and config revision of a placement, with how each was attributed. */
export function PlacementContent({ p }: { p: PlacementSummary }) {
  return (
    <div className="env-content">
      {p.commits.length > 0 ? (
        <ul className="plain">
          {p.commits.map((c) => (
            <li key={`${c.repository ?? ""}@${c.commitSha}`}>
              <code title={c.commitSha}>{shortSha(c.commitSha)}</code>{" "}
              <span className="muted">{shortRepo(c.repository)}</span>{" "}
              <ConfidenceBadge confidence={c.confidence} />
              {c.repository && (
                <>
                  {" "}
                  <Link to={journeyHref(c.repository, c.commitSha)} className="small">
                    Journey
                  </Link>
                </>
              )}
              <div className="small muted env-via">{c.via}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small env-nocommit">No app commit attributed.</p>
      )}
      {p.images.length > 0 && (
        <ul className="plain small">
          {p.images.map((img, i) => (
            <li key={`${img.ref ?? ""}${img.digest ?? ""}${i}`}>
              Image <code className="hash">{img.ref ?? img.digest}</code>
              {img.ref && img.digest && !img.ref.includes("@") && (
                <span className="muted"> ({img.digest.slice(0, 19)}…)</span>
              )}
              {img.builds.length === 0 && (
                <span className="muted"> — no observed build produced it</span>
              )}
              {img.builds.length > 1 && (
                <span className="muted"> — {img.builds.length} candidate builds</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {p.configRevision && (
        <p className="small">
          Config revision{" "}
          <code title={p.configRevision.commitSha}>{shortSha(p.configRevision.commitSha)}</code>{" "}
          <span className="muted">{shortRepo(p.configRevision.repository)}</span>
          {p.configRevision.repository && (
            <>
              {" "}
              <Link to={journeyHref(p.configRevision.repository, p.configRevision.commitSha)}>
                Journey
              </Link>
            </>
          )}
        </p>
      )}
      {p.notes.length > 0 && (
        <ul className="plain env-notes small">
          {p.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const HOW_LABEL: Record<string, string> = {
  auto_sync: "automatic sync",
  cli: "CLI",
  ui: "UI",
  api: "API",
};

/** "manual by alice", "automatic sync". */
export function howText(p: { how: string; actor: string | null }): string {
  const how = HOW_LABEL[p.how] ?? p.how.replace(/_/g, " ");
  return p.actor ? `${how} by ${p.actor}` : how;
}
