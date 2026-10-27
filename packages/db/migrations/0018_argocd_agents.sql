-- In-cluster ArgoCD agent (AFE-28, ADR 0004 "Agent protocol"). Mutable
-- bookkeeping, not audit data. The agent's secret is a credential
-- (credentials + connection_credentials); nothing secret is stored here.

-- One row per agent connection (connections.source = 'argocd',
-- config.mode = 'agent'). The agent id is the connection id.
CREATE TABLE argocd_agents (
  tenant_id                   text NOT NULL,
  connection_id               uuid NOT NULL,
  -- Last heartbeat accepted (Afe clock) and what it reported.
  last_heartbeat_at           timestamptz,
  last_heartbeat              jsonb,
  -- Last batch accepted (Afe clock), and the agent run and sequence it carried.
  last_batch_at               timestamptz,
  run_id                      uuid,
  last_sequence               bigint NOT NULL DEFAULT 0,
  -- Highest dropped-observation counter seen for run_id.
  dropped_total               bigint NOT NULL DEFAULT 0,
  -- Data may be missing (heartbeat gap, drops, sequence gap): a gap is open
  -- in connection health until a full snapshot that started after the loss
  -- has been processed. awaiting_run_id/awaiting_dropped_total identify that
  -- point in the agent's run.
  awaiting_snapshot           boolean NOT NULL DEFAULT false,
  awaiting_since              timestamptz,
  awaiting_reason             text,
  awaiting_run_id             uuid,
  awaiting_dropped_total      bigint NOT NULL DEFAULT 0,
  -- Ask the agent for a full snapshot in the next heartbeat/batch response.
  resync_requested            boolean NOT NULL DEFAULT false,
  -- When a heartbeat response last asked for a snapshot (re-asked while still awaiting).
  resync_sent_at              timestamptz,
  last_snapshot_completed_at  timestamptz,
  -- When the heartbeat-check job reported missing heartbeats (once per silence).
  silence_reported_at         timestamptz,
  -- Previous secret stays valid until then after a rotation with a grace period.
  previous_secret_expires_at  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id),
  -- Agents authenticate by connection id before the tenant is known.
  UNIQUE (connection_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);

-- Accepted agent batches waiting to be processed, in arrival order. The
-- ingest endpoint stores the verified body here (in the same transaction as
-- the replay-guard record) and enqueues a job; the job processes a
-- connection's batches strictly in order and deletes each one once its
-- events are ingested. Rows are short-lived; the body holds Application
-- objects as the agent sent them (see docs/connectors/argocd.md).
CREATE TABLE argocd_agent_batches (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL,
  connection_id  uuid NOT NULL,
  batch_id       uuid NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  body           jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  attempts       integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, connection_id, batch_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX argocd_agent_batches_pending_idx
  ON argocd_agent_batches (tenant_id, connection_id, id);
