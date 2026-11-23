-- Short-lived operational evidence and duplicate suppression (ADR 0011), not an audit log.
CREATE TABLE terraform_action_requests (
  tenant_id text NOT NULL REFERENCES tenants(id),
  request_id uuid NOT NULL,
  actor_id text NOT NULL,
  connection_id uuid NOT NULL,
  action text NOT NULL,
  resource_key text NOT NULL,
  input_digest text NOT NULL,
  version text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','accepted','rejected','unknown','released')),
  result_run_id text,
  upstream_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections(tenant_id, id)
);
CREATE UNIQUE INDEX terraform_operation_inflight ON terraform_action_requests
  (tenant_id,connection_id,resource_key) WHERE state IN ('requested','unknown');
CREATE UNIQUE INDEX terraform_operation_version ON terraform_action_requests
  (tenant_id,connection_id,resource_key,action,version) WHERE state IN ('requested','accepted','unknown') AND action NOT IN ('terraform.plan','terraform.run');
CREATE INDEX terraform_operation_history ON terraform_action_requests (tenant_id,actor_id,created_at DESC);
