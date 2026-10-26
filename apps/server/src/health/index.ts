// Connection health, outage handling and observation gaps (AFE-13).
// See docs/connection-health.md.
export {
  createHealthModule,
  collectHealthHooks,
  healthModule,
  type HealthModule,
  type HealthModuleOptions,
} from "./module.ts";
export {
  HealthService,
  HEALTH_JOBS,
  BLIND_ALERT_KIND,
  GAP_REASON_BY_FAILURE,
  STATE_BY_REASON,
  type BackfillJobData,
  type HealthServiceOptions,
  type ProbeRunSummary,
} from "./service.ts";
export {
  DEFAULT_HEALTH_CONFIG,
  backoffDelayMs,
  loadHealthConfig,
  parseDuration,
  type HealthConfig,
} from "./config.ts";
export {
  combineAlertSinks,
  createDefaultAlertSink,
  createLogAlertSink,
  createWebhookAlertSink,
  type WebhookAlertSinkOptions,
} from "./alert-sink.ts";
export { deterministicId, sanitizeDetail } from "./sanitize.ts";
