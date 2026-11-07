/** Shared Terraform delivery catalog for the UI and authenticated agent API. */
export const TERRAFORM_OPERATIONS = [
  [
    "terraform.plan",
    "Queue plan",
    "workspace",
    "Queue a speculative plan using the current workspace configuration. This does not apply infrastructure changes.",
  ],
  [
    "terraform.run",
    "Queue run",
    "workspace",
    "Queue a run using the current workspace configuration. Auto-apply and destroy are disabled; applying the plan requires a later confirmation.",
  ],
  [
    "terraform.apply",
    "Confirm apply",
    "run",
    "Apply the selected plan to this workspace. This may create, change or destroy infrastructure. Inspect the plan in Terraform before confirming.",
  ],
  [
    "terraform.discard",
    "Discard run",
    "run",
    "Discard this pending run so its plan cannot be applied. This does not roll back infrastructure changes.",
  ],
  [
    "terraform.cancel",
    "Cancel run",
    "run",
    "Ask Terraform to cancel this run. An interrupted apply can leave partial infrastructure changes; inspect the source afterward.",
  ],
  [
    "terraform.force_cancel",
    "Force cancel run",
    "run",
    "Force cancellation of this run. This can interrupt an apply and leave partial changes or state locks. Inspect Terraform before continuing.",
  ],
  [
    "terraform.policy_override",
    "Override policy",
    "policy",
    "Override a soft-failed Sentinel policy check and allow this run to proceed. This bypasses the selected policy gate; apply approval remains separate.",
  ],
  [
    "terraform.lock",
    "Lock workspace",
    "workspace",
    "Lock this workspace to prevent new runs from starting. Existing work may continue according to Terraform source rules.",
  ],
  [
    "terraform.unlock",
    "Unlock workspace",
    "workspace",
    "Release the workspace lock so queued runs can proceed. This uses ordinary unlock and cannot force-unlock another owner\u2019s lock.",
  ],
] as const;
export type TerraformOperation = (typeof TERRAFORM_OPERATIONS)[number][0];
export interface TerraformOperationInput {
  action: TerraformOperation;
  runId?: string;
  policyCheckId?: string;
}
export interface TerraformCapability {
  action: TerraformOperation;
  enabled: boolean;
  reason: string | null;
}
export interface TerraformRunView {
  id: string;
  status: string;
  url: string;
  planId: string | null;
  applyId: string | null;
  changes: { additions: number | null; changes: number | null; destructions: number | null };
  capabilities: TerraformCapability[];
  policies: { id: string; status: string; capabilities: TerraformCapability[] }[];
}
export interface TerraformWorkspaceView {
  context: { connectionId: string; workspaceId: string; organization: string; serverUrl: string };
  name: string;
  locked: boolean;
  url: string;
  capabilities: TerraformCapability[];
  runs: TerraformRunView[];
  nextPage: number | null;
}
export interface TerraformPreparedOperation {
  version: string;
  summary: string;
  sourceUrl: string;
}
export interface TerraformReceipt {
  requestId: string;
  action: TerraformOperation;
  state: "requested" | "accepted" | "rejected" | "unknown" | "released";
  resourceKey: string;
  resultRunId: string | null;
  createdAt: string;
  message: string;
}
