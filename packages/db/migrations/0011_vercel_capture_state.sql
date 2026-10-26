-- AFE-12: Vercel event capture state (connector-owned, mutable; not audit data).

-- Per-connection deployments poll cursor.
CREATE TABLE vercel_poll_state (
  tenant_id         text NOT NULL,
  connection_id     uuid NOT NULL,
  -- Deployments created before this time have been listed (the next poll
  -- re-reads from cursor minus an overlap window). NULL until the first poll.
  cursor            timestamptz,
  -- Non-terminal deployments to re-check: [{id, projectId, createdAt}].
  open_deployments  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(open_deployments) = 'array'),
  -- Projects already backfilled: {"mode":"none"|"all"} or {"mode":"selected","projectIds":[...]}.
  backfilled        jsonb NOT NULL DEFAULT '{"mode":"none"}'::jsonb CHECK (jsonb_typeof(backfilled) = 'object'),
  last_polled_at    timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);

-- Last production deployment Afe saw per project, to detect promotions and
-- rollbacks that create no new deployment.
CREATE TABLE vercel_production_state (
  tenant_id                       text NOT NULL,
  connection_id                   uuid NOT NULL,
  project_id                      text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  deployment_id                   text NOT NULL CHECK (length(deployment_id) BETWEEN 1 AND 128),
  deployment_created_at           timestamptz,
  previous_deployment_id          text,
  previous_deployment_created_at  timestamptz,
  -- Last time Afe confirmed deployment_id was production.
  last_seen_at                    timestamptz NOT NULL,
  changed_at                      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, project_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);
