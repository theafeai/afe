ALTER TABLE users ADD COLUMN email text;
CREATE UNIQUE INDEX users_email_unique ON users (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE TABLE user_email_links (
  tenant_id text NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_digest text NOT NULL,
  credential_version integer NOT NULL,
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('invitation','reset')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE TABLE email_outbox (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  credential_id uuid NOT NULL,
  link_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,credential_id) REFERENCES credentials(tenant_id,id),
  FOREIGN KEY (tenant_id,link_id) REFERENCES user_email_links(tenant_id,id)
);
CREATE INDEX email_outbox_pending ON email_outbox (next_attempt_at) WHERE state='pending';
CREATE INDEX user_email_links_user ON user_email_links (tenant_id,user_id,created_at);
