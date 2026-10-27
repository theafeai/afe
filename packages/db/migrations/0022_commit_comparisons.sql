-- Commit containment cache (AFE-22). docs/containment.md.
--
-- Results of GitHub's compare API for (repository, base, head). Ancestry of
-- two commit SHAs never changes, so a row is valid for as long as it exists.
-- Only definitive answers are stored (no errors or "unknown"). Derived data:
-- the `containment.prune` job deletes rows not used within the retention
-- window (ADR 0008), and the table can be truncated at any time.
CREATE TABLE commit_comparisons (
  tenant_id       text NOT NULL REFERENCES tenants (id),
  -- Lower-case "owner/name".
  repository      text NOT NULL CHECK (repository ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'),
  base_sha        text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{7,64}$'),
  head_sha        text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{7,64}$'),
  status          text NOT NULL CHECK (status IN ('ahead', 'behind', 'identical', 'diverged')),
  ahead_by        integer NOT NULL CHECK (ahead_by >= 0),
  behind_by       integer NOT NULL CHECK (behind_by >= 0),
  merge_base_sha  text CHECK (merge_base_sha ~ '^[0-9a-f]{40,64}$'),
  compared_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, repository, base_sha, head_sha)
);

CREATE INDEX commit_comparisons_last_used_idx ON commit_comparisons (last_used_at);
