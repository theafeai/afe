-- Bind personal GitHub storage/policy to the authenticated administrator,
-- independently of its bearer token or browser session transport.
CREATE TABLE github_admin_identities (
  tenant_id text NOT NULL REFERENCES tenants(id),
  principal_id text NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, principal_id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
