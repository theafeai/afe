-- Chain anchoring (AFE-29, ADR 0007).
--
-- chain_anchor_receipts is a convenience copy of receipts published to
-- anchors outside the database (file, webhook, RFC 3161 TSA, ...). It is NOT
-- trusted by verification on its own: verifiers re-check signatures and
-- compare with an external anchor source. Rows are never updated.
CREATE TABLE chain_anchor_receipts (
  id                     uuid PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (id),
  anchor_kind            text NOT NULL CHECK (length(anchor_kind) BETWEEN 1 AND 64),
  seq                    bigint NOT NULL CHECK (seq >= 1),
  hash                   text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  checkpoint_created_at  timestamptz NOT NULL,
  published_at           timestamptz NOT NULL DEFAULT now(),
  -- The full receipt (checkpoint, signature, optional timestamp token, anchor metadata).
  receipt                jsonb NOT NULL
);

CREATE INDEX chain_anchor_receipts_tenant_seq_idx
  ON chain_anchor_receipts (tenant_id, seq DESC, published_at DESC);

CREATE TRIGGER chain_anchor_receipts_no_update
  BEFORE UPDATE ON chain_anchor_receipts
  FOR EACH ROW EXECUTE FUNCTION afe_reject_mutation();

-- Mutable bookkeeping of the anchor job per tenant (last attempt and error).
CREATE TABLE chain_anchor_state (
  tenant_id        text PRIMARY KEY REFERENCES tenants (id),
  last_attempt_at  timestamptz,
  last_success_at  timestamptz,
  last_error       text CHECK (length(last_error) <= 1024),
  last_error_at    timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
