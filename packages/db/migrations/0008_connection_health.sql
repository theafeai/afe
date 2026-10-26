-- Connection health, observation-gap bookkeeping and alerts (AFE-13).
-- Design: docs/connection-health.md.
--
-- The authoritative record of a gap is the pair of observation_gap.* events
-- in the append-only `events` table; the columns here are mutable working
-- state used to decide when to open/close gaps, when to probe and when to
-- alert.

CREATE TABLE connection_health (
  tenant_id              text NOT NULL,
  connection_id          uuid NOT NULL,
  state                  text NOT NULL DEFAULT 'unknown'
                         CHECK (state IN ('healthy', 'degraded', 'unreachable', 'rate_limited',
                                          'unauthorized', 'revoked', 'unknown')),
  -- Last time the source was successfully observed (webhook, poll, probe).
  last_success_at        timestamptz,
  -- Last time Afe tried to observe the source (success or failure).
  last_attempt_at        timestamptz,
  last_failure_at        timestamptz,
  -- Failure reason as reported (unreachable, rate_limited, ...) and a
  -- sanitised, length-limited detail. Never contains credentials.
  last_error_reason      text,
  last_error             text CHECK (length(last_error) <= 1024),
  consecutive_failures   integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- When the next probe is due (backoff, Retry-After, slow retry when revoked).
  next_attempt_at        timestamptz,
  open_gap_id            text,
  open_gap_started_at    timestamptz,
  open_gap_reason        text,
  -- Set when a "blind" alert was raised for the open gap; cleared on recovery.
  alerted_at             timestamptz,
  -- Backfill of the most recently closed gap.
  last_backfill_gap_id   text,
  last_backfill_status   text CHECK (last_backfill_status IN ('pending', 'succeeded', 'failed', 'unsupported')),
  last_backfill_at       timestamptz,
  last_backfill_error    text CHECK (length(last_backfill_error) <= 1024),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE,
  CHECK ((open_gap_id IS NULL) = (open_gap_started_at IS NULL))
);

CREATE INDEX connection_health_next_attempt_idx ON connection_health (next_attempt_at);
CREATE INDEX connection_health_open_gap_idx ON connection_health (open_gap_started_at)
  WHERE open_gap_id IS NOT NULL;

-- Alerts raised by Afe about a connection (e.g. blind longer than the
-- configured threshold). Delivered through the AlertSink extension point and
-- also recorded as connection.alert.* audit events.
CREATE TABLE alerts (
  tenant_id             text NOT NULL,
  id                    uuid NOT NULL,
  connection_id         uuid NOT NULL,
  kind                  text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  gap_id                text,
  -- Start of the blind period (last successful observation), if relevant.
  blind_since           timestamptz,
  message               text NOT NULL CHECK (length(message) <= 2048),
  opened_at             timestamptz NOT NULL,
  resolved_at           timestamptz,
  -- AlertSink delivery bookkeeping (retried by the alert-check job).
  opened_notified_at    timestamptz,
  resolved_notified_at  timestamptz,
  notify_attempts       integer NOT NULL DEFAULT 0,
  last_notify_error     text CHECK (length(last_notify_error) <= 1024),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);

-- At most one open alert of a kind per connection.
CREATE UNIQUE INDEX alerts_open_kind_idx ON alerts (tenant_id, connection_id, kind)
  WHERE resolved_at IS NULL;
CREATE INDEX alerts_tenant_connection_idx ON alerts (tenant_id, connection_id, opened_at);

-- Transactional outbox for health side effects (audit events and jobs). Rows
-- are written in the same transaction that changes connection_health, then
-- delivered (EventSink / job queue) after commit and deleted. Delivery is
-- idempotent (deterministic event keys, singleton job keys), so a crash
-- between delivery and delete only causes a harmless re-delivery.
CREATE TABLE health_outbox (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants (id),
  connection_id  uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('event', 'job')),
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX health_outbox_tenant_connection_idx ON health_outbox (tenant_id, connection_id, id);
