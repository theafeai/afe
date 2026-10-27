-- Environment and service mapping (AFE-19). docs/environment-mapping.md.
--
-- Per-tenant configuration that classifies events into services (matrix rows)
-- and environments (matrix columns). It is applied when events are read and
-- never written into the append-only events table. Every change is audited
-- as a `config.mapping.changed` event (source afe), via the outbox below.

-- One row per tenant once its mapping has been changed. Until then the tenant
-- uses the built-in default environments (no rows in mapping_environments);
-- the first change copies them in. `revision` increases with every change and
-- is part of the audit event's idempotency key.
CREATE TABLE mapping_settings (
  tenant_id   text PRIMARY KEY REFERENCES tenants (id),
  revision    bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mapping_services (
  tenant_id    text NOT NULL REFERENCES tenants (id),
  id           text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description  text CHECK (length(description) <= 1024),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE mapping_environments (
  tenant_id   text NOT NULL REFERENCES tenants (id),
  id          text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  kind        text NOT NULL
              CHECK (kind IN ('production', 'staging', 'preview', 'development', 'other')),
  sort_order  integer NOT NULL CHECK (sort_order >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- Tenant rules. A service rule references a service, an environment rule an
-- environment (same tenant); deleting a referenced target is refused.
CREATE TABLE mapping_rules (
  tenant_id       text NOT NULL REFERENCES tenants (id),
  id              uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('service', 'environment')),
  field           text NOT NULL CHECK (length(field) BETWEEN 1 AND 300),
  match_type      text NOT NULL CHECK (match_type IN ('exact', 'glob', 'regex')),
  pattern         text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 256),
  case_sensitive  boolean NOT NULL DEFAULT false,
  priority        integer NOT NULL CHECK (priority >= 0),
  service_id      text,
  environment_id  text,
  enabled         boolean NOT NULL DEFAULT true,
  note            text CHECK (length(note) <= 512),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT mapping_rules_target_check CHECK (
    (kind = 'service' AND service_id IS NOT NULL AND environment_id IS NULL) OR
    (kind = 'environment' AND environment_id IS NOT NULL AND service_id IS NULL)
  ),
  CONSTRAINT mapping_rules_service_fkey FOREIGN KEY (tenant_id, service_id)
    REFERENCES mapping_services (tenant_id, id),
  CONSTRAINT mapping_rules_environment_fkey FOREIGN KEY (tenant_id, environment_id)
    REFERENCES mapping_environments (tenant_id, id)
);

CREATE INDEX mapping_rules_order_idx ON mapping_rules (tenant_id, kind, priority, id);

-- Built-in default rules are defined in code (@afe/core/mapping); tenants can
-- only switch them off or on.
CREATE TABLE mapping_builtin_rule_overrides (
  tenant_id   text NOT NULL REFERENCES tenants (id),
  rule_id     text NOT NULL CHECK (rule_id ~ '^builtin:[a-z0-9-]{1,64}$'),
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_id)
);

-- Audit events of mapping changes, written in the same transaction as the
-- change and appended to the audit log right after commit (and by the
-- `mapping.audit-outbox` job if that failed), so no change goes unaudited.
CREATE TABLE mapping_audit_outbox (
  tenant_id   text NOT NULL REFERENCES tenants (id),
  id          uuid NOT NULL,
  revision    bigint NOT NULL,
  event       jsonb NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text CHECK (length(last_error) <= 1024),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX mapping_audit_outbox_created_idx ON mapping_audit_outbox (created_at);
