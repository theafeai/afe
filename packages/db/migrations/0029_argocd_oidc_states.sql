-- PKCE verifier/nonce are encrypted in credentials, never in a plaintext state/job.
CREATE TABLE user_argocd_oidc_states (
  tenant_id text NOT NULL,
  digest text NOT NULL,
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  session_binding text NOT NULL,
  credential_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (tenant_id,digest),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  FOREIGN KEY (tenant_id,credential_id) REFERENCES credentials(tenant_id,id)
);
CREATE INDEX user_argocd_oidc_states_expiry ON user_argocd_oidc_states(expires_at);
