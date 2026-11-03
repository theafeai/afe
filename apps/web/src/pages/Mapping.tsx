import { useAccess } from "../access.tsx";
/**
 * Settings → Mapping (AFE-19): services, environments, the rules that assign
 * events to them, built-in defaults, a live preview of how recent
 * deployments classify, and raw values no rule maps yet.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
import {
  Empty,
  ErrorBox,
  Loading,
  SectionHead,
  ToolBadge,
  useAsync,
  useDocumentTitle,
} from "../components.tsx";
import { formatDateTime } from "../format.ts";
import { icons } from "../icons.tsx";
import { Link } from "../router.tsx";
import { useToast } from "../toast.tsx";
import "./Mapping.css";

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
  const { managed } = useAccess();
  return managed ? <ScopedMappingPage /> : <EditableMappingPage />;
}
function ScopedMappingPage() {
  useDocumentTitle("Mapping");
  const state = useAsync((s) => mappingApi.get(s), []);
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Environment and service mapping</h1>
          <p className="lede">
            Services and environments observed in your most recent permitted deployment events.
            Mapping rules are managed by your administrator.
          </p>
        </div>
      </header>
      {state.loading ? (
        <Loading label="Loading mapping…" />
      ) : state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : (
        <div className="grid-2">
          <section className="card" aria-labelledby="services-h">
            <SectionHead id="services-h" title="Services" count={state.data?.services.length} />
            <ul className="entity-list">
              {state.data?.services.map((s) => (
                <li key={s.id}>
                  <span className="entity-main">
                    <span className="entity-name">
                      <strong>{s.name}</strong>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card" aria-labelledby="envs-h">
            <SectionHead id="envs-h" title="Environments" count={state.data?.environments.length} />
            <ol className="entity-list">
              {state.data?.environments.map((e) => (
                <li key={e.id}>
                  <span className="entity-main">
                    <span className="entity-name">
                      <strong>{e.name}</strong>
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}
function EditableMappingPage() {
  useDocumentTitle("Mapping");
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const state = useAsync((s) => mappingApi.get(s), [tick]);
  const unmapped = useAsync((s) => mappingApi.unmapped(s), [tick]);
  const current = useAsync((s) => mappingApi.preview({ items: 20 }, s), [tick]);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const toast = useToast();
  const [actionError, setActionError] = useState<Error | null>(null);

  async function act(what: () => Promise<unknown>, done: string) {
    setActionError(null);
    try {
      await what();
      toast(done);
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
            recorded events, and every change is itself recorded as an event.
          </p>
        </div>
      </header>
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
            >
              {draft?.kind === kind && (
                <RuleForm
                  key={draft.id ?? "new"}
                  state={state.data!}
                  initial={draft}
                  onKindChange={setDraft}
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
            </RulesTable>
          ))}
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

const MAPPING_PAGE_SIZE = 5;

/**
 * Client-side search and paging for a mapping collection (from AFE-83, #44): a
 * case-insensitive substring search over `searchText`, then pages of five. The
 * API still returns the whole collection; this bounds what is rendered.
 */
function useMappingList<T>(items: T[], searchText: (item: T) => string) {
  const [query, setQueryState] = useState("");
  const [requestedPage, setPage] = useState(0);
  const needle = query.trim().toLowerCase();
  const filtered = items.filter((item) => searchText(item).toLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(filtered.length / MAPPING_PAGE_SIZE));
  // Deleting the last item on the last page falls back to the new last page.
  const page = Math.min(requestedPage, pages - 1);
  return {
    query,
    setQuery: (value: string) => {
      setQueryState(value);
      setPage(0);
    },
    page,
    pages,
    setPage,
    total: items.length,
    matches: filtered.length,
    items: filtered.slice(page * MAPPING_PAGE_SIZE, (page + 1) * MAPPING_PAGE_SIZE),
  };
}

type MappingList = ReturnType<typeof useMappingList>;

function MappingSearch({ list, kind }: { list: MappingList; kind: string }) {
  return (
    <div className="mapping-search">
      <label className="sr-only" htmlFor={`mapping-search-${kind}`}>
        Search {kind}
      </label>
      {icons.search}
      <input
        id={`mapping-search-${kind}`}
        type="search"
        value={list.query}
        onChange={(event) => list.setQuery(event.target.value)}
        placeholder={`Search ${kind}`}
      />
    </div>
  );
}

