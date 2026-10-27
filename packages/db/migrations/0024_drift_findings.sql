-- Drift and untracked deploy findings (AFE-26). Design: docs/drift.md.
--
-- Findings are derived from the events of the retention window by the
-- `drift.evaluate` job (and on read). They are persisted so that open →
-- resolved transitions can be detected once, recorded as
-- drift.finding.opened/resolved events and alerted through the AlertSink.
-- Each finding keeps a self-contained copy of its evidence (event ids with a
-- short summary), so it still reads well after its events were purged.
-- Findings are deleted once they ended (or were last seen) before the
-- retention cutoff.

CREATE TABLE drift_findings (
  tenant_id             text NOT NULL REFERENCES tenants (id),
  -- Deterministic: derived from (tenant, type, target, opening event).
  id                    uuid NOT NULL,
  type                  text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]{0,62}$'),
  severity              text NOT NULL
                        CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  status                text NOT NULL CHECK (status IN ('open', 'resolved')),
  target_key            text NOT NULL CHECK (length(target_key) BETWEEN 1 AND 1024),
  target_source         text NOT NULL CHECK (length(target_source) BETWEEN 1 AND 64),
  target_label          text NOT NULL CHECK (length(target_label) <= 512),
  tool_environment      text NOT NULL CHECK (length(tool_environment) <= 256),
  -- Mapping (AFE-19) at the last evaluation; NULL = unmapped.
  service_id            text,
  service_name          text,
  environment_id        text,
  environment_name      text,
  title                 text NOT NULL CHECK (length(title) <= 512),
  explanation           text NOT NULL CHECK (length(explanation) <= 4096),
  opening_event_id      text NOT NULL,
  latest_event_id       text NOT NULL,
  resolved_by_event_id  text,
  first_seen_at         timestamptz NOT NULL,
  last_seen_at          timestamptz NOT NULL,
  resolved_at           timestamptz,
  evidence              jsonb NOT NULL,
  evidence_omitted      integer NOT NULL DEFAULT 0,
  details               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Hash of the derived fields, to skip writes when nothing changed.
  fingerprint           text NOT NULL,
  detected_at           timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  -- Side effects of transitions (delivered after commit, retried):
  -- drift.finding.* events and, when alerting was on for the type at open
  -- time (`alert`), AlertSink notifications.
  opened_recorded_at    timestamptz,
  resolved_recorded_at  timestamptz,
  alert                 boolean NOT NULL DEFAULT false,
  opened_notified_at    timestamptz,
  resolved_notified_at  timestamptz,
  notify_attempts       integer NOT NULL DEFAULT 0,
  last_notify_error     text CHECK (length(last_notify_error) <= 1024),
  PRIMARY KEY (tenant_id, id),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE INDEX drift_findings_list_idx ON drift_findings (tenant_id, status, last_seen_at DESC, id);
CREATE INDEX drift_findings_target_idx ON drift_findings (tenant_id, type, target_key);
CREATE INDEX drift_findings_pending_idx ON drift_findings (tenant_id)
  WHERE opened_recorded_at IS NULL OR (status = 'resolved' AND resolved_recorded_at IS NULL)
     OR (alert AND (opened_notified_at IS NULL
                    OR (status = 'resolved' AND resolved_notified_at IS NULL)));

-- Per-tenant drift settings (admin API). Without a row the server defaults
-- apply (AFE_DRIFT_ALERTS, built-in severities).
CREATE TABLE drift_settings (
  tenant_id    text PRIMARY KEY REFERENCES tenants (id),
  -- Finding types that raise alerts; NULL = use the server default.
  alert_types  text[],
  -- Severity per finding type, overriding the built-in defaults.
  severities   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
