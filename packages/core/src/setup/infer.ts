/**
 * Inference rules for the setup (ADR 0019).
 * Deterministic: the same events always give the same facts, no LLM, no
 * data leaves the deployment. Every fact has a confidence and evidence.
 *
 * Environments come from the names the tools report. A name the admin's
 * mapping already places (tenant rules, enabled built-in rules, or an
 * environment with the same id) is evidence for that admin environment;
 * every other name becomes an inferred environment with that name. Names of
 * short-lived environments (`pr-42`, `preview/feature-x`, or GitHub
 * `transient_environment`) collapse into one family.
 *
 * Rules, strongest first:
 * - order: for changes (commits) that reached both A and B, A first in at
 *   least 80 % of them makes A < B (strong with 5 or more, else probable);
 *   reached together within a minute in 80 % of 5 or more makes them
 *   parallel; otherwise first-seen order (weak), after the known chain.
 *   Cycles keep first-seen order.
 * - productionLike: tool-declared (GitHub `production_environment`, Vercel
 *   `production` target; certain) > short-lived (false, strong) > approval
 *   gate plus a single deploy branch (strong) > name (probable) > last in
 *   the observed order (weak).
 * - gating: required reviewers seen (approval, certain) > a protection rule
 *   (approval, strong) > short-lived (per change, strong) > how most
 *   deployments started (push → automatic, workflow_dispatch → on demand).
 * - batching: median changes that reached the upstream environment between
 *   two deployments here > 1.5 → batches.
 * - cadence: median and p90 time between deployments.
 */
import type { CompiledMapping } from "../mapping/resolve.ts";
import { observationsOf } from "../mapping/fields.ts";
import { NAME_PATTERNS, SUFFIX_PATTERNS } from "../mapping/defaults.ts";
import { MAPPING_LIMITS, slugify, trimDashes } from "../mapping/validate.ts";
import {
  DEFAULT_SIGNAL_EXTRACTORS,
  type EnvironmentSignal,
  type InferenceEvent,
  type SignalExtractor,
} from "./signals.ts";
import {
  environmentSubject,
  type Batching,
  type Cadence,
  type EnvironmentSource,
  type Gating,
  type InferredFact,
  type InferredField,
  type FieldValues,
  type SetupConfidence,
  type SetupEvidence,
} from "./types.ts";

export interface InferSetupOptions {
  /** The admin's mapping (tenant and built-in rules over admin environments), no inferred rules. */
  mapping: CompiledMapping;
  /** Ids of the environments the admin created (`mapping_environments`). */
  adminEnvironmentIds: readonly string[];
  /** Signal extractors per source (default `DEFAULT_SIGNAL_EXTRACTORS`). */
  extractors?: Readonly<Record<string, SignalExtractor>>;
}

/** Two events this close count as "at the same time" for ordering. */
const TOGETHER_MS = 60_000;
const MAX_SOURCES = 50;
const MAX_EVIDENCE = 5;

const RANK: Record<SetupConfidence, number> = { certain: 0, strong: 1, probable: 2, weak: 3 };
const weakest = (a: SetupConfidence, b: SetupConfidence) => (RANK[a] >= RANK[b] ? a : b);

const PREVIEW_STEMS = new Set([
  "pr",
  "preview",
  "previews",
  "review",
  "review-app",
  "pull",
  "pull-request",
  "mr",
]);
const BRANCH_STEMS = new Set([...PREVIEW_STEMS, "branch", "feature"]);

interface Family {
  id: string;
  name: string;
  pattern: string;
}

/** Escapes a literal for the safe-regex syntax (punctuation only; letters never). */
function esc(s: string): string {
  return s.replace(/[^A-Za-z0-9 ]/gu, (c) => `\\${c}`);
}

