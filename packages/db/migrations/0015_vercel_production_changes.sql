-- AFE-30: recent production changes per Vercel project, with the idempotency
-- key each was recorded under, so repeated identical changes (A→B, B→A, A→B)
-- get distinct keys while webhook and poll still dedupe the same change.
-- [{key, from, to, source, at, notBefore}], oldest first, bounded in code.
-- Rows stored before this migration get '[]': the stored deployment is the
-- baseline and its change keeps the pre-AFE-30 key (see legacyProductionChange).
ALTER TABLE vercel_production_state
  ADD COLUMN changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes) = 'array');
