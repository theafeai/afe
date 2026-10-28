-- Generalize operational receipts without rewriting or removing the first slice.
ALTER TABLE github_action_requests ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE github_action_requests ALTER COLUMN run_attempt DROP NOT NULL;
ALTER TABLE github_action_requests DROP CONSTRAINT github_action_requests_action_check;
ALTER TABLE github_action_requests DROP CONSTRAINT github_action_requests_state_check;
ALTER TABLE github_action_requests ADD CONSTRAINT github_action_requests_state_check
  CHECK (state IN ('requested','accepted','rejected','unknown','released'));
ALTER TABLE github_action_requests ADD COLUMN input_digest text;
ALTER TABLE github_action_requests ADD COLUMN resource_key text;
ALTER TABLE github_action_requests ADD COLUMN lock_key text;
ALTER TABLE github_action_requests ADD COLUMN upstream_status integer;
ALTER TABLE github_action_requests ADD COLUMN result jsonb;
ALTER TABLE github_action_requests ADD COLUMN released_at timestamptz;
UPDATE github_action_requests SET lock_key = 'run:' || repository || ':' || run_id || ':' || run_attempt || ':' ||
  CASE WHEN action='github.cancel' THEN 'cancel' ELSE 'rerun' END;
DROP INDEX github_action_attempt_key;
CREATE UNIQUE INDEX github_operation_lock ON github_action_requests (tenant_id,lock_key)
  WHERE state IN ('requested','accepted','unknown') AND lock_key IS NOT NULL;
CREATE INDEX github_operation_history ON github_action_requests (tenant_id,actor_id,created_at DESC);
