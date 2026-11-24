/**
 * Environment signals: what each tool tells Afe about an environment, as
 * source-neutral facts the inference rules read. One extractor per
 * connector (pluggable: `inferSetup(..., { extractors })`). Extractors read
 * the canonical event only, never raw payloads.
 */
import { observationsOf, type MappableEvent } from "../mapping/fields.ts";
import type { Gating } from "./types.ts";

/** The parts of a stored event inference reads. `CanonicalEvent` satisfies it. */
export interface InferenceEvent extends MappableEvent {
  id: string;
  action: string;
  outcome: string;
  occurredAt: string;
  trigger: { type: string; sourceValue?: string | null };
  correlation?: {
    environments?: string[] | null;
    repositories?: string[] | null;
    commitShas?: string[] | null;
    deploymentIds?: string[] | null;
    runIds?: string[] | null;
  } | null;
  data?: Record<string, unknown> | null;
}

export interface EnvironmentSignal {
  source: string;
  /** Mapping field the value appears in (`github.environment`...). */
  field: string;
  /** The environment name exactly as the tool reports it. */
  value: string;
  /**
   * A deployment (or sync) to the environment, an approval wait, a protection
   * rule, or a run that names the environment without changing it (a
   * Terraform plan or destroy): evidence the environment exists, never a
   * deployment for order, cadence or process.
   */
  kind: "deployment" | "approval" | "protection" | "run";
  at: string;
  /** The deployment reached the environment (succeeded). */
  reached?: boolean;
  commit?: string | null;
  ref?: string | null;
  /** The tool itself says the environment is production (`true`) or not (`false`). */
  declaredProduction?: boolean | null;
  /** The tool marks the environment as short-lived. */
  transient?: boolean | null;
  /** How the deployment started, if the tool says. */
  start?: Exclude<Gating, "approval"> | null;
  /** The tool's own word for the start (`push`, `workflow_dispatch`...). */
  startDetail?: string | null;
  /** Dedupe key of the deployment (one deployment has several events). */
  deploymentKey?: string | null;
}

export type SignalExtractor = (e: InferenceEvent) => EnvironmentSignal[];

const DEPLOYMENT_ACTIONS = new Set([
  "deployment.created",
  "deployment.status_updated",
  "deployment.promoted",
  "deployment.rolled_back",
  "deployment.cancelled",
]);
const isDeployment = (a: string) => DEPLOYMENT_ACTIONS.has(a) || a.startsWith("argocd.sync.");

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Start of a deployment from the canonical trigger type. */
function startOf(triggerType: string): EnvironmentSignal["start"] {
  switch (triggerType) {
    case "push":
    case "auto_sync":
    case "merge_queue":
    case "tag":
    case "release":
    case "schedule":
    case "upstream":
      return "automatic";
    case "pull_request":
      return "per_change";
    case "manual":
    case "cli":
    case "promotion":
    case "redeploy":
    case "rollback":
      return "on_demand";
    default:
      return null;
  }
}

/** Deployment signals for every environment-like field of the event. */
function genericDeployments(e: InferenceEvent, fields: readonly string[]): EnvironmentSignal[] {
  if (!isDeployment(e.action)) return [];
  const o = observationsOf(e);
  const out: EnvironmentSignal[] = [];
  for (const field of fields) {
    for (const value of o[field] ?? []) {
      out.push({
        source: e.source,
        field,
        value,
        kind: "deployment",
        at: e.occurredAt,
        reached: e.outcome === "succeeded",
        commit: e.correlation?.commitShas?.[0] ?? null,
        ref: str((e.target as { ref?: unknown }).ref),
        start: startOf(e.trigger.type),
        startDetail: e.trigger.sourceValue ?? e.trigger.type,
        deploymentKey: e.correlation?.deploymentIds?.[0] ?? null,
      });
    }
  }
  return out;
}

