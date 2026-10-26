# Connection health, outages and observation gaps

- Issue: AFE-13
- Code: `apps/server/src/health/`, `packages/db/src/connection-health.ts`,
  migration `0008_connection_health.sql`, `AlertSink` and alert event builders
  in `packages/core/src/alerts.ts`, `HealthReporter` in `packages/core/src/connection.ts`.

Afe must make source outages and missed data visible instead of silent. This
module, shared by every connector (GitHub, ArgoCD, Vercel, future ones), tracks
the health and last successful observation of every connection, records
**observation gaps** in the audit log, retries with backoff, backfills after
recovery and alerts when a connection has been blind for too long.

## Pieces

| Piece                             | What it does                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `connection_health`               | Mutable per-connection state: state, last success/attempt/failure, sanitised last error, backoff, open gap.      |
| `alerts`                          | Alerts raised by Afe (`connection_blind`), with AlertSink delivery bookkeeping.                                  |
| `health_outbox`                   | Transactional outbox for audit events and jobs produced by a state change (see "Consistency").                   |
| `HealthService`                   | `reportSuccess` / `reportFailure` / `canAttempt` (`HealthReporter`), plus the job logic.                         |
| `health.probe`                    | Cron, every minute: probes active connections that are due, detects Afe downtime, delivers leftover outbox rows. |
| `health.backfill`                 | Calls the connector's `backfill(connection, gapStart, gapEnd)` after a gap closes. Retried by the queue.         |
| `health.alert-check`              | Cron, every minute: raises alerts for connections blind longer than `AFE_HEALTH_ALERT_AFTER`, retries delivery.  |
| `GET /api/connections`            | Connections with health, open gap and open alert (for the UI, AFE-16).                                           |
| `GET /api/connections/:id/health` | One connection's health, gap history (from `observation_gap.*` events) and alerts.                               |

The module is a `ConnectorModule` with source `afe` (`createHealthModule()`,
registered in `apps/server/src/connectors/index.ts`). It collects the
`health` hooks (`ConnectorHealthHooks`: `probe`, optional `backfill`) of every
registered module via `ctx.modules`, and installs itself as `ctx.health`.

## For connector authors

1. Implement `ConnectorModule.health(ctx)` returning `{ source, probe, backfill }`.
   `probe` must be cheap (one authenticated read), return `{ ok: false, reason }`
   with `reason` `unreachable | rate_limited | unauthorized | revoked | error`,
   and set `retryAfter` from `Retry-After` / rate-limit reset headers.
   `backfill(connection, from, to)` re-reads the source for the window and
   ingests what was missed with `observation.method = "backfill"` or
   `"reconciliation"` (ingestion is idempotent, so overlap is fine).
2. Call `ctx.health?.reportSuccess(tenantId, connectionId, at, { via })`
   whenever an observation succeeds (`via`: `webhook`, `poll`, `stream`...), and
   `ctx.health?.reportFailure(tenantId, connectionId, reason, detail, retryAfter)`
   when a poll/API call fails. Pollers may check `ctx.health?.canAttempt(...)`
   to respect backoff and `Retry-After`.
3. `detail` is sanitised (token-looking strings, URL credentials and query
   strings, `Authorization` values are redacted; truncated to 500 chars), but
   pass only status code, error kind and request id — never headers or bodies.
   Details are written to the immutable audit log.

## Gap rules

