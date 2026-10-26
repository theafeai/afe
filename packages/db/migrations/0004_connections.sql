-- Shared registry of connections to external tools (one GitHub App
-- installation, one ArgoCD instance, one Vercel team...). Connector-specific
-- detail lives in `config` (non-secret) or in connector-owned tables keyed by
-- (tenant_id, connection_id). Secrets live only in `credentials` (AFE-5).
-- Health and observation gaps are tracked separately (AFE-13).
CREATE TABLE connections (
  tenant_id        text NOT NULL REFERENCES tenants (id),
  id               uuid NOT NULL,
  source           text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  -- The connected thing's identity at the source, e.g. GitHub installation id,
  -- normalised ArgoCD server URL, Vercel team id. Unique per tenant and source.
  external_id      text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 512),
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'active', 'suspended', 'revoked', 'disconnected')),
  status_reason    text,
  config           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source, external_id)
);

CREATE INDEX connections_source_external_idx ON connections (source, external_id);

-- Credentials attached to a connection, by role (e.g. "api_token",
-- "webhook_secret"). Several roles per connection are allowed.
CREATE TABLE connection_credentials (
  tenant_id      text NOT NULL,
  connection_id  uuid NOT NULL,
  role           text NOT NULL CHECK (role ~ '^[a-z][a-z0-9_]{0,62}$'),
  credential_id  uuid NOT NULL,
  PRIMARY KEY (tenant_id, connection_id, role),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, credential_id) REFERENCES credentials (tenant_id, id)
);
