-- Sign in with GitHub (M1, P7). Off by default; auto-provisioning is a separate
-- opt-in and needs at least one allowed organization. Auto-provisioned users are
-- managed (viewer) users: `default_role` can never be admin.
CREATE TABLE github_sign_in (
  tenant_id text PRIMARY KEY REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  auto_provision boolean NOT NULL DEFAULT false,
  allowed_orgs text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_orgs) <= 50),
  default_role text NOT NULL DEFAULT 'viewer' CHECK (default_role = 'viewer'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT auto_provision OR cardinality(allowed_orgs) > 0)
);

-- Single-use login state, bound to a pre-login browser cookie (login CSRF).
-- Only digests are stored; rows expire after ten minutes.
CREATE TABLE github_sign_in_states (
  tenant_id text NOT NULL REFERENCES tenants(id),
  digest text NOT NULL,
  browser_binding text NOT NULL,
  next_path text NOT NULL CHECK (length(next_path) BETWEEN 1 AND 512),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, digest)
);
