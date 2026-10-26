/**
 * Shared connection model. A connection is one link between a tenant and an
 * external tool (a GitHub App installation, an ArgoCD instance, a Vercel
 * team). Every connector registers its connections here so that connection
 * health (AFE-13), the API and the UI treat all tools uniformly.
 */
import type { JsonObject } from "./event.ts";

export const CONNECTION_STATUSES = [
  /** Created but not yet verified (e.g. install flow in progress). */
  "pending",
  /** Verified and being observed. */
  "active",
  /** Temporarily not usable at the source (e.g. GitHub App suspended). */
  "suspended",
  /** Access was revoked at the source (token revoked, app uninstalled). */
  "revoked",
  /** Disconnected by the user in Afe. */
  "disconnected",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface Connection {
  tenantId: string;
  id: string;
  source: string;
  /** Identity at the source, unique per (tenant, source). */
  externalId: string;
  name: string;
  status: ConnectionStatus;
  statusReason: string | null;
  /** Non-secret, connector-specific settings. Never put secrets here. */
  config: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

/** Result of a connector's lightweight reachability/authorisation check. */
export type ProbeResult =
  | { ok: true }
  | {
      ok: false;
      /** Maps onto observation gap reasons (see observationGapSchema). */
      reason: "unreachable" | "rate_limited" | "unauthorized" | "revoked" | "error";
      detail?: string;
      /** For rate limits: when the source says we may retry. */
      retryAfter?: Date;
    };

/**
 * What every connector exposes to shared machinery (health checks, backfill
 * after gaps). Connectors implement this in their package; the server wires
 * them together.
 */
export interface ConnectorHealthHooks {
  source: string;
  /** Cheap check that the connection is reachable and its credentials work. */
  probe(connection: Connection): Promise<ProbeResult>;
  /**
   * Re-observe the source for [from, to] after a gap, ingesting anything
   * missed (marked observation.method "backfill" or "reconciliation").
   */
  backfill?(connection: Connection, from: Date, to: Date): Promise<void>;
}

/** Failure reasons a connector (or a probe) can report to connection health. */
export type HealthFailureReason = Extract<ProbeResult, { ok: false }>["reason"];

/** How a successful observation was made. */
export type ObservationVia = "webhook" | "poll" | "probe" | "stream" | "backfill";

/**
 * Connection health reporting (AFE-13), available to connectors as
 * `ctx.health` when the health module is registered. Connectors call
 * `reportSuccess` whenever an observation of the source succeeds (webhook
 * verified and ingested, poll returned) and `reportFailure` when it fails.
 * Both are idempotent and safe to call concurrently. See docs/connection-health.md.
 */
export interface HealthReporter {
  reportSuccess(
    tenantId: string,
    connectionId: string,
    at?: Date,
    options?: { via?: ObservationVia },
  ): Promise<void>;
  /**
   * `detail` is sanitised before it is stored, but never pass credentials,
   * headers or response bodies; status code and request id are enough.
   */
  reportFailure(
    tenantId: string,
    connectionId: string,
    reason: HealthFailureReason,
    detail?: string,
    retryAfter?: Date,
    at?: Date,
  ): Promise<void>;
  /**
   * false while the connection is backing off (rate limit Retry-After,
   * exponential backoff, revoked credentials). Pollers should skip the call.
   */
  canAttempt(tenantId: string, connectionId: string, at?: Date): Promise<boolean>;
}
