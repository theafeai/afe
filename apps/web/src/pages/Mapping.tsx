/**
 * Settings → Mapping (AFE-19): services, environments, the rules that assign
 * events to them, built-in defaults, a live preview of how recent
 * deployments classify, and raw values no rule maps yet.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  mappingApi,
  ruleBody,
  type EnvironmentKind,
  type MappingState,
  type MatchType,
  type PlacementView,
  type PreviewResult,
  type RuleDraft,
  type RuleKind,
  type RuleView,
  type UnmappedValue,
} from "../api/mapping.ts";
import { Empty, ErrorBox, Loading, ToolBadge, useAsync, useDocumentTitle } from "../components.tsx";
import { formatDateTime } from "../format.ts";
import { Link } from "../router.tsx";

const LABEL_FIELD = "argocd.label:<key>";
const MATCH_LABEL: Record<MatchType, string> = {
  exact: "is",
  glob: "matches glob",
  regex: "matches regex",
};
const CONFIDENCE_LABEL: Record<string, string> = {
  configured: "Configured",
  default: "Built-in default",
  partial: "Partly unmapped",
  unmapped: "Unmapped",
};

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function emptyDraft(kind: RuleKind, state: MappingState): RuleDraft {
  const targets = kind === "service" ? state.services : state.environments;
  return {
    kind,
    field: kind === "service" ? "github.repository" : "github.environment",
    match: "exact",
    pattern: "",
    caseSensitive: false,
    targetId: targets[0]?.id ?? "",
    enabled: true,
  };
}

function draftValid(d: RuleDraft): boolean {
  return Boolean(d.pattern && d.targetId && d.field && !d.field.endsWith(":"));
}

function placementText(p: PlacementView): string {
  const svc = p.service?.name ?? "unmapped service";
  const env = p.environment?.name ?? "unmapped environment";
  return `${svc} → ${env}`;
}

export function MappingPage() {
  useDocumentTitle("Mapping");
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const state = useAsync((s) => mappingApi.get(s), [tick]);
  const unmapped = useAsync((s) => mappingApi.unmapped(s), [tick]);
  const current = useAsync((s) => mappingApi.preview({ items: 20 }, s), [tick]);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);

  async function act(what: () => Promise<unknown>, done: string) {
    setActionError(null);
    setNotice(null);
    try {
      await what();
      setNotice(done);
      reload();
      return true;
    } catch (err) {
      setActionError(errorOf(err));
      return false;
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Environment and service mapping</h1>
          <p className="lede">
            How deployments from GitHub, ArgoCD and Vercel are grouped into services (rows) and
            environments (columns). Rules apply when events are read: changing them never rewrites
            the audit log, and every change is itself recorded in it.
          </p>
        </div>
      </header>
      {notice && (
        <div className="callout callout-ok" role="status">
          {notice}
        </div>
      )}
      {actionError && <ErrorBox error={actionError} title="The change was not saved" />}
      {state.loading && !state.data ? (
        <Loading label="Loading mapping…" />
      ) : state.error || !state.data ? (
        <ErrorBox
          error={state.error ?? new Error("no data")}
          onRetry={state.reload}
          title="Could not load the mapping"
        />
      ) : (
        <>
          <div className="grid-2">
            <ServicesCard state={state.data} act={act} />
            <EnvironmentsCard state={state.data} act={act} />
          </div>
          {(["service", "environment"] as const).map((kind) => (
            <RulesTable
              key={kind}
              kind={kind}
              state={state.data!}
              act={act}
              onEdit={(r) => setDraft({ ...r })}
              onAdd={() => setDraft(emptyDraft(kind, state.data!))}
            />
          ))}
          {draft && (
            <RuleForm
              key={draft.id ?? "new"}
              state={state.data}
              initial={draft}
              onCancel={() => setDraft(null)}
              onSave={async (d) => {
                const ok = await act(
                  () => (d.id ? mappingApi.updateRule(d.id, d) : mappingApi.createRule(d)),
                  d.id ? "Rule saved." : "Rule added.",
                );
                if (ok) setDraft(null);
              }}
            />
          )}
          <BuiltinRules state={state.data} act={act} />
          <UnmappedValues
            data={unmapped.data?.values ?? null}
            loading={unmapped.loading}
            error={unmapped.error}
            onCreate={(v) => {
              const kind: RuleKind = v.missing.includes("service") ? "service" : "environment";
              setDraft({
                ...emptyDraft(kind, state.data!),
                field: v.field,
                match: "exact",
                pattern: v.value,
              });
            }}
          />
          <CurrentClassification
            data={current.data}
            loading={current.loading}
            error={current.error}
          />
        </>
      )}
    </div>
  );
}

type Act = (what: () => Promise<unknown>, done: string) => Promise<boolean>;

function ServicesCard({ state, act }: { state: MappingState; act: Act }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await act(
      () =>
        mappingApi.createService({ name: name.trim(), description: description.trim() || null }),
      `Service “${name.trim()}” added.`,
    );
    if (ok) {
      setName("");
      setDescription("");
    }
  };
  return (
    <section className="card" aria-labelledby="services-h">
      <h2 id="services-h">Services</h2>
      {state.services.length === 0 ? (
        <p className="muted">No services yet. Every deployment shows as “unmapped service”.</p>
      ) : (
        <ul className="plain">
          {state.services.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong> <code className="small">{s.id}</code>
              {s.description && <span className="muted"> — {s.description}</span>}{" "}
              <button
                type="button"
                className="btn-link"
                aria-label={`Delete service ${s.name}`}
                onClick={() =>
                  void act(() => mappingApi.deleteService(s.id), `Service “${s.name}” deleted.`)
                }
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="svc-name">Service name</label>
          <input
            id="svc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={128}
          />
        </div>
        <div className="field">
          <label htmlFor="svc-desc">Description (optional)</label>
          <input
            id="svc-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={1024}
          />
        </div>
        <button type="submit" className="btn" disabled={!name.trim()}>
          Add service
        </button>
      </form>
    </section>
  );
}

function EnvironmentsCard({ state, act }: { state: MappingState; act: Act }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<EnvironmentKind>("other");
  const envs = state.environments;
  const move = (i: number, by: number) => {
    const a = envs[i]!;
    const b = envs[i + by]!;
    void act(async () => {
      await mappingApi.updateEnvironment(a.id, { name: a.name, kind: a.kind, order: b.order });
      await mappingApi.updateEnvironment(b.id, { name: b.name, kind: b.kind, order: a.order });
    }, "Column order saved.");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await act(
      () => mappingApi.createEnvironment({ name: name.trim(), kind }),
      `Environment “${name.trim()}” added.`,
    );
    if (ok) setName("");
  };
  return (
    <section className="card" aria-labelledby="envs-h">
      <h2 id="envs-h">Environments</h2>
      {!state.customised && (
        <p className="muted small">Built-in defaults; your first change makes them your own.</p>
      )}
      <ol className="plain">
        {envs.map((e, i) => (
          <li key={e.id}>
            <strong>{e.name}</strong> <code className="small">{e.id}</code>{" "}
            <span className="muted">({e.kind})</span>{" "}
            <button
              type="button"
              className="btn-link"
              aria-label={`Move environment ${e.name} left`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ←
            </button>
            <button
              type="button"
              className="btn-link"
              aria-label={`Move environment ${e.name} right`}
              disabled={i === envs.length - 1}
              onClick={() => move(i, 1)}
            >
              →
            </button>{" "}
            <button
              type="button"
              className="btn-link"
              aria-label={`Delete environment ${e.name}`}
              onClick={() =>
                void act(
                  () => mappingApi.deleteEnvironment(e.id),
                  `Environment “${e.name}” deleted.`,
                )
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ol>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="env-name">Environment name</label>
          <input
            id="env-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={128}
          />
        </div>
        <div className="field">
          <label htmlFor="env-kind">Kind</label>
          <select
            id="env-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as EnvironmentKind)}
          >
            {state.environmentKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn" disabled={!name.trim()}>
          Add environment
        </button>
      </form>
    </section>
  );
}

function targetName(state: MappingState, kind: RuleKind, id: string): string {
  const list = kind === "service" ? state.services : state.environments;
  return list.find((x) => x.id === id)?.name ?? id;
}

function RulesTable({
  kind,
  state,
  act,
  onEdit,
  onAdd,
}: {
  kind: RuleKind;
  state: MappingState;
  act: Act;
  onEdit: (r: RuleView) => void;
  onAdd: () => void;
}) {
  const rules = state.rules.filter((r) => r.kind === kind);
  const title = kind === "service" ? "Service rules" : "Environment rules";
  const move = (i: number, by: number) => {
    const ids = rules.map((r) => r.id);
    [ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!];
    void act(() => mappingApi.reorderRules(kind, ids), "Rule order saved.");
  };
  return (
    <section className="card" aria-labelledby={`rules-${kind}`}>
      <div className="toolbar">
        <h2 id={`rules-${kind}`}>{title}</h2>
        <button type="button" className="btn" onClick={onAdd}>
          Add {kind} rule
        </button>
      </div>
      <p className="muted small">
        Checked top to bottom; the first match wins. Your rules come before the built-in defaults.
      </p>
      {rules.length === 0 ? (
        <p className="muted">No {kind} rules.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Assigns</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="skip">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={r.id}>
                  <td>{i + 1}</td>
                  <td>
                    <code>{r.field}</code> {MATCH_LABEL[r.match]} <code>{r.pattern}</code>
                    {r.caseSensitive && <span className="muted small"> (case-sensitive)</span>}
                  </td>
                  <td>{targetName(state, kind, r.targetId)}</td>
                  <td>
                    {r.inactiveReason ? (
                      <span className="muted">Inactive: {r.inactiveReason}</span>
                    ) : (
                      "Active"
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-link"
                      aria-label={`Move rule ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn-link"
                      aria-label={`Move rule ${i + 1} down`}
                      disabled={i === rules.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>{" "}
                    <button
                      type="button"
                      className="btn-link"
                      aria-label={`Edit rule ${r.pattern}`}
                      onClick={() => onEdit(r)}
                    >
                      Edit
                    </button>{" "}
                    <button
                      type="button"
                      className="btn-link"
                      aria-label={`Delete rule ${r.pattern}`}
                      onClick={() => void act(() => mappingApi.deleteRule(r.id), "Rule deleted.")}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Splits `argocd.label:team` into the select value and the key. */
