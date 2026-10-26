/**
 * The canonical event model. Every connector maps what it observes in a source
 * tool into this one shape; it is what the append-only audit log stores and
 * hashes. Field reference: docs/event-model.md. Design: ADR 0003.
 *
 * Stability: this is schema version 1 (`EVENT_SCHEMA_VERSION`). Adding a new
 * *optional* field or a new enum value is additive. Changing the meaning or
 * shape of an existing field requires a new schema version, because stored
 * events are hashed in the shape they were recorded with.
 */
import { z } from "zod";
import { ACTION_PATTERN, ACTIONS, type EventAction } from "./actions.ts";
import { hasLoneSurrogate } from "./canonical-json.ts";

export const EVENT_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Sources shipped in this repository. `afe` is Afe itself (gaps, connection changes). */
export const KNOWN_SOURCES = ["github", "argocd", "vercel", "afe"] as const;
export type KnownEventSource = (typeof KNOWN_SOURCES)[number];
/**
 * Source tool identifier. Open-ended (pattern-checked) so connectors outside
 * this repository can be added without a schema change (ADR 0002 `Connector`).
 */
export type EventSource = KnownEventSource | (string & {});
export const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Who: the kind of principal that caused the event. */
export const ACTOR_TYPES = ["user", "bot", "token", "system", "unknown"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** How: what initiated the action. See docs/event-model.md for source mappings. */
export const TRIGGER_TYPES = [
  "push", // commits pushed to a branch/tag (incl. Vercel/Argo git integrations)
  "pull_request", // pull/merge request opened/synchronised
  "merge_queue", // GitHub merge queue
  "tag", // tag created
  "release", // release published
  "manual", // a person clicked/ran it explicitly (workflow_dispatch, Argo UI sync, Vercel UI)
  "schedule", // cron / scheduled
  "api", // API call by a token/app (repository_dispatch, REST create deployment)
  "cli", // a CLI (vercel, argocd) run by a person or CI job
  "rerun", // re-run / re-attempt of an earlier run
  "auto_sync", // ArgoCD automated sync / self-heal
  "rollback", // explicit rollback to an earlier revision/deployment
  "promotion", // promoting an existing build to another environment
  "redeploy", // rebuild/redeploy of an existing deployment
  "upstream", // chained from another run/event (workflow_run, deployment from workflow)
  "system", // Afe itself or the source tool's internal processes
  "unknown",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Result/state of the action at the time of the event. */
export const OUTCOMES = [
  "succeeded",
  "failed",
  "cancelled",
  "in_progress",
  "pending",
  "skipped",
  "none", // the action has no outcome (e.g. a push, a gap opening)
  "unknown",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * How Afe learned about the event (provenance).
 * - webhook: pushed by the source tool.
 * - poll: routine polling, the primary feed for sources without webhooks.
 * - reconciliation: a reconciliation pass found an event that should already
 *   have arrived by webhook/poll but had not ("discovered by reconciliation").
 * - backfill: historical import when a connection is first added.
 * - stream: a long-lived watch/stream (e.g. ArgoCD application watch).
 * - internal: produced by Afe itself (observation gaps, connection changes).
 */
export const OBSERVATION_METHODS = [
  "webhook",
  "poll",
  "reconciliation",
  "backfill",
  "stream",
  "internal",
] as const;
export type ObservationMethod = (typeof OBSERVATION_METHODS)[number];

/** What the event acted on. */
export const TARGET_TYPES = [
  "repository",
  "ref",
  "workflow",
  "workflow_run",
  "environment",
  "deployment",
  "application", // ArgoCD application
  "project", // Vercel project, ArgoCD AppProject
  "cluster",
  "namespace",
  "organization",
  "connection", // an Afe connection (observation gaps)
  "other",
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

const str = (max: number) => z.string().min(1).max(max);
const optStr = (max: number) => str(max).nullish();

/**
 * Timestamp: ISO 8601 string with offset, or a Date. Normalised to UTC with
 * millisecond precision (`toISOString()`), so it round-trips through
 * PostgreSQL `timestamptz` and hashes identically.
 */
export const timestampSchema = z
  .union([z.iso.datetime({ offset: true }), z.date()])
  .transform((v) => new Date(v).toISOString());

const actorRefShape = {
  type: z.enum(ACTOR_TYPES),
  /** Stable identifier in the source tool (e.g. GitHub numeric user id as a string). */
  id: optStr(256),
  /** Handle / login / username / token name. */
  login: optStr(256),
  /** Display name. */
  name: optStr(512),
  email: optStr(320),
};

const actorRefSchema = z.strictObject(actorRefShape).refine(actorIdentified, {
  message: "user, bot and token actors need an id or login",
});

export const actorSchema = z
  .strictObject({
    ...actorRefShape,
    /**
     * The principal this actor acted for: e.g. a GitHub App installation or
     * token acting on behalf of a user, or a CI bot deploying for a person.
     */
    onBehalfOf: actorRefSchema.nullish(),
    /**
     * The principal that triggered this particular run when it differs from
     * the actor, e.g. GitHub `triggering_actor` of a re-run.
     */
    triggeredBy: actorRefSchema.nullish(),
  })
  .refine(actorIdentified, { message: "user, bot and token actors need an id or login" });

function actorIdentified(a: { type: ActorType; id?: string | null; login?: string | null }) {
  return a.type === "system" || a.type === "unknown" || Boolean(a.id ?? a.login);
}

export const targetSchema = z.strictObject({
  type: z.enum(TARGET_TYPES),
  /** Stable identifier of the target within its source (e.g. repo "owner/name", app "ns/name"). */
  id: str(512),
  name: optStr(512),
  url: optStr(2048),
  /** Repository as "owner/name" (GitHub) or the git URL an ArgoCD/Vercel target builds from. */
  repository: optStr(512),
  /** Vercel project or ArgoCD AppProject. */
  project: optStr(256),
  /** ArgoCD application name. */
  application: optStr(256),
  /** Deployment environment (GitHub environment, Vercel target, Argo destination label). */
  environment: optStr(256),
  /** Kubernetes cluster (ArgoCD destination server or name). */
  cluster: optStr(512),
  namespace: optStr(256),
  /** Git ref the target refers to, fully qualified when known (refs/heads/main). */
  ref: optStr(512),
});

export const triggerSchema = z.strictObject({
  type: z.enum(TRIGGER_TYPES),
  /** The source tool's own term, e.g. GitHub `workflow_dispatch`, Argo `automated`. */
  sourceValue: optStr(128),
  detail: optStr(1024),
});

export const observationSchema = z.strictObject({
  method: z.enum(OBSERVATION_METHODS),
  /** Webhook delivery id (e.g. X-GitHub-Delivery). Never part of the idempotency key. */
  deliveryId: optStr(256),
  /** Job/poll run that produced it (pg-boss job id). */
  jobId: optStr(256),
  detail: optStr(1024),
});

const keyList = (item: z.ZodType<string>) =>
  z
    .array(item)
    .max(200)
    .nullish()
    .transform((v) => (v && v.length > 0 ? [...new Set(v)].sort() : undefined));

const lower = (max: number) => str(max).transform((s) => s.toLowerCase());

/**
 * Structured keys used to correlate events across tools (AFE-15). Each list
 * is normalised: de-duplicated and sorted (so it hashes stably), and
 * case-insensitive keys are lower-cased. Containment queries
 * (`correlation @> '{"commitShas":["…"]}'`) are indexed.
 */
export const correlationSchema = z.strictObject({
  /** Full commit SHAs (40 hex for SHA-1, 64 for SHA-256 repositories). */
  commitShas: keyList(
    z
      .string()
      .regex(/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/, "commit SHA must be full length hex")
      .transform((s) => s.toLowerCase()),
  ),
  /** Git refs, fully qualified when known: "refs/heads/main", "refs/tags/v1.2.3". */
  refs: keyList(str(512)),
  /** Repositories as "host/owner/name", lower case. Use `repositoryKey()` to build. */
  repositories: keyList(lower(512)),
  /** Environment names as used by the source (lower-cased). */
  environments: keyList(lower(256)),
  /** Container image references with tag, e.g. "ghcr.io/acme/api:1.4.2". */
  imageRefs: keyList(str(1024)),
  /** Image digests "sha256:<hex>", lower case. */
  imageDigests: keyList(
    z
      .string()
      .regex(/^[a-zA-Z0-9]+:[0-9a-fA-F]{32,128}$/, "digest must be <algorithm>:<hex>")
      .transform((s) => s.toLowerCase()),
  ),
  /** Source-qualified deployment ids: "github:123456", "vercel:dpl_abc", "argocd:ns/app:42". */
  deploymentIds: keyList(str(512)),
  /** Source-qualified CI run ids: "github:<run_id>". */
  runIds: keyList(str(512)),
  /** Pull requests as "host/owner/name#number", lower case. */
  pullRequests: keyList(lower(512)),
});

const jsonValueSchema = z.json() as unknown as z.ZodType<JsonValue, JsonValue>;
export const jsonObjectSchema: z.ZodType<JsonObject, JsonObject> = z.record(
  z.string(),
  jsonValueSchema,
);

/** Raw evidence as received from the source, stored verbatim in `raw_payloads`. */
export const rawPayloadInputSchema = z.strictObject({
  contentType: str(255),
  /** Exact bytes (or text) received. Use `jsonRawPayload()` for an already-parsed object. */
  body: z.union([z.string(), z.instanceof(Uint8Array)]),
});

/** Reference from a stored event to its raw payload; the sha256 is covered by the event hash. */
export const rawPayloadRefSchema = z.strictObject({
  id: z.uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

// ---------------------------------------------------------------------------
// Observation gaps
// ---------------------------------------------------------------------------

export const OBSERVATION_GAP_REASONS = [
  "connection_error", // network/DNS/TLS failures reaching the source
  "auth_failed", // credentials revoked/expired, app uninstalled
  "permission_denied", // credentials valid but lack access
  "rate_limited",
  "source_unavailable", // source returned 5xx / maintenance
  "webhook_delivery_failed", // source reports failed deliveries, or signature failures
  "history_unavailable", // events aged out of the source before Afe could read them
  "afe_unavailable", // Afe itself was down or its workers were not running
  "connection_paused", // an operator disabled the connection
  "unknown",
] as const;
export type ObservationGapReason = (typeof OBSERVATION_GAP_REASONS)[number];

export const observationGapSchema = z.strictObject({
  /** Stable id of the gap; the opened and closed events share it. */
  gapId: str(128),
  connectionId: str(128),
  /** The source that could not be observed. */
  source: z.string().regex(SOURCE_PATTERN),
  /** Start of the period that may be missing events (inclusive). */
  startedAt: timestampSchema,
  /** End of the period (exclusive); required on `observation_gap.closed`. */
  endedAt: timestampSchema.nullish(),
  reason: z.enum(OBSERVATION_GAP_REASONS),
  detail: optStr(2048),
});
export type ObservationGap = z.output<typeof observationGapSchema>;

// ---------------------------------------------------------------------------
// Event input (what connectors submit)
// ---------------------------------------------------------------------------

export const SOURCE_EVENT_ID_MAX = 512;

const eventInputObject = z.strictObject({
  source: z.string().regex(SOURCE_PATTERN, "source must match ^[a-z][a-z0-9_-]{0,31}$"),
  /**
   * Idempotency key within (tenant, source). Must be derived from the source
   * object itself so webhook and polling produce the same value; see
   * docs/event-model.md "Idempotency keys".
   */
  sourceEventId: str(SOURCE_EVENT_ID_MAX),
  /** Afe connection that observed the event, if any. */
  connectionId: optStr(128),
  action: z.string().regex(ACTION_PATTERN, "action must be <object>.<verb> in lower snake case"),
  actor: actorSchema,
  target: targetSchema,
  trigger: triggerSchema,
  outcome: z.enum(OUTCOMES).default("unknown"),
  /** When it happened in the source tool. */
  occurredAt: timestampSchema,
  /** When Afe observed it (received the webhook / read it by polling). */
  observedAt: timestampSchema,
  observation: observationSchema,
  correlation: correlationSchema.nullish(),
  /** Action-specific details. Keep it small; the full source object belongs in rawPayload. */
  data: jsonObjectSchema.nullish(),
  rawPayload: rawPayloadInputSchema.nullish(),
});

export const canonicalEventInputSchema = eventInputObject
  .superRefine((e, ctx) => {
    if (e.action.startsWith("observation_gap.")) {
      if (e.source !== "afe") {
        ctx.addIssue({ code: "custom", path: ["source"], message: 'gap events have source "afe"' });
      }
      const gap = observationGapSchema.safeParse((e.data as JsonObject | undefined)?.gap);
      if (!gap.success) {
        ctx.addIssue({
          code: "custom",
          path: ["data", "gap"],
          message: `invalid observation gap: ${z.prettifyError(gap.error)}`,
        });
      } else if (e.action === ACTIONS.OBSERVATION_GAP_CLOSED) {
        if (!gap.data.endedAt) {
          ctx.addIssue({
            code: "custom",
            path: ["data", "gap", "endedAt"],
            message: "observation_gap.closed requires endedAt",
          });
        } else if (gap.data.endedAt < gap.data.startedAt) {
          ctx.addIssue({
            code: "custom",
            path: ["data", "gap", "endedAt"],
            message: "endedAt is before startedAt",
          });
        }
      }
    }
    // PostgreSQL jsonb/text cannot store NUL, and lone surrogates cannot be
    // canonicalised. Reject them up front rather than failing at insert.
    const { rawPayload: _raw, ...rest } = e;
    scanStrings(rest, [], (path, msg) => ctx.addIssue({ code: "custom", path, message: msg }));
  })
  .transform((e) => ({
    source: e.source as EventSource,
    sourceEventId: e.sourceEventId,
    connectionId: e.connectionId ?? null,
    action: e.action as EventAction,
    actor: compact(e.actor) as Actor,
    target: compact(e.target) as Target,
    trigger: compact(e.trigger) as Trigger,
    outcome: e.outcome,
    occurredAt: e.occurredAt,
    observedAt: e.observedAt,
    observation: compact(e.observation) as Observation,
    correlation: compact(e.correlation ?? {}) as Correlation,
    data: normaliseData(e.action, e.data ?? {}),
    rawPayload: e.rawPayload ?? null,
  }));

/** What a connector passes to `EventSink.ingest` (before validation/normalisation). */
export type CanonicalEventInputLike = z.input<typeof canonicalEventInputSchema>;
/** A validated, normalised event input. */
export type CanonicalEventInput = z.output<typeof canonicalEventInputSchema>;

// Output types of the structured fields (nulls removed; see `compact`).
export interface ActorRef {
  type: ActorType;
  id?: string;
  login?: string;
  name?: string;
  email?: string;
}
export interface Actor extends ActorRef {
  onBehalfOf?: ActorRef;
  triggeredBy?: ActorRef;
}
export interface Target {
  type: TargetType;
  id: string;
  name?: string;
  url?: string;
  repository?: string;
  project?: string;
  application?: string;
  environment?: string;
  cluster?: string;
  namespace?: string;
  ref?: string;
}
export interface Trigger {
  type: TriggerType;
  sourceValue?: string;
  detail?: string;
}
export interface Observation {
  method: ObservationMethod;
  deliveryId?: string;
  jobId?: string;
  detail?: string;
}
export interface Correlation {
  commitShas?: string[];
  refs?: string[];
  repositories?: string[];
  environments?: string[];
  imageRefs?: string[];
  imageDigests?: string[];
  deploymentIds?: string[];
  runIds?: string[];
  pullRequests?: string[];
}
export type RawPayloadInput = z.output<typeof rawPayloadInputSchema>;
export type RawPayloadRef = z.output<typeof rawPayloadRefSchema>;

// ---------------------------------------------------------------------------
// Stored event
// ---------------------------------------------------------------------------

/**
 * An event as recorded in the audit log. Every field except `hash` is covered
 * by `hash` (see `hashEvent` in hash-chain.ts).
 */
export interface CanonicalEvent {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  /** UUID assigned by Afe. */
  id: string;
  tenantId: string;
  /** Position in the tenant's hash chain, 1-based and gap-free. */
  seq: number;
  source: EventSource;
  sourceEventId: string;
  connectionId: string | null;
  action: EventAction;
  actor: Actor;
  target: Target;
  trigger: Trigger;
  outcome: Outcome;
  occurredAt: string;
  observedAt: string;
  /** When Afe appended it to the log. */
  recordedAt: string;
  observation: Observation;
  correlation: Correlation;
  data: JsonObject;
  rawPayload: RawPayloadRef | null;
  /** `hash` of the previous event in the tenant chain (GENESIS_HASH for seq 1). */
  prevHash: string;
  /** SHA-256 (hex) of the canonical JSON of every other field. */
  hash: string;
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Runtime schema for a stored event, e.g. when reading an export back in.
 * Structured fields are checked by the same schemas as input.
 */
export const canonicalEventSchema = z.strictObject({
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  id: z.uuid(),
  tenantId: str(128),
  seq: z.number().int().positive(),
  source: z.string().regex(SOURCE_PATTERN),
  sourceEventId: str(SOURCE_EVENT_ID_MAX),
  connectionId: str(128).nullable(),
  action: z.string().regex(ACTION_PATTERN),
  actor: actorSchema,
  target: targetSchema,
  trigger: triggerSchema,
  outcome: z.enum(OUTCOMES),
  occurredAt: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  observation: observationSchema,
  correlation: correlationSchema,
  data: jsonObjectSchema,
  rawPayload: rawPayloadRefSchema.nullable(),
  prevHash: hex64,
  hash: hex64,
});

// ---------------------------------------------------------------------------
// Validation entry points
// ---------------------------------------------------------------------------

export class EventValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];
  constructor(error: z.ZodError) {
    super(`invalid event: ${z.prettifyError(error)}`);
    this.name = "EventValidationError";
    this.issues = error.issues;
  }
}

/** Validates and normalises connector input. Throws `EventValidationError`. */
export function parseEventInput(input: unknown): CanonicalEventInput {
  const result = canonicalEventInputSchema.safeParse(input);
  if (!result.success) throw new EventValidationError(result.error);
  return result.data;
}

export function safeParseEventInput(
  input: unknown,
): { success: true; data: CanonicalEventInput } | { success: false; error: EventValidationError } {
  const result = canonicalEventInputSchema.safeParse(input);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: new EventValidationError(result.error) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a source event id from parts, joined with ":". `%` and `:` inside a
 * part are percent-encoded so distinct part lists never collide.
 *
 *   sourceEventId("deployment", 123, "created") === "deployment:123:created"
 */
export function sourceEventId(...parts: (string | number)[]): string {
  if (parts.length === 0) throw new Error("sourceEventId needs at least one part");
  return parts.map((p) => String(p).replace(/%/g, "%25").replace(/:/g, "%3A")).join(":");
}

/**
 * Normalises a repository identifier to the correlation form "host/owner/name"
 * (lower case, no scheme, credentials, port or ".git"). Accepts https URLs,
 * scp-like git URLs (git@host:owner/name.git) and "owner/name" (GitHub assumed).
 */
export function repositoryKey(repo: string, defaultHost = "github.com"): string {
  let s = repo.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const u = new URL(s);
    s = `${u.hostname}${u.pathname}`;
  } else if (s.split("/").length === 2) {
    s = `${defaultHost}/${s}`;
  }
  return s
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/** Raw payload from an already-parsed JSON value (re-serialised; prefer the exact bytes). */
export function jsonRawPayload(value: unknown): RawPayloadInput {
  return { contentType: "application/json", body: JSON.stringify(value) };
}

/** Removes null/undefined object members recursively (arrays are kept as-is). */
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = compact(v);
    }
    return out;
  }
  return value;
}

function normaliseData(action: string, data: JsonObject): JsonObject {
  if (!action.startsWith("observation_gap.")) return data;
  // Store the gap in its normalised form (timestamps in UTC ms, no nulls).
  const gap = compact(observationGapSchema.parse(data.gap)) as JsonObject;
  return { ...data, gap };
}

function scanStrings(
  value: unknown,
  path: (string | number)[],
  report: (path: (string | number)[], message: string) => void,
): void {
  if (typeof value === "string") {
    if (value.includes("\u0000")) report(path, "string contains NUL (\\u0000)");
    else if (hasLoneSurrogate(value)) report(path, "string contains a lone UTF-16 surrogate");
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanStrings(v, [...path, i], report));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.includes("\u0000") || hasLoneSurrogate(k)) report([...path, k], "invalid key");
      scanStrings(v, [...path, k], report);
    }
  }
}