function family(stem: string, pattern: string): Family | null {
  if (pattern.length > 256 || stem.length === 0) return null;
  const preview = PREVIEW_STEMS.has(stem.toLowerCase());
  const base = trimDashes(slugify(stem).slice(0, 54), false);
  return {
    id: preview ? "previews" : `${base}-previews`,
    name: preview ? "Previews" : `${stem} previews`,
    pattern,
  };
}

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isNumberSeparator = (c: number) =>
  c === 0x2d || c === 0x5f || c === 0x20 || c === 0x23 || c === 0x2f; // - _ space # /
const isLineTerminator = (c: number) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

/**
 * The stem of a numbered name ("pr-42" → "pr", "env12" → "env"), else null. The
 * same result as the first group of `/^(.*?[^-_ #/])[-_ #/]*(\d+)$/`, computed in
 * one pass: that regex backtracks polynomially on inputs such as "!" followed by
 * many "00".
 */
export function numberedStem(v: string): string | null {
  let digits = v.length; // start of the trailing digit run
  while (digits > 0 && isDigit(v.charCodeAt(digits - 1))) digits--;
  if (digits === v.length) return null;
  let seps = digits; // start of the separator run just before it
  while (seps > 0 && isNumberSeparator(v.charCodeAt(seps - 1))) seps--;
  // The shortest stem ends just before the separators; when nothing precedes
  // them it must take the first trailing digit, leaving at least one.
  const end = seps > 0 ? seps : digits + 1;
  if (end >= v.length) return null;
  // `.` stops at line terminators; the stem's last character is `[^-_ #/]`, which does not.
  for (let i = 0; i < end - 1; i++) if (isLineTerminator(v.charCodeAt(i))) return null;
  return v.slice(0, end);
}

/** The family of a short-lived environment name, if it is one. */
export function familyOf(value: string, transient: boolean): Family | null {
  const v = value.trim();
  const stem = numberedStem(v);
  if (stem && (transient || PREVIEW_STEMS.has(stem.toLowerCase()))) {
    return family(stem, `^${esc(stem)}[\\-_ #\\/]*\\d+$`);
  }
  const branch = /^([^/]+)\/.+$/.exec(v);
  if (branch && (transient || BRANCH_STEMS.has(branch[1]!.toLowerCase()))) {
    return family(branch[1]!, `^${esc(branch[1]!)}\\/.+$`);
  }
  return null;
}

/** FNV-1a, for ids of names without a usable slug. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Environment id for a reported name: its slug (`Production – web` → `production-web`). */
export function environmentIdFor(value: string): string {
  const s = slugify(value);
  return s === "item" && !/item/i.test(value) ? `env-${fnv(value)}` : s;
}

interface Bucket {
  id: string;
  admin: boolean;
  family: Family | null;
  names: Map<string, number>;
  tools: Set<string>;
  firstSeen: number;
  sources: Map<string, EnvironmentSource>;
  members: Set<string>;
  signals: EnvironmentSignal[];
}

const ms = (iso: string) => Date.parse(iso);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

const isSha = (ref: string) => /^[0-9a-f]{7,40}$/i.test(ref);
const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, "");

function fact<F extends InferredField>(
  id: string,
  field: F,
  value: FieldValues[F],
  confidence: SetupConfidence,
  reason: string,
  evidence: SetupEvidence[],
): InferredFact<F> {
  return {
    subject: environmentSubject(id),
    field,
    value,
    confidence,
    reason,
    evidence: evidence.slice(0, MAX_EVIDENCE),
  };
}

/** Distinct deployments (by key, else by time) of a bucket. */
function deployments(b: Bucket, reachedOnly: boolean): EnvironmentSignal[] {
  const seen = new Map<string, EnvironmentSignal>();
  for (const s of b.signals) {
    if (s.kind !== "deployment" || (reachedOnly && !s.reached)) continue;
    const key = s.deploymentKey ?? `${s.source}:${s.commit ?? ""}:${s.at}`;
    const prev = seen.get(key);
    if (!prev || ms(s.at) < ms(prev.at)) seen.set(key, s);
  }
  return [...seen.values()].sort((a, b) => ms(a.at) - ms(b.at));
}

