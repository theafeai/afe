-- Per-user source access cache (M1, P4). Holds the repository list a user's own
-- linked GitHub account could read when it was last checked. Served for read views
-- only, and only while younger than the 5-minute TTL (enforced by the server).
-- Bound to the linked credential: a relinked account never reuses an old row.
-- Deleted on unlink, relink, policy change, user disable/deletion and failed refresh.
-- Never shown to other users. See docs/security/data-inventory.md.
CREATE TABLE user_source_access (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  tool text NOT NULL CHECK (tool IN ('github')),
  credential_id uuid NOT NULL,
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, tool),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX user_source_access_fetched ON user_source_access (tenant_id, fetched_at);
