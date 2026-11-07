-- Short-lived operational receipts; no parameters, manifests or provider bodies.
CREATE TABLE argocd_action_requests (
  tenant_id text NOT NULL REFERENCES tenants(id),
  request_id uuid NOT NULL,
  actor_id text NOT NULL,
  connection_id uuid NOT NULL,
  application text NOT NULL,
  app_namespace text NOT NULL,
  action text NOT NULL,
  source_permission text NOT NULL,
  input_digest text NOT NULL,
  version text NOT NULL,
  lock_key text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','accepted','rejected','unknown','released')),
  upstream_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  PRIMARY KEY (tenant_id,request_id),
  FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id)
);
CREATE UNIQUE INDEX argocd_operation_lock ON argocd_action_requests (tenant_id,connection_id,lock_key)
  WHERE state IN ('requested','unknown');
-- Accepted identical submissions cannot run again against the same source version.
CREATE UNIQUE INDEX argocd_operation_accepted ON argocd_action_requests (tenant_id,connection_id,lock_key,version)
  WHERE state IN ('requested','accepted','unknown');
CREATE INDEX argocd_operation_history ON argocd_action_requests (tenant_id,actor_id,created_at DESC);
