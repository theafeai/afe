/**
 * Wire protocol between the in-cluster ArgoCD agent (apps/argocd-agent) and
 * Afe (apps/server/src/connectors/argocd-agent.ts), version 1 (AFE-28).
 * Design: docs/decisions/0004-argocd-connection-model.md "Agent protocol".
 *
 * The agent sends raw Application objects (watch events and full snapshots);
 * Afe maps them with the same AFE-10 capture code as pull mode, so mapping
 * and versioning live in one place and events dedupe with pull mode.
 *
 * Every request is `POST` with a JSON body and three headers:
 *   X-Afe-Agent-Id:  the agent id (= the Afe connection id, a UUID)
 *   X-Afe-Timestamp: unix time in seconds when the request was signed
 *   X-Afe-Signature: v1=<hex HMAC-SHA256(secret, "v1:" + timestamp + ":" + raw body)>
 * The secret itself never travels; requests older or newer than 5 minutes are
 * rejected, and every batch/heartbeat id is recorded once (replay guard).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ArgoCdApplication, ArgoCdKubeEvent } from "./types.ts";

export const AGENT_PROTOCOL_VERSION = 1 as const;
/** `webhook_deliveries.source` of agent batch and heartbeat ids. */
export const AGENT_REPLAY_SOURCE = "argocd-agent" as const;
/** `credentials.kind` of an agent secret. */
export const AGENT_SECRET_KIND = "argocd_agent_secret" as const;
/** Connection credential roles: the current secret, and the previous one during a rotation grace period. */
export const AGENT_SECRET_ROLE = "agent_secret" as const;
export const AGENT_PREVIOUS_SECRET_ROLE = "agent_secret_previous" as const;

export const AGENT_HEADERS = {
  agentId: "x-afe-agent-id",
  timestamp: "x-afe-timestamp",
  signature: "x-afe-signature",
} as const;

export const AGENT_PATHS = {
  batches: "/agent/argocd/v1/batches",
  heartbeat: "/agent/argocd/v1/heartbeat",
} as const;

/** Maximum clock difference between agent and Afe. */
export const AGENT_MAX_SKEW_MS = 5 * 60_000;
export const AGENT_MAX_ITEMS_PER_BATCH = 1000;
export const AGENT_MAX_SNAPSHOT_UIDS = 100_000;
/** Default heartbeat interval Afe asks for (the heartbeat response can change it). */
export const AGENT_DEFAULT_HEARTBEAT_SECONDS = 30;

export const SECRET_PREFIX = "afeag_";

/** A new agent secret: 32 random bytes, base64url, with a recognisable prefix (secret scanners). */
export function generateAgentSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** How the agent reads applications. */
export type AgentReadMode = "kubernetes" | "argocd-api";

/** A watch event: the object as the watch delivered it. */
export interface AgentWatchItem {
  kind: "watch";
  type: "ADDED" | "MODIFIED" | "DELETED";
  observedAt: string;
  application: ArgoCdApplication;
  /** Kubernetes Events about the application (actor attribution), if the agent may read them. */
  events?: ArgoCdKubeEvent[];
}

/** One application of a full snapshot (list). */
export interface AgentSnapshotItem {
  kind: "snapshot";
  snapshotId: string;
  observedAt: string;
  application: ArgoCdApplication;
  events?: ArgoCdKubeEvent[];
}

/**
 * End of a full snapshot: the uids of every application in the list. Afe
 * records applications it knows but that are not listed as deleted, and closes
 * observation gaps that the snapshot covers.
 */
export interface AgentSnapshotEnd {
  kind: "snapshot_end";
  snapshotId: string;
  /** When the list started (applications seen later are never treated as deleted). */
  listedAt: string;
  /** The agent's `droppedTotal` when the snapshot started (see `AgentBatch.droppedTotal`). */
  droppedTotalAtStart: number;
  uids: string[];
}

export type AgentItem = AgentWatchItem | AgentSnapshotItem | AgentSnapshotEnd;

interface AgentEnvelope {
  protocol: typeof AGENT_PROTOCOL_VERSION;
  agentId: string;
  /** Random id of the agent process; changes on every restart. */
  runId: string;
  sentAt: string;
  agentVersion: string;
  mode: AgentReadMode;
  /** Observations the agent dropped (buffer full, rejected batch) since `runId` started. */
  droppedTotal: number;
}

export interface AgentBatch extends AgentEnvelope {
  batchId: string;
  /** 1-based, increasing by one per batch within a run. */
  sequence: number;
  items: AgentItem[];
}

