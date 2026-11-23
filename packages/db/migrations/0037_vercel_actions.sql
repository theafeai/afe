-- Explicit per-user/project consent. These credentials are separate from observers and personal read links.
CREATE TABLE vercel_action_credentials (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  project_id text NOT NULL,
  credential_id uuid NOT NULL,
  actions text[] NOT NULL,
  PRIMARY KEY (tenant_id,user_id,connection_id,project_id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  FOREIGN KEY (tenant_id,credential_id) REFERENCES credentials(tenant_id,id)
);
-- Short-lived operational evidence, with no input values or provider bodies.
CREATE TABLE vercel_action_requests (
  tenant_id text NOT NULL,
  request_id uuid NOT NULL,
  actor_id text NOT NULL,
  connection_id uuid NOT NULL,
  project_id text NOT NULL,
  action text NOT NULL,
  input_digest text NOT NULL,
  lock_key text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','accepted','rejected','unknown','released')),
  deployment_id text,
  target_deployment_id text,
  upstream_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,request_id),
  FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id)
);
-- Connection-independent: two connections to the same project must not dispatch twice.
CREATE UNIQUE INDEX vercel_action_lock ON vercel_action_requests (tenant_id,lock_key)
  WHERE state IN ('requested','unknown');
CREATE INDEX vercel_action_history ON vercel_action_requests (tenant_id,actor_id,project_id,created_at DESC);
