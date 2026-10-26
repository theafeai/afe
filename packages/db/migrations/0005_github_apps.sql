-- AFE-6: GitHub Apps registered through the App Manifest flow (self-host).
-- An App configured from the environment (AFE_GITHUB_APP_*) is not stored here.
-- The App's private key, webhook secret and OAuth client secret live only in
-- `credentials` (encrypted); this table holds non-secret identity and links.
CREATE TABLE github_apps (
  tenant_id                     text NOT NULL REFERENCES tenants (id),
  id                            uuid NOT NULL,
  app_id                        bigint NOT NULL CHECK (app_id > 0),
  slug                          text NOT NULL CHECK (slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$'),
  name                          text NOT NULL,
  client_id                     text,
  owner_login                   text,
  html_url                      text,
  private_key_credential_id     uuid NOT NULL,
  webhook_secret_credential_id  uuid NOT NULL,
  client_secret_credential_id   uuid,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, app_id),
  FOREIGN KEY (tenant_id, private_key_credential_id) REFERENCES credentials (tenant_id, id),
  FOREIGN KEY (tenant_id, webhook_secret_credential_id) REFERENCES credentials (tenant_id, id),
  FOREIGN KEY (tenant_id, client_secret_credential_id) REFERENCES credentials (tenant_id, id)
);