interface Edge {
  from: string;
  to: string;
  shared: number;
  before: number;
  confidence: SetupConfidence;
}

interface OrderResult {
  order: Map<string, { value: number; confidence: SetupConfidence; evidence: SetupEvidence[] }>;
  edges: Edge[];
}

function inferOrder(buckets: Bucket[]): OrderResult {
  const nameOf = (id: string) => displayName(buckets.find((b) => b.id === id)!);
  const reach = new Map<string, Map<string, number>>();
  for (const b of buckets) {
    const m = new Map<string, number>();
    for (const s of b.signals) {
      if (s.kind !== "deployment" || !s.reached || !s.commit) continue;
      const t = ms(s.at);
      const prev = m.get(s.commit);
      if (prev === undefined || t < prev) m.set(s.commit, t);
    }
    reach.set(b.id, m);
  }
  const edges: Edge[] = [];
  const parallel: [string, string, number][] = [];
  for (let i = 0; i < buckets.length; i++) {
    for (let j = i + 1; j < buckets.length; j++) {
      const a = buckets[i]!.id;
      const b = buckets[j]!.id;
      const ra = reach.get(a)!;
      const rb = reach.get(b)!;
      let n = 0;
      let aFirst = 0;
      let bFirst = 0;
      let together = 0;
      for (const [commit, ta] of ra) {
        const tb = rb.get(commit);
        if (tb === undefined) continue;
        n++;
        if (Math.abs(ta - tb) <= TOGETHER_MS) together++;
        else if (ta < tb) aFirst++;
        else bFirst++;
      }
      if (n === 0) continue;
      const conf: SetupConfidence = n >= 5 ? "strong" : "probable";
      if (aFirst / n >= 0.8)
        edges.push({ from: a, to: b, shared: n, before: aFirst, confidence: conf });
      else if (bFirst / n >= 0.8)
        edges.push({ from: b, to: a, shared: n, before: bFirst, confidence: conf });
      else if (n >= 5 && together / n >= 0.8) parallel.push([a, b, n]);
    }
  }

  // Topological order; ties and cycles by first-seen order.
  const firstSeen = new Map(buckets.map((b) => [b.id, b.firstSeen]));
  const byFirstSeen = (x: string, y: string) =>
    firstSeen.get(x)! - firstSeen.get(y)! || (x < y ? -1 : 1);
  const remaining = new Set(buckets.map((b) => b.id));
  const rank = new Map<string, number>();
  const inCycle = new Set<string>();
  const sorted: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(
      (id) => !edges.some((e) => e.to === id && remaining.has(e.from)),
    );
    let next: string;
    if (ready.length > 0) next = ready.sort(byFirstSeen)[0]!;
    else {
      next = [...remaining].sort(byFirstSeen)[0]!;
      inCycle.add(next);
    }
    remaining.delete(next);
    sorted.push(next);
    let r = 0;
    for (const e of edges)
      if (e.to === next && rank.has(e.from)) r = Math.max(r, rank.get(e.from)! + 1);
    rank.set(next, r);
  }
  for (const [a, b] of parallel) {
    const r = Math.max(rank.get(a)!, rank.get(b)!);
    rank.set(a, r);
    rank.set(b, r);
  }
  // Environments with no observed relation go after the known chain, by first seen.
  const related = new Set([
    ...edges.flatMap((e) => [e.from, e.to]),
    ...parallel.flatMap(([a, b]) => [a, b]),
  ]);
  const top = Math.max(0, ...[...related].map((id) => rank.get(id)!));
  for (const id of sorted) if (!related.has(id)) rank.set(id, related.size > 0 ? top + 1 : 0);
  const final = [...sorted].sort((x, y) => rank.get(x)! - rank.get(y)! || byFirstSeen(x, y));
  const values = new Map<string, number>();
  let slot = 0;
  for (const id of final) {
    const partner = parallel
      .map(([a, b]) => (a === id ? b : b === id ? a : null))
      .find((p) => p !== null && values.has(p) && rank.get(p) === rank.get(id));
    values.set(id, partner ? values.get(partner)! : ++slot * 10);
  }

  const order: OrderResult["order"] = new Map();
  for (const id of final) {
    const mine = edges.filter((e) => e.from === id || e.to === id);
    const pars = parallel.filter(([a, b]) => a === id || b === id);
    let confidence: SetupConfidence = "weak";
    const evidence: SetupEvidence[] = [];
    if (mine.length > 0 || pars.length > 0) {
      confidence = "certain";
      for (const e of mine) confidence = weakest(confidence, e.confidence);
      if (pars.length > 0) confidence = weakest(confidence, "strong");
      for (const e of mine) {
        const other = e.from === id ? e.to : e.from;
        evidence.push({
          rule: "order.precedence",
          detail:
            e.from === id
              ? `Before ${nameOf(other)} for ${e.before} of ${plural(e.shared, "change")}`
              : `After ${nameOf(other)} for ${e.before} of ${plural(e.shared, "change")}`,
          count: e.shared,
        });
      }
      for (const [a, b, n] of pars) {
        evidence.push({
          rule: "order.parallel",
          detail: `Same time as ${nameOf(a === id ? b : a)} for ${plural(n, "change")}`,
          count: n,
        });
      }
    }
    if (inCycle.has(id)) confidence = "weak";
    if (confidence === "weak") {
      evidence.push({
        rule: "order.first_seen",
        detail: inCycle.has(id)
          ? "Changes reach it in no consistent order; kept in the order Afe first saw it"
          : "Not enough changes reached it and another environment; in the order Afe first saw it",
      });
    }
    order.set(id, { value: values.get(id)!, confidence, evidence });
  }
  return { order, edges };
}

