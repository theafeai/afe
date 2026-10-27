/**
 * Which raw values each tool emits, as mapping fields (AFE-19). Read from the
 * canonical event only (plus ArgoCD labels when the caller supplies them),
 * so resolution happens at read time and never changes the stored log.
 */
import { LABEL_FIELD_PREFIX, MAPPING_FIELDS, type Observations } from "./types.ts";

/** The parts of an event the resolver reads. `CanonicalEvent` satisfies it. */
export interface MappableEvent {
  source: string;
  target: {
    type?: string;
    id?: string;
    name?: string | null;
    repository?: string | null;
    project?: string | null;
    application?: string | null;
    environment?: string | null;
    cluster?: string | null;
    namespace?: string | null;
  };
  correlation?: { environments?: string[] | null; repositories?: string[] | null } | null;
  data?: Record<string, unknown> | null;
  /**
   * ArgoCD application labels (`metadata.labels`), when known. Events do not
   * carry labels; the server reads them from the stored raw payload when a
   * rule uses an `argocd.label:<key>` field.
   */
  labels?: Record<string, string> | null;
}

const LABEL_KEY = /^[A-Za-z0-9]([A-Za-z0-9._/-]{0,251}[A-Za-z0-9])?$/;

/** True for a field a rule may use. */
export function isMappingField(field: string): boolean {
  if ((MAPPING_FIELDS as readonly string[]).includes(field)) return true;
  return field.startsWith(LABEL_FIELD_PREFIX) && LABEL_KEY.test(field.slice(LABEL_FIELD_PREFIX.length));
}

/** The source a field belongs to (`argocd.label:x` → `argocd`). */
export function fieldSource(field: string): string {
  return field.slice(0, field.indexOf("."));
}

function add(out: Observations, field: string, ...values: (string | null | undefined)[]) {
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0) continue;
    const list = (out[field] ??= []);
    if (!list.includes(v)) list.push(v);
  }
}

/** Strips a host prefix from "github.com/owner/name" keys. */
function ownerName(repoKey: string): string {
  const parts = repoKey.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : repoKey;
}

/**
 * Raw values per mapping field for one event. Multi-valued: a rule matches
 * when any value of its field matches.
 */
export function observationsOf(e: MappableEvent): Observations {
  const out: Observations = {};
  const t = e.target;
  const env = t.environment ?? e.correlation?.environments?.[0] ?? null;
  switch (e.source) {
    case "github":
      add(out, "github.environment", env);
      add(
        out,
        "github.repository",
        t.repository ?? (e.correlation?.repositories?.[0] ? ownerName(e.correlation.repositories[0]) : null),
      );
      break;
    case "argocd":
      add(out, "argocd.application", t.application ?? t.name);
      add(out, "argocd.project", t.project);
      add(out, "argocd.namespace", t.namespace);
      add(out, "argocd.cluster", t.cluster);
      add(out, "argocd.environment", env);
      add(out, "argocd.repository", t.repository);
      for (const [k, v] of Object.entries(e.labels ?? {})) {
        if (typeof v === "string" && LABEL_KEY.test(k)) add(out, `${LABEL_FIELD_PREFIX}${k}`, v);
      }
      break;
    case "vercel": {
      const projectName = typeof e.data?.projectName === "string" ? e.data.projectName : null;
      add(out, "vercel.project", t.project, projectName, t.name);
      add(out, "vercel.target", env);
      add(out, "vercel.repository", t.repository);
      break;
    }
  }
  return out;
}

/** Stable cache key of the observations (fields sorted). */
export function observationKey(source: string, o: Observations): string {
  const fields = Object.keys(o).sort();
  return JSON.stringify([source, ...fields.map((f) => [f, o[f]])]);
}