function splitField(field: string): { choice: string; labelKey: string } {
  return field.startsWith("argocd.label:")
    ? { choice: LABEL_FIELD, labelKey: field.slice("argocd.label:".length) }
    : { choice: field, labelKey: "" };
}

function RuleForm({
  state,
  initial,
  onSave,
  onCancel,
}: {
  state: MappingState;
  initial: RuleDraft;
  onSave: (d: RuleDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<RuleDraft>(initial);
  const [labelKey, setLabelKey] = useState(splitField(initial.field).labelKey);
  const choice = splitField(d.field).choice;
  const targets = d.kind === "service" ? state.services : state.environments;
  const effective: RuleDraft =
    choice === LABEL_FIELD ? { ...d, field: `argocd.label:${labelKey}` } : d;
  const valid = draftValid(effective) && targets.some((t) => t.id === effective.targetId);
  const set = (patch: Partial<RuleDraft>) => setD((x) => ({ ...x, ...patch }));

  // Live preview: proposed rules = current rules with this draft in place.
  const effectiveKey = JSON.stringify(effective);
  const proposedRules = useMemo(() => {
    const rest: RuleDraft[] = state.rules.map((r) => ({ ...r }));
    const all = effective.id
      ? rest.map((r) => (r.id === effective.id ? { ...effective, priority: r.priority } : r))
      : [
          ...rest,
          { ...effective, priority: Math.max(0, ...state.rules.map((r) => r.priority)) + 10 },
        ];
    // Only the API's rule fields (the preview body is strict).
    return all.map((r) => ({ ...(r.id ? { id: r.id } : {}), ...ruleBody(r) }));
  }, [state.rules, effectiveKey]);
  const [preview, setPreview] = useState<{ data: PreviewResult | null; error: Error | null }>({
    data: null,
    error: null,
  });
  const previewKey = valid ? JSON.stringify(proposedRules) : "";
  useEffect(() => {
    if (!previewKey) {
      setPreview({ data: null, error: null });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      mappingApi
        .preview({ rules: proposedRules, items: 20 }, ctrl.signal)
        .then((data) => setPreview({ data, error: null }))
        .catch((err: unknown) => {
          if (!ctrl.signal.aborted) setPreview({ data: null, error: errorOf(err) });
        });
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [previewKey]);

  return (
    <section className="card" aria-labelledby="rule-form-h">
      <h2 id="rule-form-h">{d.id ? "Edit rule" : "New rule"}</h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void onSave(effective);
        }}
      >
        <div className="field">
          <label htmlFor="rule-kind">Assigns</label>
          <select
            id="rule-kind"
            value={d.kind}
            onChange={(e) => {
              const kind = e.target.value as RuleKind;
              const list = kind === "service" ? state.services : state.environments;
              set({ kind, targetId: list[0]?.id ?? "" });
            }}
          >
            <option value="service">a service</option>
            <option value="environment">an environment</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-field">Field</label>
          <select
            id="rule-field"
            value={choice}
            onChange={(e) =>
              set({ field: e.target.value === LABEL_FIELD ? "argocd.label:" : e.target.value })
            }
          >
            {state.fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        {choice === LABEL_FIELD && (
          <div className="field">
            <label htmlFor="rule-label">Label key</label>
            <input id="rule-label" value={labelKey} onChange={(e) => setLabelKey(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="rule-match">Match</label>
          <select
            id="rule-match"
            value={d.match}
            onChange={(e) => set({ match: e.target.value as MatchType })}
          >
            <option value="exact">is exactly</option>
            <option value="glob">glob (* and ?)</option>
            <option value="regex">regular expression (safe subset)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-pattern">Pattern</label>
          <input
            id="rule-pattern"
            value={d.pattern}
            maxLength={256}
            onChange={(e) => set({ pattern: e.target.value })}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={d.caseSensitive}
            onChange={(e) => set({ caseSensitive: e.target.checked })}
          />{" "}
          Case-sensitive
        </label>
        <div className="field">
          <label htmlFor="rule-target">{d.kind === "service" ? "Service" : "Environment"}</label>
          <select
            id="rule-target"
            value={d.targetId}
            onChange={(e) => set({ targetId: e.target.value })}
          >
            {targets.length === 0 && <option value="">(add one first)</option>}
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={d.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={!valid}>
            Save rule
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
      <div aria-live="polite">
        {preview.error && <ErrorBox error={preview.error} title="Preview failed" />}
        {preview.data && <PreviewSummary data={preview.data} />}
      </div>
    </section>
  );
}

function PreviewSummary({ data }: { data: PreviewResult }) {
  const changed = data.items.filter((i) => i.changed);
  return (
    <div className="preview">
      <h3>Preview</h3>
      <p>
        {data.summary.changed} of {data.sampleSize} recent deployment events would change.
      </p>
      {data.inactive.length > 0 && (
        <p className="muted small">
          Inactive: {data.inactive.map((i) => `${i.ruleId} (${i.reason})`).join("; ")}
        </p>
      )}
      {changed.length > 0 && (
        <ul className="plain">
          {changed.map((i) => (
            <li key={i.eventId}>
              <ToolBadge source={i.source} /> {i.label}: {placementText(i.current)} ⇒{" "}
              <strong>{placementText(i.proposed)}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BuiltinRules({ state, act }: { state: MappingState; act: Act }) {
  return (
    <section className="card" aria-labelledby="builtin-h">
      <details>
        <summary>
          <h2 id="builtin-h" style={{ display: "inline" }}>
            Built-in defaults ({state.builtinRules.filter((r) => r.enabled).length} of{" "}
            {state.builtinRules.length} on)
          </h2>
        </summary>
        <p className="muted small">
          Applied after your rules. Switch one off, or add a rule above, to override it.
        </p>
        <ul className="plain">
          {state.builtinRules.map((r) => (
            <li key={r.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) =>
                    void act(
                      () => mappingApi.setBuiltin(r.id, e.target.checked),
                      `Built-in rule ${e.target.checked ? "enabled" : "disabled"}.`,
                    )
                  }
                />{" "}
                <code>{r.field}</code> {MATCH_LABEL[r.match]} <code>{r.pattern}</code> →{" "}
                {targetName(state, r.kind, r.targetId)}
                {r.inactiveReason && r.enabled && (
                  <span className="muted small"> (inactive: {r.inactiveReason})</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function UnmappedValues({
  data,
  loading,
  error,
  onCreate,
}: {
  data: UnmappedValue[] | null;
  loading: boolean;
  error: Error | null;
  onCreate: (v: UnmappedValue) => void;
}) {
  return (
    <section className="card" aria-labelledby="unmapped-h">
      <h2 id="unmapped-h">Unmapped values</h2>
      <p className="muted small">
        Raw names seen on recent deployments that are not fully mapped. Create a rule from one.
      </p>
      {loading && !data ? (
        <Loading label="Looking for unmapped values…" />
      ) : error ? (
        <ErrorBox error={error} title="Could not load unmapped values" />
      ) : !data || data.length === 0 ? (
        <Empty title="Everything recent is mapped" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Value</th>
                <th scope="col">Events</th>
                <th scope="col">Missing</th>
                <th scope="col">
                  <span className="skip">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((v) => (
                <tr key={`${v.field}\u0000${v.value}`}>
                  <td>
                    <code>{v.field}</code>
                  </td>
                  <td>
                    <code>{v.value}</code>
                  </td>
                  <td>
                    <Link to={`/events/${v.exampleEventId}`} title={formatDateTime(v.lastSeen)}>
                      {v.count}
                    </Link>
                  </td>
                  <td>{v.missing.join(", ")}</td>
                  <td>
                    <button
                      type="button"
                      className="btn-link"
                      aria-label={`Create rule from ${v.field} ${v.value}`}
                      onClick={() => onCreate(v)}
                    >
                      Create rule
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CurrentClassification({
  data,
  loading,
  error,
}: {
  data: PreviewResult | null;
  loading: boolean;
  error: Error | null;
}) {
  return (
    <section className="card" aria-labelledby="classify-h">
      <h2 id="classify-h">How recent deployments classify</h2>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} title="Could not classify recent deployments" />
      ) : !data || data.sampleSize === 0 ? (
        <p className="muted">No deployments recorded yet.</p>
      ) : (
        <>
          <p>
            Of {data.sampleSize} recent deployment events:{" "}
            {Object.entries(data.summary.current)
              .map(([k, n]) => `${n} ${CONFIDENCE_LABEL[k]?.toLowerCase() ?? k}`)
              .join(", ")}
            .
          </p>
          <ul className="plain">
            {data.items.map((i) => (
              <li key={i.eventId}>
                <ToolBadge source={i.source} /> {i.label}: {placementText(i.current)}{" "}
                <span className="muted small">({CONFIDENCE_LABEL[i.current.confidence]})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
