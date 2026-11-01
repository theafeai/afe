-- Optional administrator restrictions layered over GitHub source permissions.
-- Existing modes and custom allowlists retain their meaning; no rows are rewritten.
ALTER TABLE user_tool_permissions
  ADD COLUMN denied_grants jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(denied_grants) = 'array');
