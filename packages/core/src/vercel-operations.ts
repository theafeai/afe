/** Shared Vercel UI/agent vocabulary. Observation credentials never enable these actions. */
export const VERCEL_OPERATIONS = [
  ["vercel.deploy", "Deploy Git commit", "deployment"],
  ["vercel.redeploy", "Redeploy", "deployment"],
  ["vercel.cancel", "Cancel deployment", "deployment"],
  ["vercel.promote", "Promote to production", "production"],
  ["vercel.rollback", "Roll back production", "production"],
  ["vercel.alias_assign", "Assign project domain", "domain"],
  ["vercel.delete", "Delete deployment", "deployment"],
  ["vercel.configure", "Update delivery settings", "configuration"],
] as const;
export type VercelOperation = (typeof VERCEL_OPERATIONS)[number][0];
export interface VercelIntent {
  action: VercelOperation;
  params: Record<string, string | boolean>;
}
export interface VercelPreparedOperation extends VercelIntent {
  fingerprint: string;
  context: { connectionId: string; projectId: string; deploymentId?: string };
  warning: string;
}
export interface VercelOperationReceipt {
  requestId: string;
  action: VercelOperation;
  state: "requested" | "accepted" | "rejected" | "unknown" | "released";
  message: string;
  createdAt: string;
  deploymentId?: string;
  targetDeploymentId?: string;
  upstreamStatus: number | null;
}
export interface VercelProjectResource {
  connectionId: string;
  projectId: string;
  name: string;
  connectionName: string;
}
export interface VercelWorkspace {
  context: { connectionId: string; projectId: string; deploymentId?: string };
  project: { id: string; name: string; productionId: string | null; sourceUrl: string };
  deployments: {
    id: string;
    state: string;
    target: string;
    createdAt: number;
    sourceUrl: string;
    commit: string | null;
  }[];
  deployment: { id: string; state: string; target: string; sourceUrl: string } | null;
  domains: { name: string; verified: boolean }[];
  settings: { autoAssignCustomDomains: boolean | null; previewDeploymentsDisabled: boolean | null };
  capabilities: {
    action: VercelOperation;
    label: string;
    enabled: boolean;
    paramsSchema: Record<string, unknown>;
    reason: string | null;
  }[];
  history: VercelOperationReceipt[];
  next: number | null;
}
