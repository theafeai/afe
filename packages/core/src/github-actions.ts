/** Opt-in grants, separate from resource read access (AFE-57). */
export const GITHUB_RUN_ACTIONS = ["github.cancel", "github.rerun", "github.rerun_failed"] as const;
export type GitHubRunAction = (typeof GITHUB_RUN_ACTIONS)[number];
export interface GitHubRunControls {
  context: { connectionId: string; repository: string; runId: number; runAttempt: number };
  status: string;
  conclusion: string | null;
  capabilities: { action: GitHubRunAction; enabled: boolean; reason: string | null }[];
}
export type GitHubActionState = "requested" | "accepted" | "rejected" | "unknown" | "released";
export interface GitHubActionReceipt {
  requestId: string;
  state: GitHubActionState;
  message: string;
}
