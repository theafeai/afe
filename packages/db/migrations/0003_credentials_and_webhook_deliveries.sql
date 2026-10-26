-- AFE-5: encrypted credentials and webhook replay protection.
-- See docs/security/key-management.md and docs/security/rules.md.

-- Credentials for connected tools (API tokens, GitHub App private keys, webhook
-- secrets). Only envelope-encrypted values are stored; there is deliberately no
-- plaintext column. The ciphertext is bound to (tenant_id, id) through the AEAD
-- associated data, so a row copied to another tenant or id cannot be decrypted.
CREATE TABLE credentials (
  tenant_id    text NOT NULL REFERENCES tenants (id),
  id           uuid NOT NULL,
  -- What the secret is for, e.g. github_app_private_key, argocd_token,
  -- vercel_token, vercel_webhook_secret. Not secret.
  kind         text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- Id of the key-encryption key (KeyProvider) that wrapped the data key.
  key_id       text CHECK (key_id ~ '^[A-Za-z0-9._:/-]+$' AND length(key_id) <= 256),
  wrapped_key  bytea,
  nonce        bytea CHECK (octet_length(nonce) = 12),
  ciphertext   bytea CHECK (octet_length(ciphertext) >= 16),
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  revoked_at   timestamptz,
  PRIMARY KEY (tenant_id, id),
  -- Revocation destroys the ciphertext (crypto-shredding); live rows must have it.
  CONSTRAINT credentials_material_iff_active CHECK (
    (revoked_at IS NULL
      AND key_id IS NOT NULL AND wrapped_key IS NOT NULL
      AND nonce IS NOT NULL AND ciphertext IS NOT NULL)
    OR
    (revoked_at IS NOT NULL
      AND key_id IS NULL AND wrapped_key IS NULL
      AND nonce IS NULL AND ciphertext IS NULL)
  )
);

CREATE INDEX credentials_key_id_idx ON credentials (key_id) WHERE revoked_at IS NULL;

-- Webhook deliveries already accepted, for replay rejection. tenant_id may be
-- null when a delivery arrives before its tenant is known (e.g. a GitHub App
-- installation event). Stores no payload and no headers.
CREATE TABLE webhook_deliveries (
  source       text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  delivery_id  text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 256),
  tenant_id    text REFERENCES tenants (id),
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, delivery_id)
);

CREATE INDEX webhook_deliveries_received_at_idx ON webhook_deliveries (received_at);