export interface AgentHeartbeat extends AgentEnvelope {
  heartbeatId: string;
  /** Sequence of the last batch Afe accepted. */
  lastSequence: number;
  buffered: number;
  watching: boolean;
  lastWatchEventAt?: string;
  lastSnapshotAt?: string;
  kubernetesVersion?: string;
  namespaces?: string[];
}

export interface AgentHeartbeatResponse {
  ok: true;
  /** Afe asks for a full snapshot (after a gap, dropped data or a backfill request). */
  resync: boolean;
  heartbeatIntervalSeconds: number;
  serverTime: string;
}

export interface AgentBatchResponse {
  /** "duplicate": this batchId was accepted before (a retry); the agent moves on. */
  status: "accepted" | "duplicate";
}

export interface AgentErrorResponse {
  error: string;
  message?: string;
  serverTime?: string;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

function signingInput(timestamp: string, body: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`v1:${timestamp}:`, "utf8"),
    typeof body === "string" ? Buffer.from(body, "utf8") : body,
  ]);
}

/** `X-Afe-Signature` value for a request body signed at `timestamp` (unix seconds). */
export function signAgentRequest(secret: string, timestamp: string, body: Buffer | string): string {
  return `v1=${createHmac("sha256", secret).update(signingInput(timestamp, body)).digest("hex")}`;
}

/** Headers for a signed agent request. */
export function agentRequestHeaders(
  agentId: string,
  secret: string,
  body: Buffer | string,
  now: Date = new Date(),
): Record<string, string> {
  const ts = String(Math.floor(now.getTime() / 1000));
  return {
    "content-type": "application/json",
    [AGENT_HEADERS.agentId]: agentId,
    [AGENT_HEADERS.timestamp]: ts,
    [AGENT_HEADERS.signature]: signAgentRequest(secret, ts, body),
  };
}

export type SignatureCheck = "ok" | "malformed" | "bad_signature" | "stale";

/**
 * Checks an agent request's signature (constant-time) and timestamp. The
 * signature is checked first so an unauthenticated caller learns nothing
 * about clock skew.
 */
export function verifyAgentSignature(input: {
  secrets: readonly string[];
  timestamp: string | string[] | undefined;
  signature: string | string[] | undefined;
  body: Buffer;
  now?: number;
  maxSkewMs?: number;
}): SignatureCheck {
  const { timestamp, signature } = input;
  if (typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp)) return "malformed";
  if (typeof signature !== "string" || !/^v1=[0-9a-f]{64}$/.test(signature)) return "malformed";
  const received = Buffer.from(signature.slice(3), "hex");
  let match = false;
  for (const secret of input.secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret)
      .update(signingInput(timestamp, input.body))
      .digest();
    // Evaluate every secret (no early exit) to keep timing independent of which one matched.
    if (timingSafeEqual(expected, received)) match = true;
  }
  if (!match) return "bad_signature";
  const skew = Math.abs((input.now ?? Date.now()) - Number(timestamp) * 1000);
  return skew <= (input.maxSkewMs ?? AGENT_MAX_SKEW_MS) ? "ok" : "stale";
}

// ---------------------------------------------------------------------------
// Validation (structure only; Application objects are validated by mapping)
// ---------------------------------------------------------------------------

export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function fail(path: string, what: string): never {
  throw new AgentProtocolError(`${path}: ${what}`);
}
function uuid(v: unknown, path: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) fail(path, "must be a UUID");
  return v.toLowerCase();
}
function time(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length > 40 || Number.isNaN(Date.parse(v)))
    fail(path, "must be an ISO 8601 timestamp");
  return new Date(v).toISOString();
}
function count(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    fail(path, "must be a non-negative integer");
  return v;
}
function str(v: unknown, path: string, max = 200): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max)
    fail(path, `must be a string of 1..${max} characters`);
  return v;
}

function envelope(v: Record<string, unknown>): AgentEnvelope {
  if (v.protocol !== AGENT_PROTOCOL_VERSION) fail("protocol", `must be ${AGENT_PROTOCOL_VERSION}`);
  if (v.mode !== "kubernetes" && v.mode !== "argocd-api")
    fail("mode", 'must be "kubernetes" or "argocd-api"');
  return {
    protocol: AGENT_PROTOCOL_VERSION,
    agentId: uuid(v.agentId, "agentId"),
    runId: uuid(v.runId, "runId"),
    sentAt: time(v.sentAt, "sentAt"),
    agentVersion: str(v.agentVersion, "agentVersion", 64),
    mode: v.mode,
    droppedTotal: count(v.droppedTotal, "droppedTotal"),
  };
}

