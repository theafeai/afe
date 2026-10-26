-- Audit query API (AFE-14): indexes for filters not covered by 0002.
-- Environment and repository filters are case-insensitive (docs/api.md).
CREATE INDEX events_tenant_target_env_lower_idx
  ON events (tenant_id, lower(target ->> 'environment'), occurred_at, seq);
CREATE INDEX events_tenant_target_repo_lower_idx
  ON events (tenant_id, lower(target ->> 'repository'), occurred_at, seq);
CREATE INDEX events_tenant_trigger_type_idx
  ON events (tenant_id, (trigger ->> 'type'), occurred_at, seq);
CREATE INDEX events_tenant_observation_method_idx
  ON events (tenant_id, (observation ->> 'method'), occurred_at, seq);
CREATE INDEX events_tenant_outcome_idx ON events (tenant_id, outcome, occurred_at, seq);