/** GitHub: deployments, required-reviewer waits and protection rules. */
export const githubSignals: SignalExtractor = (e) => {
  const envs = [
    ...new Set(
      [e.target.environment, ...(e.correlation?.environments ?? [])].filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      ),
    ),
  ];
  if (
    e.action === "deployment.review_requested" ||
    e.action === "deployment.review_approved" ||
    e.action === "deployment.review_rejected"
  ) {
    return envs.map((value) => ({
      source: "github",
      field: "github.environment",
      value,
      kind: "approval" as const,
      at: e.occurredAt,
    }));
  }
  if (e.action === "deployment.protection_rule_requested") {
    const value = str(e.data?.environment) ?? envs[0];
    return value
      ? [
          {
            source: "github",
            field: "github.environment",
            value,
            kind: "protection" as const,
            at: e.occurredAt,
          },
        ]
      : [];
  }
  if (!isDeployment(e.action)) return [];
  const value = e.target.environment ?? envs[0];
  if (!value) return [];
  const d = obj(e.data?.deployment);
  const run = obj(e.data?.run);
  const runEvent = str(run?.event);
  let start = startOf(e.trigger.type);
  if (runEvent === "workflow_dispatch") start = "on_demand";
  else if (runEvent === "push" || runEvent === "merge_group" || runEvent === "schedule")
    start = "automatic";
  else if (runEvent === "pull_request" || runEvent === "pull_request_target") start = "per_change";
  return [
    {
      source: "github",
      field: "github.environment",
      value,
      kind: "deployment",
      at: e.occurredAt,
      reached: e.action === "deployment.status_updated" && e.outcome === "succeeded",
      commit: str(d?.sha) ?? e.correlation?.commitShas?.[0] ?? null,
      ref: str(d?.ref) ?? str((e.target as { ref?: unknown }).ref),
      declaredProduction: bool(d?.productionEnvironment),
      transient: bool(d?.transientEnvironment),
      start,
      startDetail: runEvent ?? e.trigger.sourceValue ?? e.trigger.type,
      deploymentKey: e.correlation?.deploymentIds?.[0] ?? (d?.id != null ? String(d.id) : null),
    },
  ];
};

/** Vercel: the `production` target is declared production by the tool. */
export const vercelSignals: SignalExtractor = (e) =>
  genericDeployments(e, ["vercel.target"]).map((s) => ({
    ...s,
    declaredProduction: s.value === "production" ? true : s.value === "preview" ? false : null,
  }));

export const argocdSignals: SignalExtractor = (e) => genericDeployments(e, ["argocd.environment"]);

/** Terraform's own workspace when none is selected; it names no environment. */
const TERRAFORM_DEFAULT_WORKSPACE = "default";
const TERRAFORM_ACTION = /^terraform\.(plan|apply|destroy)\.(started|completed)$/;

/**
 * Terraform (AFE-116): runner-reported `terraform.<plan|apply|destroy>.<phase>`
 * events. The environment is named the way the connection reports it: its
 * configured environment, else the workspace (Terraform's unit of separate
 * state), never the `default` workspace. An apply is a deployment (reached
 * when it completes successfully); plans and destroys only show that the
 * environment exists. Started and completed reports of one operation are one
 * deployment.
 */
export const terraformSignals: SignalExtractor = (e) => {
  const m = TERRAFORM_ACTION.exec(e.action);
  if (!m) return [];
  const [, operation, phase] = m;
  const o = observationsOf(e);
  const environment = o["terraform.environment"]?.[0];
  const workspace = o["terraform.workspace"]?.[0];
  const named: [string, string] | null = environment
    ? ["terraform.environment", environment]
    : workspace && workspace !== TERRAFORM_DEFAULT_WORKSPACE
      ? ["terraform.workspace", workspace]
      : null;
  if (!named) return [];
  const apply = operation === "apply";
  const run = e.correlation?.runIds?.find((r) => r.startsWith("terraform:")) ?? e.target.id;
  return [
    {
      source: "terraform",
      field: named[0],
      value: named[1],
      kind: apply ? "deployment" : "run",
      at: e.occurredAt,
      reached: apply && phase === "completed" && e.outcome === "succeeded",
      commit: e.correlation?.commitShas?.[0] ?? null,
      ref: null,
      start: startOf(e.trigger.type),
      // The trigger type is the runner's word (`push`, `cli`...); `sourceValue` is always `runner_report`.
      startDetail: e.trigger.type,
      deploymentKey: run ? `${run}:${operation}` : null,
    },
  ];
};

/** Built-in extractors per source. Add one per connector. */
export const DEFAULT_SIGNAL_EXTRACTORS: Readonly<Record<string, SignalExtractor>> = {
  github: githubSignals,
  vercel: vercelSignals,
  argocd: argocdSignals,
  terraform: terraformSignals,
};