/** "6–10 of 12 services" and Previous/Next, shown only when paging or searching. */
function MappingPager({ list, kind }: { list: MappingList; kind: string }) {
  if (list.pages <= 1 && !list.query.trim()) return null;
  const start = list.matches === 0 ? 0 : list.page * MAPPING_PAGE_SIZE + 1;
  const end = Math.min((list.page + 1) * MAPPING_PAGE_SIZE, list.matches);
  return (
    <div className="mapping-pager">
      <span className="small muted" role="status">
        {start}–{end} of {list.matches} {kind}
        {list.query.trim() ? ` (${list.total} total)` : ""}
      </span>
      {list.pages > 1 && (
        <nav className="button-row" aria-label={`${kind} pages`}>
          <button
            className="btn btn-sm"
            type="button"
            disabled={list.page === 0}
            onClick={() => list.setPage(list.page - 1)}
          >
            Previous
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={list.page === list.pages - 1}
            onClick={() => list.setPage(list.page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

/** Icon-only row action: a ghost button with a visible tooltip and an accessible name. */
function RowAction({
  label,
  icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-icon btn-sm${danger ? " btn-danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function ServicesCard({ state, act }: { state: MappingState; act: Act }) {
  const list = useMappingList(state.services, (s) => `${s.name} ${s.id} ${s.description ?? ""}`);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const close = () => {
    setAdding(false);
    setName("");
    setDescription("");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await act(
      () =>
        mappingApi.createService({ name: name.trim(), description: description.trim() || null }),
      `Service “${name.trim()}” added.`,
    );
    if (ok) close();
  };
  return (
    <section className="card" aria-labelledby="services-h">
      <SectionHead
        id="services-h"
        title="Services"
        count={state.services.length}
        hint="Rows on the Environments page."
        action={
          !adding && (
            <button
              type="button"
              className="btn btn-sm"
              aria-controls="svc-form"
              aria-expanded={adding}
              onClick={() => setAdding(true)}
            >
              {icons.plus}
              Add service
            </button>
          )
        }
      />
      {adding && (
        <form className="form inline-form" id="svc-form" onSubmit={submit} aria-label="New service">
          <div className="field">
            <label htmlFor="svc-name">Service name</label>
            <input
              id="svc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              autoFocus
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
          <div className="button-row form-end">
            <button type="button" className="btn btn-ghost btn-sm" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>
              Save service
            </button>
          </div>
        </form>
      )}
      {state.services.length === 0 ? (
        !adding && (
          <p className="muted">No services yet. Every deployment shows as “unmapped service”.</p>
        )
      ) : (
        <MappingSearch list={list} kind="services" />
      )}
      {list.matches === 0 && list.total > 0 && (
        <p className="muted">No matches. Try another search.</p>
      )}
      {list.matches > 0 && (
        <ul className="entity-list" aria-label="Existing services">
          {list.items.map((s) => (
            <li key={s.id}>
              <span className="entity-main">
                <span className="entity-name">
                  <strong>{s.name}</strong> <code>{s.id}</code>
                </span>
                {s.description && <span className="entity-meta">{s.description}</span>}
              </span>
              <span className="entity-actions">
                <RowAction
                  label={`Delete service ${s.name}`}
                  icon={icons.trash}
                  danger
                  onClick={() =>
                    void act(() => mappingApi.deleteService(s.id), `Service “${s.name}” deleted.`)
                  }
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <MappingPager list={list} kind="services" />
    </section>
  );
}

function EnvironmentsCard({ state, act }: { state: MappingState; act: Act }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<EnvironmentKind>("other");
  const envs = state.environments;
  const list = useMappingList(envs, (e) => `${e.name} ${e.id} ${e.kind}`);
  const close = () => {
    setAdding(false);
    setName("");
    setKind("other");
  };
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
    if (ok) close();
  };
  return (
    <section className="card" aria-labelledby="envs-h">
      <SectionHead
        id="envs-h"
        title="Environments"
        count={envs.length}
        hint={
          state.customised
            ? "Columns on the Environments page, in this order."
            : "Built-in defaults; your first change makes them your own."
        }
        action={
          !adding && (
            <button
              type="button"
              className="btn btn-sm"
              aria-controls="env-form"
              aria-expanded={adding}
              onClick={() => setAdding(true)}
            >
              {icons.plus}
              Add environment
            </button>
          )
        }
      />
      {adding && (
        <form
          className="form inline-form"
          id="env-form"
          onSubmit={submit}
          aria-label="New environment"
        >
          <div className="form-pair">
            <div className="field">
              <label htmlFor="env-name">Environment name</label>
              <input
                id="env-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={128}
                autoFocus
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
          </div>
          <div className="button-row form-end">
            <button type="button" className="btn btn-ghost btn-sm" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>
              Save environment
            </button>
          </div>
        </form>
      )}
      {envs.length === 0 ? (
        !adding && (
          <p className="muted">No environments yet. Add one to group deployments into columns.</p>
        )
      ) : (
        <MappingSearch list={list} kind="environments" />
      )}
      {list.matches === 0 && list.total > 0 && (
        <p className="muted">No matches. Try another search.</p>
      )}
      {(list.pages > 1 || list.query.trim() !== "") && list.matches > 0 && (
        <p className="small muted">
          Arrows change the full column order, including environments outside this view.
        </p>
      )}
      <ol className="entity-list" aria-label="Existing environments">
        {list.items.map((e) => {
          // Moves act on the full order, not the filtered page.
          const i = envs.findIndex((item) => item.id === e.id);
          return (
            <li key={e.id}>
              <span className="entity-order" aria-hidden="true">
                {i + 1}
              </span>
              <span className="entity-main">
                <span className="entity-name">
                  <strong>{e.name}</strong> <code>{e.id}</code>
                </span>
              </span>
              <span className="badge">{e.kind}</span>
              <span className="entity-actions">
                <RowAction
                  label={`Move environment ${e.name} left`}
                  icon={icons.up}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                />
                <RowAction
                  label={`Move environment ${e.name} right`}
                  icon={icons.down}
                  disabled={i === envs.length - 1}
                  onClick={() => move(i, 1)}
                />
                <RowAction
                  label={`Delete environment ${e.name}`}
                  icon={icons.trash}
                  danger
                  onClick={() =>
                    void act(
                      () => mappingApi.deleteEnvironment(e.id),
                      `Environment “${e.name}” deleted.`,
                    )
                  }
                />
              </span>
            </li>
          );
        })}
      </ol>
      <MappingPager list={list} kind="environments" />
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
  children,
}: {
  kind: RuleKind;
  state: MappingState;
  act: Act;
  onEdit: (r: RuleView) => void;
  onAdd: () => void;
  children: ReactNode;
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
      <SectionHead
        id={`rules-${kind}`}
        title={title}
        count={rules.length}
        hint="Checked top to bottom; the first match wins. Your rules come before the built-in defaults."
        action={
          <button type="button" className="btn btn-sm" onClick={onAdd}>
            {icons.plus}
            Add {kind} rule
          </button>
        }
      />
      {rules.length === 0 ? (
        <p className="muted">No {kind} rules.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
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
                  <td className="num">{i + 1}</td>
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
                  <td className="row-actions">
                    <RowAction
                      label={`Move rule ${i + 1} up`}
                      icon={icons.up}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    />
                    <RowAction
                      label={`Move rule ${i + 1} down`}
                      icon={icons.down}
                      disabled={i === rules.length - 1}
                      onClick={() => move(i, 1)}
                    />
                    <RowAction
                      label={`Edit rule ${r.pattern}`}
                      icon={icons.edit}
                      onClick={() => onEdit(r)}
                    />
                    <RowAction
                      label={`Delete rule ${r.pattern}`}
                      icon={icons.trash}
                      danger
                      onClick={() => void act(() => mappingApi.deleteRule(r.id), "Rule deleted.")}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {children}
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
  onKindChange,
  onSave,
  onCancel,
}: {
  state: MappingState;
  initial: RuleDraft;
  onKindChange: (draft: RuleDraft) => void;
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
    <section aria-labelledby="rule-form-h">
      <h3 id="rule-form-h">{d.id ? "Edit rule" : "New rule"}</h3>
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
              onKindChange({ ...effective, kind, targetId: list[0]?.id ?? "" });
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
  const [open, setOpen] = useState(false);
  return (
    <section className="card" aria-labelledby="builtin-h">
      <SectionHead
        id="builtin-h"
        title={`Built-in defaults (${state.builtinRules.filter((r) => r.enabled).length} of ${state.builtinRules.length} on)`}
        hint="Applied after your rules. Switch one off, or add a rule above, to override it."
        action={
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={open}
            aria-controls="builtin-list"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide defaults" : "Show defaults"}
          </button>
        }
      />
      {open && (
        <ul className="entity-list" id="builtin-list">
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
                <span>
                  <code>{r.field}</code> {MATCH_LABEL[r.match]} <code>{r.pattern}</code> →{" "}
                  {targetName(state, r.kind, r.targetId)}
                  {r.inactiveReason && r.enabled && (
                    <span className="muted small"> (inactive: {r.inactiveReason})</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
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
