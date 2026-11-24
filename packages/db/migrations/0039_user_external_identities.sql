-- Immutable upstream identity of an Afe user (ADR 0020).
-- `subject` is the provider's numeric account id (GitHub user id). Logins can be
-- renamed and then taken by someone else, so identities are matched by subject only;
-- `login` is display data. One upstream account maps to at most one user per tenant,
-- and a user has at most one identity per provider.
-- Existing GitHub links (0027) stored only the login. They are resolved on next use:
-- the access refresh reads GitHub's /user with the user's own token and inserts the row.
CREATE TABLE user_external_identities (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github')),
  subject text NOT NULL CHECK (subject ~ '^[1-9][0-9]{0,19}$'),
  login text NOT NULL CHECK (length(login) BETWEEN 1 AND 100),
  -- Created by Sign in with GitHub auto-provisioning (membership is re-checked).
  provisioned boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, subject),
  UNIQUE (tenant_id, user_id, provider),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