function displayName(b: Bucket): string {
  if (b.family) return b.family.name;
  let best = "";
  let n = -1;
  for (const [name, count] of b.names) {
    if (count > n) {
      best = name;
      n = count;
    }
  }
  return best || b.id;
}

const TOOL_NAMES: Record<string, string> = {
  github: "GitHub",
  vercel: "Vercel",
  argocd: "Argo CD",
  terraform: "Terraform",
};
const toolName = (s: string) => TOOL_NAMES[s] ?? s;

function nameKind(names: Iterable<string>): string | null {
  for (const name of names) {
    for (const [kind, pattern] of [...NAME_PATTERNS, ...SUFFIX_PATTERNS]) {
      if (new RegExp(pattern, "i").test(name)) return kind;
    }
  }
  return null;
}

function inferProductionLike(
  b: Bucket,
  isLast: boolean,
  hasOrderEdges: boolean,
): InferredFact<"productionLike"> | null {
  const name = displayName(b);
  const declared = b.signals.filter((s) => s.declaredProduction === true);
  if (declared.length > 0) {
    const tool = toolName(declared[0]!.source);
    return fact(b.id, "productionLike", true, "certain", `${tool} marks ${name} as production`, [
      {
        rule: "productionLike.declared",
        source: declared[0]!.source,
        detail:
          declared[0]!.source === "vercel"
            ? "Vercel production target"
            : `${plural(declared.length, "deployment")} with production_environment set`,
        count: declared.length,
      },
    ]);
  }
  const transient = b.signals.filter((s) => s.transient === true).length;
  if (b.family || transient > 0) {
    return fact(b.id, "productionLike", false, "strong", `${name} is short-lived`, [
      {
        rule: "productionLike.short_lived",
        detail: b.family
          ? `${plural(b.members.size, "environment")} named like ${[...b.members][0]}`
          : `${plural(transient, "deployment")} marked transient`,
        count: b.family ? b.members.size : transient,
      },
    ]);
  }
  const gates = b.signals.filter((s) => s.kind === "approval" || s.kind === "protection");
  const refs = new Set(
    deployments(b, false)
      .map((s) => s.ref)
      .filter((r): r is string => !!r && !isSha(r))
      .map(branchOf),
  );
  const deployCount = deployments(b, false).length;
  if (gates.length > 0 && refs.size === 1 && deployCount >= 3) {
    return fact(
      b.id,
      "productionLike",
      true,
      "strong",
      `${name} needs approval and only deploys ${[...refs][0]}`,
      [
        {
          rule: "productionLike.protected",
          detail: `${plural(gates.length, "approval wait")}; ${plural(deployCount, "deployment")} all from ${[...refs][0]}`,
          count: deployCount,
        },
      ],
    );
  }
  const kind = nameKind([name, ...b.names.keys()]);
  if (kind) {
    return fact(
      b.id,
      "productionLike",
      kind === "production",
      "probable",
      // Never name a built-in kind beside the org's own name (AFE-117, ADR 0019).
      kind === "production"
        ? `The name ${name} reads as production`
        : `The name ${name} does not read as production`,
      [{ rule: "productionLike.name", detail: `Named ${name}` }],
    );
  }
  if (hasOrderEdges) {
    return fact(
      b.id,
      "productionLike",
      isLast,
      "weak",
      isLast
        ? `${name} is the last stop changes reach`
        : `Changes reach other environments after ${name}`,
      [
        {
          rule: "productionLike.last",
          detail: isLast ? "Last in the observed order" : "Not last in the observed order",
        },
      ],
    );
  }
  return null;
}

