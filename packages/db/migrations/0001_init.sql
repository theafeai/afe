-- Tenants. The open-source build uses the single built-in "default" tenant;
-- the hosted service creates one per customer organisation (see ADR 0002).
CREATE TABLE tenants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name) VALUES ('default', 'Default tenant');
