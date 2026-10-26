-- Canonical event log (AFE-4, ADR 0003). Field reference: docs/event-model.md.
--
-- events and raw_payloads are append-only: UPDATE, DELETE and TRUNCATE are
-- rejected by triggers. Each event is hash-chained to the previous event of
-- the same tenant; event_chain_heads holds the current head per tenant and is
-- the row locked to serialise appends.

-- Raw evidence exactly as received from the source (webhook body, API
-- response). Referenced by events.raw_payload_id; its sha256 is covered by the
-- event hash.
CREATE TABLE raw_payloads (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants (id),
  source        text NOT NULL,
  content_type  text NOT NULL,
  body          bytea NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    integer NOT NULL CHECK (size_bytes >= 0),
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX raw_payloads_tenant_received_idx ON raw_payloads (tenant_id, received_at);

CREATE TABLE events (
  id                  uuid PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (id),
  seq                 bigint NOT NULL CHECK (seq >= 1),
  schema_version      smallint NOT NULL,
  source              text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  source_event_id     text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 512),
  connection_id       text,
  action              text NOT NULL,
  actor               jsonb NOT NULL,
  target              jsonb NOT NULL,
  trigger             jsonb NOT NULL,
  outcome             text NOT NULL,
  occurred_at         timestamptz NOT NULL,
  observed_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL,
  observation         jsonb NOT NULL,
  correlation         jsonb NOT NULL,
  data                jsonb NOT NULL,
  raw_payload_id      uuid,
  raw_payload_sha256  text,
  prev_hash           text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash                text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  -- Chain position is unique and gap-free per tenant.
  CONSTRAINT events_tenant_seq_key UNIQUE (tenant_id, seq),
  -- Idempotency: one event per source object/transition, however it arrived.
  CONSTRAINT events_source_event_key UNIQUE (tenant_id, source, source_event_id),
  -- A tenant's events can only reference that tenant's raw payloads.
  CONSTRAINT events_raw_payload_fkey FOREIGN KEY (tenant_id, raw_payload_id)
    REFERENCES raw_payloads (tenant_id, id),
  CONSTRAINT events_raw_payload_ref_check
    CHECK ((raw_payload_id IS NULL) = (raw_payload_sha256 IS NULL))
);

-- Query paths (AFE-14 builds the query API on these).
CREATE INDEX events_tenant_occurred_idx ON events (tenant_id, occurred_at, seq);
CREATE INDEX events_tenant_recorded_idx ON events (tenant_id, recorded_at);
CREATE INDEX events_tenant_source_action_idx ON events (tenant_id, source, action, occurred_at);
CREATE INDEX events_tenant_action_idx ON events (tenant_id, action, occurred_at);
CREATE INDEX events_tenant_connection_idx ON events (tenant_id, connection_id, occurred_at)
  WHERE connection_id IS NOT NULL;
CREATE INDEX events_tenant_actor_id_idx ON events (tenant_id, (actor ->> 'id'), occurred_at);
CREATE INDEX events_tenant_actor_login_idx
  ON events (tenant_id, lower(actor ->> 'login'), occurred_at);
CREATE INDEX events_tenant_target_idx
  ON events (tenant_id, (target ->> 'type'), (target ->> 'id'), occurred_at);
CREATE INDEX events_tenant_target_repo_idx
  ON events (tenant_id, (target ->> 'repository'), occurred_at)
  WHERE target ? 'repository';
CREATE INDEX events_tenant_target_env_idx
  ON events (tenant_id, (target ->> 'environment'), occurred_at)
  WHERE target ? 'environment';
-- Correlation keys (commit SHAs, image digests, ...): containment queries such
-- as  correlation @> '{"commitShas":["<sha>"]}'  (combine with tenant_id = $1).
CREATE INDEX events_correlation_idx ON events USING gin (correlation jsonb_path_ops);

-- Current head of each tenant's chain. Mutable bookkeeping (not evidence):
-- appends lock this row FOR UPDATE, and verification compares it with the
-- last event to detect removal of events from the end of the chain.
CREATE TABLE event_chain_heads (
  tenant_id   text PRIMARY KEY REFERENCES tenants (id),
  seq         bigint NOT NULL CHECK (seq >= 0),
  hash        text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only enforcement.
CREATE FUNCTION afe_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'afe: % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit records are immutable. See docs/decisions/0003-event-model-and-audit-log.md.';
END;
$$;

CREATE TRIGGER events_no_update_delete
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION afe_reject_mutation();
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION afe_reject_mutation();
CREATE TRIGGER raw_payloads_no_update_delete
  BEFORE UPDATE OR DELETE ON raw_payloads
  FOR EACH ROW EXECUTE FUNCTION afe_reject_mutation();
CREATE TRIGGER raw_payloads_no_truncate
  BEFORE TRUNCATE ON raw_payloads
  FOR EACH STATEMENT EXECUTE FUNCTION afe_reject_mutation();

-- Defence in depth: an inserted event must link to its predecessor, whoever
-- writes it. (The hash itself is computed and verified in application code.)
CREATE FUNCTION afe_check_event_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev text;
BEGIN
  IF NEW.seq = 1 THEN
    prev := repeat('0', 64);
  ELSE
    SELECT hash INTO prev FROM events WHERE tenant_id = NEW.tenant_id AND seq = NEW.seq - 1;
  END IF;
  IF prev IS NULL OR prev <> NEW.prev_hash THEN
    RAISE EXCEPTION 'afe: event seq % of tenant % does not link to its predecessor',
      NEW.seq, NEW.tenant_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER events_check_link
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION afe_check_event_link();
