import { z } from "zod";
import { parseDocument } from "yaml";
import type { GitHubDispatchInput, GitHubOperation } from "@afe/core";
const text = z.string().max(1024);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ref = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (v) =>
      !Array.from(v).some((c) => c.charCodeAt(0) < 33) &&
      !["\\", "~", "^", ":", "?", "*", "["].some((c) => v.includes(c)) &&
      !v.includes("..") &&
      !v.includes("@{") &&
      !v.endsWith("/") &&
      !v.endsWith("."),
    "Invalid Git ref",
  );
const env = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => v !== "." && v !== ".." && !Array.from(v).some((c) => c.charCodeAt(0) < 32));
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
export const isWorkflowPath = (v: string) =>
  v.startsWith(".github/workflows/") &&
  v.split("/").length === 3 &&
  /^.+\.ya?ml$/.test(v.split("/")[2] ?? "") &&
  !v.includes("\\") &&
  !Array.from(v).some((c) => c.charCodeAt(0) < 32);
const workflowPath = z
  .string()
  .max(512)
  .refine(isWorkflowPath, "Select a YAML file immediately inside .github/workflows.");
const url = z.union([
  z.literal(""),
  z.url().refine((v) => {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  }),
]);
const run = { runId: id, attempt: id };
const debug = { enableDebugLogging: z.boolean().default(false) };
const empty = z.strictObject({});
/** Strict input contracts are enforced before any provider mutation. */
export const operationSchemas = {
  "github.dispatch": z.strictObject({
    workflowId: id,
    ref,
    inputs: z
      .record(
        z.string().max(100),
        z.union([z.string().max(4096), z.boolean(), z.number().finite()]),
      )
      .default({}),
  }),
  "github.enable": z.strictObject({ workflowId: id }),
  "github.disable": z.strictObject({ workflowId: id }),
  "github.workflow_save": z.strictObject({
    path: workflowPath,
    branch: ref,
    sha: sha.optional(),
    message: z.string().min(1).max(500),
    content: z
      .string()
      .min(1)
      .max(128 * 1024),
  }),
  "github.workflow_delete": z.strictObject({
    path: workflowPath,
    branch: ref,
    sha,
    message: z.string().min(1).max(500),
  }),
  "github.cancel": z.strictObject(run),
  "github.force_cancel": z.strictObject(run),
  "github.rerun": z.strictObject({ ...run, ...debug }),
  "github.rerun_failed": z.strictObject({ ...run, ...debug }),
  "github.rerun_job": z.strictObject({ ...run, ...debug, jobId: id }),
  "github.approve_run": z.strictObject(run),
  "github.review_deployment": z.strictObject({
    ...run,
    environmentIds: z.array(id).min(1).max(100),
    state: z.enum(["approved", "rejected"]),
    comment: z.string().min(1).max(2000),
  }),
  "github.delete_run": z.strictObject(run),
  "github.delete_logs": z.strictObject(run),
  "github.deployment_create": z.strictObject({
    ref,
    environment: env.default("production"),
    task: text.default("deploy"),
    description: z.string().max(500).default(""),
    autoMerge: z.boolean().default(false),
    requiredContexts: z.array(z.string().max(100)).max(100).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    transientEnvironment: z.boolean().default(false),
    productionEnvironment: z.boolean().optional(),
  }),
  "github.deployment_status": z.strictObject({
    deploymentId: id,
    state: z.enum(["error", "failure", "inactive", "in_progress", "queued", "pending", "success"]),
    description: z.string().max(140).default(""),
    environment: env.optional(),
    environmentUrl: url.optional(),
    logUrl: url.optional(),
    autoInactive: z.boolean().default(false),
  }),
  "github.deployment_delete": z.strictObject({ deploymentId: id }),
  "github.artifact_delete": z.strictObject({ artifactId: id }),
  "github.artifact_download": z.strictObject({ artifactId: id }),
  "github.logs_download": z.strictObject(run),
  "github.environment_save": z.strictObject({
    environment: env,
    waitTimer: z.number().int().min(0).max(43200),
    preventSelfReview: z.boolean(),
    reviewers: z.array(z.strictObject({ type: z.enum(["User", "Team"]), id })).max(6),
    branchPolicy: z.union([
      z.null(),
      z
        .strictObject({ protected_branches: z.boolean(), custom_branch_policies: z.boolean() })
        .refine((v) => v.protected_branches !== v.custom_branch_policies),
    ]),
  }),
  "github.environment_delete": z.strictObject({ environment: env }),
  "github.branch_policy_save": z.strictObject({
    environment: env,
    name: z.string().min(1).max(255),
    policyId: id.optional(),
    type: z.enum(["branch", "tag"]),
  }),
  "github.branch_policy_delete": z.strictObject({ environment: env, policyId: id }),
  "github.protection_rule_enable": z.strictObject({ environment: env, appId: id }),
  "github.protection_rule_delete": z.strictObject({ environment: env, ruleId: id }),
  "github.cache_delete": z.strictObject({ cacheId: id, key: text.optional(), ref: ref.optional() }),
} satisfies Record<GitHubOperation, z.ZodType>;
export function operationJsonSchema(action: GitHubOperation) {
  return z.toJSONSchema(operationSchemas[action]);
}
export type OperationParams = Record<string, unknown>;
export function parseOperation(action: GitHubOperation, value: unknown): OperationParams {
  const result = operationSchemas[action].safeParse(value);
  if (!result.success)
    throw Object.assign(
      new Error(
        result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
          .slice(0, 800),
      ),
      { statusCode: 400 },
    );
  return result.data as OperationParams;
}
export function workflowInputs(content: string): {
  dispatchable: boolean;
  inputs: GitHubDispatchInput[];
} {
  const doc = parseDocument(content, { uniqueKeys: true });
  if (doc.errors.length)
    throw Object.assign(new Error("Workflow YAML is invalid."), { statusCode: 400 });
  let file;
  try {
    file = doc.toJS({ maxAliasCount: 50 });
  } catch {
    throw Object.assign(new Error("Workflow YAML aliases exceed the supported limit."), {
      statusCode: 400,
    });
  }
  if (
    !file ||
    typeof file !== "object" ||
    !file.jobs ||
    typeof file.jobs !== "object" ||
    Array.isArray(file.jobs)
  )
    throw Object.assign(new Error("Workflow must define jobs."), { statusCode: 400 });
  const on = file.on;
  const dispatchable =
    on === "workflow_dispatch" ||
    (Array.isArray(on) && on.includes("workflow_dispatch")) ||
    (!!on && typeof on === "object" && Object.hasOwn(on, "workflow_dispatch"));
  const definitions = on?.workflow_dispatch?.inputs ?? {};
  if (
    !definitions ||
    typeof definitions !== "object" ||
    Array.isArray(definitions) ||
    Object.keys(definitions).length > 25
  )
    throw Object.assign(new Error("Invalid workflow dispatch inputs."), { statusCode: 400 });
  const inputs = Object.entries(definitions).map(([name, raw]): GitHubDispatchInput => {
    const d = raw as Record<string, unknown>;
    if (
      !d ||
      typeof d !== "object" ||
      !["string", "boolean", "number", "choice", "environment"].includes(String(d.type ?? "string"))
    )
      throw Object.assign(new Error("Unsupported workflow input type."), { statusCode: 400 });
    const type = (d.type ?? "string") as GitHubDispatchInput["type"];
    return {
      name,
      description: String(d.description ?? ""),
      type,
      required: d.required === true,
      ...(d.default !== undefined ? { default: d.default as string | boolean | number } : {}),
      ...(Array.isArray(d.options) ? { options: d.options.map(String) } : {}),
    };
  });
  return { dispatchable, inputs };
}
export function validateDispatch(inputs: GitHubDispatchInput[], supplied: Record<string, unknown>) {
  if (Object.keys(supplied).some((key) => !inputs.some((i) => i.name === key)))
    throw Object.assign(new Error("Unknown workflow input."), { statusCode: 400 });
  const result: Record<string, string | number | boolean> = {};
  for (const input of inputs) {
    const value = supplied[input.name] ?? input.default;
    if (value === undefined || value === "") {
      if (input.required)
        throw Object.assign(new Error(`Input ${input.name} is required.`), { statusCode: 400 });
      continue;
    }
    if (
      (input.type === "boolean" && typeof value !== "boolean") ||
      (input.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) ||
      (!["boolean", "number"].includes(input.type) && typeof value !== "string") ||
      (input.type === "choice" && !input.options?.includes(String(value)))
    )
      throw Object.assign(new Error(`Input ${input.name} has an invalid value.`), {
        statusCode: 400,
      });
    result[input.name] = value as string | number | boolean;
  }
  return result;
}
export { empty };
