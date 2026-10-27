-- Open-source scope without the audit log (ADR 0008).
--
-- Events are kept for a limited retention window and then purged
-- (`retention.purge` job), so the append-only enforcement, the per-tenant
-- hash chain and chain anchoring (0002, 0016) are removed. Kept: the
-- idempotency key (tenant_id, source, source_event_id), raw payloads (deleted
-- together with their events), and `seq` as a per-tenant ordering key for
-- keyset pagination.

-- 1. Append-only and chain-link triggers.
DROP TRIGGER IF EXISTS events_no_update_delete ON events;
DROP TRIGGER IF EXISTS events_no_truncate ON events;
DROP TRIGGER IF EXISTS raw_payloads_no_update_delete ON raw_payloads;
DROP TRIGGER IF EXISTS raw_payloads_no_truncate ON raw_payloads;
DROP TRIGGER IF EXISTS events_check_link ON events;
DROP FUNCTION IF EXISTS afe_check_event_link();

-- 2. Chain anchoring (0016).
DROP TABLE IF EXISTS chain_anchor_receipts;
DROP TABLE IF EXISTS chain_anchor_state;
-- No trigger uses it any more.
DROP FUNCTION IF EXISTS afe_reject_mutation();

-- 3. seq allocation without the chain head. Each tenant's counter row is
-- locked by the inserting transaction until it commits, so a tenant's seq
-- order is its commit order (what query snapshots rely on). Numbers are never
-- reused, also after events are purged.
CREATE TABLE event_sequences (
  tenant_id  text PRIMARY KEY REFERENCES tenants (id),
  last_seq   bigint NOT NULL CHECK (last_seq >= 0)
);

INSERT INTO event_sequences (tenant_id, last_seq)
SELECT tenant_id, max(seq) FROM (
  SELECT tenant_id, seq FROM event_chain_heads
  UNION ALL
  SELECT tenant_id, max(seq) FROM events GROUP BY tenant_id
) s
GROUP BY tenant_id;

DROP TABLE event_chain_heads;

-- 4. Chain columns.
ALTER TABLE events DROP COLUMN prev_hash, DROP COLUMN hash;

-- 5. Retention purge: find a raw payload's event quickly (orphan sweep).
CREATE INDEX events_tenant_raw_payload_idx ON events (tenant_id, raw_payload_id)
  WHERE raw_payload_id IS NOT NULL;

-- 6. Remove the anchor job's schedule if pg-boss already created one.
DO $$
BEGIN
  IF to_regclass('pgboss.schedule') IS NOT NULL THEN
    DELETE FROM pgboss.schedule WHERE name = 'anchor.publish';
  END IF;
END;
$$;
