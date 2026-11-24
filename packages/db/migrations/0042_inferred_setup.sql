-- Inferred setup and admin overrides (ADR 0019).
-- docs/environment-mapping.md "Inferred setup".
--
-- Two stores, never mixed: `inferred_setup` is written only by the inference
-- job, `setup_overrides` only by admin API calls. Reads merge them with the
-- override winning, so inference can never overwrite an admin's choice. Each
-- table refuses writes unless the transaction declared the matching writer
-- (`SET LOCAL afe.setup_writer = 'inference' | 'admin'`), which makes that
-- separation structural rather than a convention.

-- One row per (environment, field) Afe inferred. Value, confidence, a one-line
-- reason and evidence (tool and environment names, counts, rule names; no
-- repository names, logins or commit messages). Rows of environments that no
-- longer appear in the retained events are deleted by the next run.
CREATE TABLE inferred_setup (
  tenant_id          text NOT NULL REFERENCES tenants (id),
  subject            text NOT NULL CHECK (subject ~ '^environment:[a-z0-9][a-z0-9_-]{0,63}$'),
  field              text NOT NULL
                     CHECK (field IN ('name', 'order', 'productionLike', 'gating', 'batching',
                                      'cadence', 'sources')),
  value              jsonb NOT NULL,
  confidence         text NOT NULL CHECK (confidence IN ('certain', 'strong', 'probable', 'weak')),
  reason             text NOT NULL CHECK (length(reason) <= 512),
  evidence           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  first_inferred_at  timestamptz NOT NULL DEFAULT now(),
  computed_at        timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, subject, field)
);

-- One row per (environment, field) an admin set. `set_by` is the principal id
-- (never a request field), `set_by_name` its display name. `kept_inferred`
-- is the inferred value the admin chose to keep their own value against, so
-- the same disagreement is not reported again.
CREATE TABLE setup_overrides (
  tenant_id      text NOT NULL REFERENCES tenants (id),
  subject        text NOT NULL CHECK (subject ~ '^environment:[a-z0-9][a-z0-9_-]{0,63}$'),
  field          text NOT NULL
                 CHECK (field IN ('name', 'order', 'productionLike', 'gating', 'batching',
                                  'included')),
  value          jsonb NOT NULL,
  set_by         text NOT NULL CHECK (length(set_by) BETWEEN 1 AND 256),
  set_by_name    text CHECK (length(set_by_name) <= 256),
  set_at         timestamptz NOT NULL DEFAULT now(),
  kept_inferred  jsonb,
  PRIMARY KEY (tenant_id, subject, field)
);

CREATE INDEX setup_overrides_set_by_idx ON setup_overrides (tenant_id, set_by);

CREATE FUNCTION setup_store_writer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('afe.setup_writer', true), '') <> TG_ARGV[0] THEN
    RAISE EXCEPTION 'only the % writer may change %', TG_ARGV[0], TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER inferred_setup_writer
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON inferred_setup
  FOR EACH STATEMENT EXECUTE FUNCTION setup_store_writer_guard('inference');

CREATE TRIGGER setup_overrides_writer
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON setup_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION setup_store_writer_guard('admin');

-- No more seeded default environments (ADR 0019). Tenants whose mapping
-- already exists keep their rows (they become admin environments) and keep
-- the built-in name rules switched on, so nothing they see changes. Tenants
-- set up from now on start with the built-in rules off: their environments
-- are inferred from the names their tools report.
ALTER TABLE mapping_settings
  ADD COLUMN builtin_rules_default boolean NOT NULL DEFAULT false;
UPDATE mapping_settings SET builtin_rules_default = true;