- **Opening.** The first failure while no gap is open opens one and emits
  `observation_gap.opened` with `startedAt` = **the last successful
  observation** (or the connection's creation time if it was never observed).
  Not the failure time: the source may have become unobservable at any point
  after the last success, and events that happened between the last success
  and the first noticed failure may be missing too. Starting the gap at the
  failure would claim coverage Afe cannot prove. Overstating a gap is safe
  (backfill re-reads a bit more); understating it is a silent hole.
- **Extending.** Further failures update the health row (state, error,
  consecutive failures, next attempt) but emit no events. The gap's `reason`
  is the reason of the failure that opened it; the current reason is on the
  health row.
- **Closing.** A success newer than the latest failure closes the gap:
  `observation_gap.closed` with `endedAt` = time of that success, a
  `health.backfill` job for `[startedAt, endedAt]`, and resolution of any open
  alert (audit event `connection.alert.resolved` + AlertSink notification).
- **Out-of-order reports** (a failure older than the last success, or a
  success older than the last failure) are recorded but do not open/close gaps.
- **Revoked / unauthorized.** State `revoked` / `unauthorized`, gap reason
  `auth_failed`, gap stays open, probing slows to `AFE_HEALTH_AUTH_RETRY_INTERVAL`
  (default 1 h) — no hammering. A webhook still arriving does not close the gap
  (Afe's API access is still broken, so polling and backfill cannot work); a
  successful probe or poll does.
- **Idempotency.** Gap ids are deterministic: a UUID-formatted SHA-256 of
  (`gap`, tenant, connection, gap start). Alert ids derive from the gap id.
  Event keys are `observation_gap:<gapId>:opened|closed` and
  `connection_alert:<alertId>:opened|resolved`, so retries and re-deliveries
  never duplicate events.
- **Afe's own downtime.** When the probe job finds a connection without an
  open gap whose last attempt is older than `AFE_HEALTH_DOWNTIME_THRESHOLD`
  (default 15 min), Afe itself was not observing it (Afe or its workers were
  down). It records an `afe_unavailable` gap from the last successful
  observation to now (opened and closed at once, id namespace `afe_unavailable`)
  and enqueues a backfill. A webhook success counts as an attempt, so a
  connection fed by webhooks while only the probe scheduler was down is not
  flagged. If the probe that follows fails, a normal gap opens from the same
  start; the two gaps overlap, which is accurate.

Reason mapping:

| Probe/report reason | Health state   | Gap reason           |
| ------------------- | -------------- | -------------------- |
| `unreachable`       | `unreachable`  | `connection_error`   |
| `rate_limited`      | `rate_limited` | `rate_limited`       |
| `unauthorized`      | `unauthorized` | `auth_failed`        |
| `revoked`           | `revoked`      | `auth_failed`        |
| `error`             | `degraded`     | `source_unavailable` |

## Probing and backoff

- Healthy connections are probed every `AFE_HEALTH_PROBE_INTERVAL` (5 min); a
  successful poll or probe pushes the next probe out, webhooks do not.
- After the n-th consecutive failure the next probe is at
  `min(AFE_HEALTH_BACKOFF_MAX, AFE_HEALTH_BACKOFF_BASE · 2^(n-1))` (30 s, 1 m,
  2 m ... capped at 15 min), minus up to 20 % random jitter.
- A `retryAfter` is honoured when later than the backoff (bounded to 24 h).
- Only `active` connections are probed; a probe times out after 30 s.

## Alerts

`health.alert-check` raises one `connection_blind` alert per open gap whose
start is older than `AFE_HEALTH_ALERT_AFTER` (default 15 min) — "blind" is
measured from the last successful observation. Disconnected connections are
skipped. Each alert is recorded in `alerts`, as a `connection.alert.opened`
audit event, and sent to the `AlertSink`. It is resolved on recovery.

`AlertSink` (`@afe/core`, ADR 0002 extension point) has one method,
`send(notification)`. The OSS default logs every alert and, if
`AFE_ALERT_WEBHOOK_URL` is set, POSTs `{"type":"afe.alert","alert":{...}}`.
The URL is validated at startup and again before every request with `validateOutboundUrl` (R6: https only
unless the self-host lab flags are set, no credentials, no private/metadata
addresses unless allowed) and the request also uses `createSafeLookup` (which Node skips for IP-literal hosts, hence the per-request check), a 10 s
timeout, no redirects, and never logs or returns the response body. Failed
deliveries are retried by each alert-check run, up to 10 attempts. The hosted
product passes its own sink: `createHealthModule({ alertSink })`.

## Consistency

All decisions for one connection run in a transaction holding its
`connection_health` row lock (`SELECT ... FOR UPDATE`), so concurrent
reports (webhooks, polls, probes on several workers) serialise per
connection. Side effects (audit events, backfill job) are written to
`health_outbox` in the same transaction and delivered after commit, then
deleted. This means the lock holder never needs a second pool connection (no
pool exhaustion under bursts), a crash cannot lose a gap event or a backfill
(leftovers are delivered by the next probe run), and re-delivery is harmless
(deterministic event keys, singleton job keys). The common case — a success
with no gap open — is a single upsert with no lock held across other work.

## Configuration

| Variable                         | Default | Meaning                                        |
| -------------------------------- | ------- | ---------------------------------------------- |
| `AFE_HEALTH_ALERT_AFTER`         | `15m`   | Alert when blind longer than this.             |
| `AFE_HEALTH_PROBE_INTERVAL`      | `5m`    | Probe interval for healthy connections.        |
| `AFE_HEALTH_BACKOFF_BASE`        | `30s`   | First retry delay after a failure.             |
| `AFE_HEALTH_BACKOFF_MAX`         | `15m`   | Backoff cap.                                   |
| `AFE_HEALTH_AUTH_RETRY_INTERVAL` | `1h`    | Retry interval when revoked/unauthorized.      |
| `AFE_HEALTH_DOWNTIME_THRESHOLD`  | `15m`   | Unattempted for longer = Afe was not watching. |
| `AFE_ALERT_WEBHOOK_URL`          | unset   | JSON webhook for alerts (validated, R6).       |

Durations accept `ms`, `s`, `m`, `h`, `d` suffixes.

## Known limitations / follow-ups

- The read API uses the built-in `default` tenant (`resolveTenant` option)
  and is unauthenticated, like the rest of the API until the `AuthProvider`
  issue lands.
- Gap history is reconstructed from events by a per-connection scan; AFE-14's
  query API may replace it.
- A connector's own pollers must call `reportSuccess`/`reportFailure`;
  connections without probe hooks are never probed (their state stays
  `unknown` until a connector reports).
