export const CONNECTOR_SOURCE = "vercel" as const;

export * from "./types.ts";
export {
  VERCEL_API_URL,
  VercelClient,
  VercelApiError,
  VercelRateLimitError,
  parseRateLimit,
  stripSensitive,
  type FetchLike,
  type TokenSource,
  type VercelClientOptions,
} from "./client.ts";
export {
  buildInstallUrl,
  exchangeOAuthCode,
  deleteIntegrationConfiguration,
  deriveStateKey,
  newStateNonce,
  signState,
  verifyState,
  type OAuthExchangeInput,
  type OAuthExchangeResult,
  type OAuthState,
} from "./oauth.ts";
export {
  NO_PROJECTS,
  ProjectNotSelectedError,
  ScopedVercelReader,
  isProjectSelected,
  parseProjectSelection,
  parseSelectionRequest,
  type ProjectSelection,
} from "./selection.ts";
export {
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  LIFECYCLE_EVENT_TYPES,
  isLifecycleEvent,
  parseVercelWebhookBody,
  verifyVercelWebhook,
  type LifecycleEventType,
  type VercelWebhookEvent,
  type VerifyWebhookResult,
} from "./webhook.ts";
