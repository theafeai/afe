/** One catalog for UI and authenticated API. Source read never grants an operation. */
export const ARGOCD_OPERATIONS = [
  ["argocd.refresh", "Refresh", "get", false],
  ["argocd.hard_refresh", "Hard refresh", "get", false],
  ["argocd.sync", "Sync application", "sync", false],
  ["argocd.rollback", "Roll back application", "sync", true],
  ["argocd.terminate", "Terminate operation", "sync", true],
  ["argocd.resource_action", "Run resource action", "action", false],
  ["argocd.sync_policy", "Save sync policy", "update", false],
  ["argocd.delete", "Delete application", "delete", true],
] as const;

export const ARGOCD_SYNC_OPTIONS = [
  "Validate=false",
  "CreateNamespace=true",
  "PruneLast=true",
  "ApplyOutOfSyncOnly=true",
  "RespectIgnoreDifferences=true",
  "ServerSideApply=true",
  "Replace=true",
  "PrunePropagationPolicy=foreground",
  "PrunePropagationPolicy=background",
  "PrunePropagationPolicy=orphan",
  "FailOnSharedResource=true",
] as const;
