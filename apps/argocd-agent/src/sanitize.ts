/**
 * What the agent sends of an Application and its Events.
 *
 * Afe maps the object with the AFE-10 capture code, which hashes the whole
 * `spec` (to notice changes, including Helm/Kustomize settings) and reads
 * image overrides from it, so `spec` is sent unchanged; Afe stores only the
 * minimised form (`minimiseApplication`) as evidence. Everything the mapping
 * never reads and that is large or may carry configuration is dropped here,
 * before it leaves the cluster:
 * - `metadata.managedFields`, and every annotation except the two the
 *   mapping reads (refresh request, tracking id). This removes
 *   `kubectl.kubernetes.io/last-applied-configuration`, a full copy of the object;
 * - `status.resources`, `status.conditions` and the per-resource sync
 *   messages (`status.operationState.syncResult.resources` keeps identity
 *   and status only).
 */
import type { ArgoCdApplication, ArgoCdKubeEvent } from "@afe/connector-argocd";

export const KEPT_ANNOTATIONS = [
  "argocd.argoproj.io/refresh",
  "argocd.argoproj.io/tracking-id",
] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export function sanitizeApplication(app: ArgoCdApplication): ArgoCdApplication {
  const out: Obj = {};
  const src = app as unknown as Obj;
  if (isObj(src.metadata)) {
    const { managedFields: _mf, annotations, ...md } = src.metadata as Obj;
    const kept: Record<string, string> = {};
    if (isObj(annotations)) {
      for (const k of KEPT_ANNOTATIONS) {
        const v = annotations[k];
        if (typeof v === "string") kept[k] = v;
      }
    }
    out.metadata = { ...md, ...(Object.keys(kept).length ? { annotations: kept } : {}) };
  }
  if (src.spec !== undefined) out.spec = src.spec;
  if (src.operation !== undefined) out.operation = src.operation;
  if (isObj(src.status)) {
    const { resources: _r, conditions: _c, operationState, ...status } = src.status as Obj;
    const st: Obj = { ...status };
    if (isObj(operationState)) {
      const os: Obj = { ...operationState };
      if (isObj(os.syncResult)) {
        const sr: Obj = { ...os.syncResult };
        if (Array.isArray(sr.resources)) {
          sr.resources = sr.resources.map((r) => {
            if (!isObj(r)) return {};
            const keep: Obj = {};
            for (const k of ["group", "version", "kind", "namespace", "name", "status", "hookPhase"])
              if (typeof r[k] === "string") keep[k] = r[k];
            return keep;
          });
        }
        os.syncResult = sr;
      }
      st.operationState = os;
    }
    out.status = st;
  }
  return out as ArgoCdApplication;
}

const EVENT_FIELDS = [
  "reason",
  "message",
  "type",
  "count",
  "firstTimestamp",
  "lastTimestamp",
  "eventTime",
  "reportingComponent",
] as const;

/** The fields of a core/v1 Event the attribution code reads. Newest first, at most `max`. */
export function sanitizeEvents(events: ArgoCdKubeEvent[], max = 50): ArgoCdKubeEvent[] {
  const time = (e: ArgoCdKubeEvent) =>
    Date.parse(
      e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp ?? "",
    ) || 0;
  return [...events]
    .sort((a, b) => time(b) - time(a))
    .slice(0, max)
    .map((e) => {
      const out: Obj = {};
      for (const k of EVENT_FIELDS) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
      if (e.metadata)
        out.metadata = {
          name: e.metadata.name,
          uid: e.metadata.uid,
          creationTimestamp: e.metadata.creationTimestamp,
        };
      if (e.involvedObject)
        out.involvedObject = {
          kind: e.involvedObject.kind,
          name: e.involvedObject.name,
          namespace: e.involvedObject.namespace,
          uid: e.involvedObject.uid,
        };
      if (e.source?.component) out.source = { component: e.source.component };
      if (typeof out.message === "string" && out.message.length > 2000)
        out.message = out.message.slice(0, 2000);
      return JSON.parse(JSON.stringify(out)) as ArgoCdKubeEvent;
    });
}
