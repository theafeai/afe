-- Local credentials are random bearer secrets: retain only a SHA-256 digest.
CREATE TABLE users (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  username text NOT NULL CHECK (length(username) BETWEEN 1 AND 100),
  credential_digest text NOT NULL,
  credential_version integer NOT NULL DEFAULT 1,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, username)
);

CREATE TABLE user_tool_permissions (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  tool text NOT NULL CHECK (length(tool) BETWEEN 1 AND 100),
  mode text NOT NULL CHECK (mode IN ('none', 'source', 'custom', 'source + custom')),
  custom_grants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(custom_grants) = 'array'),
  PRIMARY KEY (tenant_id, user_id, tool),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
