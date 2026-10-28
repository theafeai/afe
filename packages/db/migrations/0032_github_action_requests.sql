-- Operational receipts and duplicate suppression, not a long-term audit log.
CREATE TABLE github_action_requests (
  tenant_id text NOT NULL REFERENCES tenants(id),
  request_id uuid NOT NULL,
  actor_id text NOT NULL,
  connection_id uuid NOT NULL,
  repository text NOT NULL,
  run_id bigint NOT NULL,
  run_attempt integer NOT NULL,
  action text NOT NULL CHECK (action IN ('github.cancel', 'github.rerun', 'github.rerun_failed')),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'accepted', 'rejected', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, id)
);

-- Re-run all and re-run failed are mutually exclusive for the same attempt.
CREATE UNIQUE INDEX github_action_attempt_key ON github_action_requests
  (tenant_id, repository, run_id, run_attempt, (CASE WHEN action = 'github.cancel' THEN 'cancel' ELSE 'rerun' END));
