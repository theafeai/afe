CREATE TABLE user_tool_accounts (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  tool text NOT NULL,
  account_name text NOT NULL,
  credential_id uuid NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id,tool),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,credential_id) REFERENCES credentials(tenant_id,id)
);
CREATE TABLE user_oauth_states (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  tool text NOT NULL CHECK (tool IN ('github', 'vercel')),
  digest text NOT NULL,
  session_binding text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,digest),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id)
);
