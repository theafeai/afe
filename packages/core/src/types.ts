/**
 * Type-only entry point (`@afe/core/types`) for browser code such as the web
 * UI (AFE-16): the event and connection model types without pulling Node-only
 * modules (crypto, security) into a bundle or a DOM-only type check.
 */
export type {
  Actor,
  ActorRef,
  ActorType,
  CanonicalEvent,
  Correlation,
  EventSource,
  JsonObject,
  JsonValue,
  ObservationGap,
  ObservationGapReason,
  ObservationMethod,
  Outcome,
  RawPayloadRef,
  Target,
  TargetType,
  Trigger,
  TriggerType,
} from "./event.ts";
export type { ConnectionStatus, HealthFailureReason } from "./connection.ts";
export type { EventAction } from "./actions.ts";
export type {
  DimensionMatch,
  Environment as MappingEnvironment,
  EnvironmentKind,
  MappingConfig,
  MappingField,
  MappingRule,
  MatchType,
  Observations,
  PlacementConfidence,
  PlacementResolution,
  RuleKind,
  Service as MappingService,
} from "./mapping/types.ts";
