-- GitHub reconciliation polling and backfill (AFE-8).
-- Design: docs/connectors/github.md "Reconciliation".
--
-- Mutable working state only. What was found is recorded as events (with
-- observation.method = reconciliation / backfill) in the append-only log.

-- Poll cursors and ETags per (connection, repository, endpoint). `endpoint`
-- names the request and page (e.g. `runs?created>=2026-10-25#1`,
-- `deployments/880001/statuses`), or `repo` / `schedule` for per-repository
-- bookkeeping (open runs and deployments, last pass). repository_id 0 is the
-- installation itself (its repository list). Never holds credentials or
-- response bodies: only ETags, next-page URLs, object ids and timestamps.
CREATE TABLE github_poll_state (
  tenant_id      text NOT NULL,
  connection_id  uuid NOT NULL,
  repository_id  bigint NOT NULL CHECK (repository_id >= 0),
  endpoint       text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 512),
  etag           text CHECK (length(etag) <= 512),
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  polled_at      timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, repository_id, endpoint),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX github_poll_state_updated_idx ON github_poll_state (updated_at);

-- First-install history backfill, once per connection: the row is claimed
-- when the backfill is enqueued so it is not enqueued twice.
CREATE TABLE github_backfills (
  tenant_id      text NOT NULL,
  connection_id  uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('install')),
  window_from    timestamptz NOT NULL,
  window_to      timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'succeeded', 'failed')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  last_error     text CHECK (length(last_error) <= 1024),
  PRIMARY KEY (tenant_id, connection_id, kind),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE,
  CHECK (window_from <= window_to)
);
