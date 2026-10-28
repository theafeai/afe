/** Shared UI/API catalog. Grants never imply resource read permission. */
export const GITHUB_OPERATIONS = [
  ["github.dispatch", "Dispatch workflow", "workflow", false, "write"],
  ["github.enable", "Enable workflow", "workflow", false, "write"],
  ["github.disable", "Disable workflow", "workflow", true, "write"],
  ["github.workflow_save", "Save workflow", "workflow", false, "write"],
  ["github.workflow_delete", "Delete workflow file", "workflow", true, "write"],
  ["github.cancel", "Cancel run", "run", true, "write"],
  ["github.force_cancel", "Force cancel run", "run", true, "write"],
  ["github.rerun", "Re-run all jobs", "run", false, "write"],
  ["github.rerun_failed", "Re-run failed jobs", "run", false, "write"],
  ["github.rerun_job", "Re-run job", "job", false, "write"],
  ["github.approve_run", "Approve fork workflow run", "run", false, "write"],
  ["github.review_deployment", "Review pending deployments", "run", false, "write"],
  ["github.delete_run", "Delete workflow run", "run", true, "write"],
  ["github.delete_logs", "Delete workflow run logs", "run", true, "write"],
  ["github.deployment_create", "Create deployment", "deployment", false, "write"],
  ["github.deployment_status", "Set deployment status", "deployment", false, "write"],
  ["github.deployment_delete", "Delete deployment", "deployment", true, "write"],
  ["github.artifact_delete", "Delete artifact", "artifact", true, "write"],
  ["github.artifact_download", "Download artifact", "artifact", false, "read"],
  ["github.logs_download", "Download completed run logs", "run", false, "read"],
  ["github.environment_save", "Save environment protection", "environment", false, "admin"],
  ["github.environment_delete", "Delete environment", "environment", true, "admin"],
  ["github.branch_policy_save", "Add deployment branch policy", "environment", false, "admin"],
  ["github.branch_policy_delete", "Delete deployment branch policy", "environment", true, "admin"],
  [
    "github.protection_rule_enable",
    "Enable custom deployment protection rule",
    "environment",
    false,
    "admin",
  ],
  [
    "github.protection_rule_delete",
    "Disable custom deployment protection rule",
    "environment",
    true,
    "admin",
  ],
  ["github.cache_delete", "Delete Actions cache", "cache", true, "write"],
] as const;
export type GitHubOperation = (typeof GITHUB_OPERATIONS)[number][0];
export const GITHUB_OPERATION_NAMES: readonly GitHubOperation[] = GITHUB_OPERATIONS.map(
  (o) => o[0],
);
export type GitHubOperationParams = Record<string, unknown>;
export interface GitHubOperationCapability {
  action: GitHubOperation;
  label: string;
  group: string;
  destructive: boolean;
  enabled: boolean;
  reason: string | null;
  paramsSchema?: Record<string, unknown>;
  method?: "GET" | "POST";
}
export interface GitHubOperationScope {
  connectionId: string;
  repository: string;
}
export interface GitHubPreparedOperation {
  action: GitHubOperation;
  version: string;
  summary: string;
  context: GitHubOperationScope & { runId?: number; runAttempt?: number; jobId?: number };
}
export interface GitHubOperationReceipt {
  requestId: string;
  action: string;
  state: "requested" | "accepted" | "rejected" | "unknown" | "released";
  message: string;
  runId?: number;
  runAttempt?: number;
  result?: { id?: number; sha?: string };
  createdAt?: string;
}
export interface GitHubRepositoryChoice extends GitHubOperationScope {
  connectionName: string;
}
export interface GitHubDispatchInput {
  name: string;
  description: string;
  type: "string" | "boolean" | "number" | "choice" | "environment";
  required: boolean;
  default?: string | boolean | number;
  options?: string[];
}
