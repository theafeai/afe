import { useEffect, useId, useState, type FormEvent } from "react";
import {
  OBSERVATION_METHODS,
  OUTCOMES,
  RANGE_PRESETS,
  TARGET_FIELDS,
  TOOLS,
  TRIGGER_TYPES,
  EMPTY_FILTERS,
  activeFilterCount,
  isoToLocalInput,
  localInputToIso,
  type Filters,
  type RangeId,
  type TargetField,
} from "./filters.ts";
import { useAccess } from "./access.tsx";
import { humanize } from "./format.ts";

/**
 * Filter controls. Selects and checkboxes apply immediately; text fields
 * apply on Enter, on blur or with the Apply button. Every change goes to the
 * URL (see filters.ts), so a filtered view can be bookmarked and shared.
 */
export function FilterBar({
  filters,
  onChange,
  showMethod = true,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  showMethod?: boolean;
}) {
  const { visibleTool } = useAccess();
  const id = useId();
  const [actor, setActor] = useState(filters.actor);
  const [target, setTarget] = useState(filters.target);
  useEffect(() => setActor(filters.actor), [filters.actor]);
  useEffect(() => setTarget(filters.target), [filters.target]);

  const set = (patch: Partial<Filters>) => onChange({ ...filters, actor, target, ...patch });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    set({});
  };
  const commitText = () => {
    if (actor !== filters.actor || target !== filters.target) set({});
  };
  const toggleTool = (tool: string, on: boolean) =>
    set({
      sources: on ? [...filters.sources, tool] : filters.sources.filter((s) => s !== tool),
    });
  const count = activeFilterCount(filters);

  return (
    <form className="filters" onSubmit={submit} aria-label="Filters">
      <fieldset className="filter-tools">
        <legend>Tool</legend>
        {TOOLS.filter((t) => visibleTool(t.id)).map((t) => (
          <label key={t.id} className="check">
            <input
              type="checkbox"
              checked={filters.sources.includes(t.id)}
              onChange={(e) => toggleTool(t.id, e.target.checked)}
            />
            {t.label}
          </label>
        ))}
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-actor`}>Actor</label>
        <input
          id={`${id}-actor`}
          type="search"
          placeholder="login or id"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          onBlur={commitText}
          autoComplete="off"
        />
      </div>

      <div className="field field-target">
        <label htmlFor={`${id}-target`}>Target</label>
        <div className="joined">
          <select
            aria-label="Target field"
            value={filters.targetField}
            onChange={(e) => set({ targetField: e.target.value as TargetField })}
          >
            {TARGET_FIELDS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <input
            id={`${id}-target`}
            type="search"
            placeholder="e.g. production"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onBlur={commitText}
            autoComplete="off"
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${id}-trigger`}>Trigger</label>
        <select
          id={`${id}-trigger`}
          value={filters.trigger}
          onChange={(e) => set({ trigger: e.target.value })}
        >
          <option value="">Any</option>
          {TRIGGER_TYPES.map((t) => (
            <option key={t} value={t}>
              {humanize(t)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${id}-outcome`}>Outcome</label>
        <select
          id={`${id}-outcome`}
          value={filters.outcome}
          onChange={(e) => set({ outcome: e.target.value })}
        >
          <option value="">Any</option>
          {OUTCOMES.map((t) => (
            <option key={t} value={t}>
              {humanize(t)}
            </option>
          ))}
        </select>
      </div>

      {showMethod && (
        <div className="field">
          <label htmlFor={`${id}-method`}>Observed by</label>
          <select
            id={`${id}-method`}
            value={filters.method}
            onChange={(e) => set({ method: e.target.value })}
          >
            <option value="">Any method</option>
            {OBSERVATION_METHODS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor={`${id}-range`}>Time range</label>
        <select
          id={`${id}-range`}
          value={filters.range}
          onChange={(e) => {
            const range = e.target.value as RangeId;
            set(range === "custom" ? { range } : { range, from: "", to: "" });
          }}
        >
          <option value="all">All time</option>
          {RANGE_PRESETS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </div>

      {filters.range === "custom" && (
        <>
          <div className="field">
            <label htmlFor={`${id}-from`}>From</label>
            <input
              id={`${id}-from`}
              type="datetime-local"
              value={isoToLocalInput(filters.from)}
              onChange={(e) => set({ from: localInputToIso(e.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-to`}>To</label>
            <input
              id={`${id}-to`}
              type="datetime-local"
              value={isoToLocalInput(filters.to)}
              onChange={(e) => set({ to: localInputToIso(e.target.value) })}
            />
          </div>
        </>
      )}

      <div className="filter-actions">
        <button type="submit" className="btn">
          Apply
        </button>
        {count > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setActor("");
              setTarget("");
              onChange({ ...EMPTY_FILTERS, extra: [] });
            }}
          >
            Clear all ({count})
          </button>
        )}
      </div>

      {filters.extra.length > 0 && (
        <ul className="chips" aria-label="Other filters">
          {filters.extra.map(([k, v], i) => (
            <li key={`${k}=${v}`} className="chip">
              <span>
                {k} = <code>{v}</code>
              </span>
              <button
                type="button"
                aria-label={`Remove filter ${k} = ${v}`}
                onClick={() => set({ extra: filters.extra.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