function application(v: unknown, path: string): ArgoCdApplication {
  if (!isObj(v) || !isObj(v.metadata)) fail(path, "must be an Application object");
  const md = v.metadata as Record<string, unknown>;
  str(md.uid, `${path}.metadata.uid`, 128);
  str(md.name, `${path}.metadata.name`, 253);
  return v as ArgoCdApplication;
}

function events(v: unknown, path: string): ArgoCdKubeEvent[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 200 || !v.every(isObj))
    fail(path, "must be a list of at most 200 events");
  return v as ArgoCdKubeEvent[];
}

function item(v: unknown, path: string): AgentItem {
  if (!isObj(v)) fail(path, "must be an object");
  switch (v.kind) {
    case "watch": {
      if (v.type !== "ADDED" && v.type !== "MODIFIED" && v.type !== "DELETED")
        fail(`${path}.type`, "must be ADDED, MODIFIED or DELETED");
      const ev = events(v.events, `${path}.events`);
      return {
        kind: "watch",
        type: v.type,
        observedAt: time(v.observedAt, `${path}.observedAt`),
        application: application(v.application, `${path}.application`),
        ...(ev ? { events: ev } : {}),
      };
    }
    case "snapshot": {
      const ev = events(v.events, `${path}.events`);
      return {
        kind: "snapshot",
        snapshotId: uuid(v.snapshotId, `${path}.snapshotId`),
        observedAt: time(v.observedAt, `${path}.observedAt`),
        application: application(v.application, `${path}.application`),
        ...(ev ? { events: ev } : {}),
      };
    }
    case "snapshot_end": {
      if (!Array.isArray(v.uids) || v.uids.length > AGENT_MAX_SNAPSHOT_UIDS)
        fail(`${path}.uids`, `must be a list of at most ${AGENT_MAX_SNAPSHOT_UIDS} uids`);
      return {
        kind: "snapshot_end",
        snapshotId: uuid(v.snapshotId, `${path}.snapshotId`),
        listedAt: time(v.listedAt, `${path}.listedAt`),
        droppedTotalAtStart: count(v.droppedTotalAtStart, `${path}.droppedTotalAtStart`),
        uids: v.uids.map((u, i) => str(u, `${path}.uids[${i}]`, 128)),
      };
    }
    default:
      fail(`${path}.kind`, "must be watch, snapshot or snapshot_end");
  }
}

/** Validates a parsed batch body. Throws `AgentProtocolError` with a safe message. */
export function parseAgentBatch(v: unknown): AgentBatch {
  if (!isObj(v)) fail("body", "must be an object");
  if (!Array.isArray(v.items) || v.items.length > AGENT_MAX_ITEMS_PER_BATCH)
    fail("items", `must be a list of at most ${AGENT_MAX_ITEMS_PER_BATCH} items`);
  const sequence = count(v.sequence, "sequence");
  if (sequence < 1) fail("sequence", "must be at least 1");
  return {
    ...envelope(v),
    batchId: uuid(v.batchId, "batchId"),
    sequence,
    items: v.items.map((x, i) => item(x, `items[${i}]`)),
  };
}

/** Validates a parsed heartbeat body. */
export function parseAgentHeartbeat(v: unknown): AgentHeartbeat {
  if (!isObj(v)) fail("body", "must be an object");
  const optTime = (x: unknown, p: string) => (x === undefined ? undefined : time(x, p));
  const lastWatchEventAt = optTime(v.lastWatchEventAt, "lastWatchEventAt");
  const lastSnapshotAt = optTime(v.lastSnapshotAt, "lastSnapshotAt");
  if (typeof v.watching !== "boolean") fail("watching", "must be a boolean");
  const namespaces =
    v.namespaces === undefined
      ? undefined
      : Array.isArray(v.namespaces) && v.namespaces.length <= 100
        ? v.namespaces.map((n, i) => str(n, `namespaces[${i}]`, 63))
        : fail("namespaces", "must be a list of at most 100 namespaces");
  return {
    ...envelope(v),
    heartbeatId: uuid(v.heartbeatId, "heartbeatId"),
    lastSequence: count(v.lastSequence, "lastSequence"),
    buffered: count(v.buffered, "buffered"),
    watching: v.watching,
    ...(lastWatchEventAt ? { lastWatchEventAt } : {}),
    ...(lastSnapshotAt ? { lastSnapshotAt } : {}),
    ...(v.kubernetesVersion !== undefined
      ? { kubernetesVersion: str(v.kubernetesVersion, "kubernetesVersion", 64) }
      : {}),
    ...(namespaces ? { namespaces } : {}),
  };
}