function inferGating(b: Bucket): InferredFact<"gating"> | null {
  const name = displayName(b);
  const approvals = b.signals.filter((s) => s.kind === "approval");
  if (approvals.length > 0) {
    return fact(
      b.id,
      "gating",
      "approval",
      "certain",
      `Deployments to ${name} wait for reviewers`,
      [
        {
          rule: "gating.required_reviewers",
          source: approvals[0]!.source,
          detail: `${plural(approvals.length, "review request or decision", "review requests or decisions")} in ${toolName(approvals[0]!.source)}`,
          count: approvals.length,
        },
      ],
    );
  }
  const protections = b.signals.filter((s) => s.kind === "protection");
  if (protections.length > 0) {
    return fact(
      b.id,
      "gating",
      "approval",
      "strong",
      `Deployments to ${name} pass a protection rule`,
      [
        {
          rule: "gating.protection_rule",
          source: protections[0]!.source,
          detail: `${plural(protections.length, "protection rule check")} in ${toolName(protections[0]!.source)}`,
          count: protections.length,
        },
      ],
    );
  }
  if (b.family || b.signals.some((s) => s.transient === true)) {
    return fact(b.id, "gating", "per_change", "strong", `${name} gets an environment per change`, [
      { rule: "gating.short_lived", detail: "Short-lived environments, one per change" },
    ]);
  }
  const deps = deployments(b, false).filter((s) => s.start);
  if (deps.length === 0) return null;
  const counts = new Map<Exclude<Gating, "approval">, number>();
  for (const s of deps) counts.set(s.start!, (counts.get(s.start!) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]!;
  if (n / deps.length < 0.6) return null;
  const details = new Map<string, number>();
  for (const s of deps)
    if (s.start === top && s.startDetail)
      details.set(s.startDetail, (details.get(s.startDetail) ?? 0) + 1);
  const detail = [...details.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? top;
  const toolSays = deps.some((s) => s.source === "github" && s.startDetail === detail);
  const confidence: SetupConfidence = deps.length < 3 ? "weak" : toolSays ? "strong" : "probable";
  const words: Record<string, string> = {
    automatic: `Deployments to ${name} start on their own`,
    on_demand: `Deployments to ${name} are started by hand`,
    per_change: `${name} deploys each pull request`,
  };
  return fact(b.id, "gating", top, confidence, words[top]!, [
    {
      rule: "gating.trigger",
      detail: `${n} of ${plural(deps.length, "deployment")} started by ${detail}`,
      count: deps.length,
    },
  ]);
}

function inferBatching(
  b: Bucket,
  upstream: Bucket | null,
  reachTimes: Map<string, Map<string, number>>,
): InferredFact<"batching"> | null {
  if (!upstream) return null;
  const mine = deployments(b, true).map((s) => ms(s.at));
  if (mine.length < 4) return null;
  const up = [...(reachTimes.get(upstream.id)?.values() ?? [])];
  const carried: number[] = [];
  for (let i = 1; i < mine.length; i++) {
    const n = up.filter((t) => t > mine[i - 1]! && t <= mine[i]!).length;
    carried.push(Math.max(1, n));
  }
  const m = median(carried);
  const value: Batching = m > 1.5 ? "batches" : "each_change";
  const name = displayName(b);
  return fact(
    b.id,
    "batching",
    value,
    carried.length >= 5 ? "strong" : "probable",
    value === "batches"
      ? `${name} ships several changes at a time`
      : `${name} ships changes one at a time`,
    [
      {
        rule: "batching.upstream",
        detail: `Median ${m} changes per deployment (from ${displayName(upstream)}), over ${plural(carried.length, "deployment")}`,
        count: carried.length,
      },
    ],
  );
}

function inferCadence(b: Bucket): InferredFact<"cadence"> | null {
  let deps = deployments(b, true);
  if (deps.length < 3) deps = deployments(b, false);
  if (deps.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < deps.length; i++) gaps.push((ms(deps[i]!.at) - ms(deps[i - 1]!.at)) / 1000);
  const value: Cadence = {
    medianSeconds: Math.round(median(gaps)),
    p90Seconds: Math.round(percentile(gaps, 90)),
    deployments: deps.length,
  };
  return fact(
    b.id,
    "cadence",
    value,
    deps.length >= 10 ? "strong" : "probable",
    `${plural(deps.length, "deployment")} to ${displayName(b)}`,
    [
      {
        rule: "cadence.intervals",
        detail: `${plural(gaps.length, "interval")} between deployments`,
        count: deps.length,
      },
    ],
  );
}

/**
 * Facts for the tenant's environments from its events (newest or oldest
 * first; order does not matter). Pure and deterministic.
 */
export function inferSetup(
  events: readonly InferenceEvent[],
  options: InferSetupOptions,
): InferredFact[] {
  const extractors = options.extractors ?? DEFAULT_SIGNAL_EXTRACTORS;
  const adminIds = new Set(options.adminEnvironmentIds);
  const buckets = new Map<string, Bucket>();
  const sorted = [...events].sort(
    (a, b) => ms(a.occurredAt) - ms(b.occurredAt) || (a.id < b.id ? -1 : 1),
  );

  for (const e of sorted) {
    const extract = extractors[e.source];
    if (!extract) continue;
    for (const s of extract(e)) {
      const value = s.value.trim();
      if (!value || value.length > 256) continue;
      const o = observationsOf(e);
      o[s.field] = [value];
      const placed = options.mapping.resolveObservations(e.source, o).environmentId;
      let id: string;
      let fam: Family | null = null;
      let source: EnvironmentSource | null = null;
      if (placed) id = placed;
      else {
        fam = familyOf(value, s.transient === true);
        if (fam) {
          id = fam.id;
          source = { field: s.field, match: "regex", pattern: fam.pattern };
        } else {
          id = environmentIdFor(value);
          source = { field: s.field, match: "exact", pattern: value };
        }
      }
      let b = buckets.get(id);
      if (!b) {
        b = {
          id,
          admin: adminIds.has(id),
          family: fam,
          names: new Map(),
          tools: new Set(),
          firstSeen: ms(s.at),
          sources: new Map(),
          members: new Set(),
          signals: [],
        };
        buckets.set(id, b);
      }
      if (fam && !b.family && !b.admin) b.family = fam;
      if (fam) b.members.add(value);
      b.names.set(value, (b.names.get(value) ?? 0) + 1);
      b.tools.add(s.source);
      if (source && b.sources.size < MAX_SOURCES) {
        b.sources.set(
          `${source.field}\u0000${source.match}\u0000${source.pattern.toLowerCase()}`,
          source,
        );
      }
      b.signals.push({ ...s, value });
    }
  }

  // Keep the busiest environments within the mapping limit (admin ones always).
  let list = [...buckets.values()];
  if (list.length > MAPPING_LIMITS.environments) {
    list = list
      .sort((a, b) => Number(b.admin) - Number(a.admin) || b.signals.length - a.signals.length)
      .slice(0, MAPPING_LIMITS.environments);
  }
  list.sort((a, b) => a.firstSeen - b.firstSeen || (a.id < b.id ? -1 : 1));

  const { order, edges } = inferOrder(list);
  const reachTimes = new Map<string, Map<string, number>>();
  for (const b of list) {
    const m = new Map<string, number>();
    for (const s of b.signals) {
      if (s.kind !== "deployment" || !s.reached || !s.commit) continue;
      const t = ms(s.at);
      if (!m.has(s.commit) || t < m.get(s.commit)!) m.set(s.commit, t);
    }
    reachTimes.set(b.id, m);
  }

  const facts: InferredFact[] = [];
  for (const b of list) {
    const name = displayName(b);
    const tools = [...b.tools].map(toolName).join(", ");
    if (!b.admin) {
      facts.push(
        b.family
          ? fact(
              b.id,
              "name",
              name,
              "strong",
              `${plural(b.members.size, "short-lived environment")} with one pattern`,
              [
                {
                  rule: "name.family",
                  detail: `${[...b.members].slice(0, 3).join(", ")}${b.members.size > 3 ? "…" : ""}`,
                  count: b.members.size,
                },
              ],
            )
          : fact(
              b.id,
              "name",
              name,
              b.names.size > 1 ? "strong" : "certain",
              `${tools} ${b.tools.size > 1 ? "report" : "reports"} this name`,
              [...b.names.entries()].map(([n, c]) => ({
                rule: "name.reported",
                detail: `${n} (${plural(c, "event")})`,
                count: c,
              })),
            ),
      );
    }
    if (b.sources.size > 0) {
      facts.push(
        fact(
          b.id,
          "sources",
          [...b.sources.values()],
          b.family ? "strong" : "certain",
          `Events with these ${b.family ? "names" : "values"} belong here`,
          [...b.sources.values()].map((s) => ({
            rule: "sources.reported",
            source: s.field.split(".")[0],
            detail: `${s.field} ${s.match === "exact" ? s.pattern : `like ${s.pattern}`}`,
          })),
        ),
      );
    }
    const o = order.get(b.id)!;
    facts.push(
      fact(
        b.id,
        "order",
        o.value,
        o.confidence,
        o.confidence === "weak"
          ? "In the order Afe first saw it"
          : "From the order changes reach environments",
        o.evidence,
      ),
    );
    const hasIn = edges.some((e) => e.to === b.id);
    const hasOut = edges.some((e) => e.from === b.id);
    const prod = inferProductionLike(b, hasIn && !hasOut, hasIn || hasOut);
    if (prod) facts.push(prod);
    const gating = inferGating(b);
    if (gating) facts.push(gating);
    const upstreamEdge = edges
      .filter((e) => e.to === b.id && e.confidence !== "weak")
      .sort((x, y) => y.shared - x.shared)[0];
    const batching = inferBatching(
      b,
      upstreamEdge ? (list.find((x) => x.id === upstreamEdge.from) ?? null) : null,
      reachTimes,
    );
    if (batching) facts.push(batching);
    const cadence = inferCadence(b);
    if (cadence) facts.push(cadence);
  }
  return facts;
}
