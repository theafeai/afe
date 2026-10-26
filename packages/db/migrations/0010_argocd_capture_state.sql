-- ArgoCD event capture state (AFE-10). Mutable bookkeeping, not audit data:
-- what the watch/reconciliation last saw per connection and per application,
-- so only changes are emitted and reconciliation can find what the stream
-- missed. Holds identifiers, statuses, timestamps, hashes and image
-- references only, never spec values (docs/security/data-inventory.md).

-- One row per ArgoCD connection: capture baseline and watch resume point.
CREATE TABLE argocd_capture_cursors (
  tenant_id             text NOT NULL,
  connection_id         uuid NOT NULL,
  -- When capture started; earlier source activity is recorded as backfill.
  baseline_at           timestamptz NOT NULL,
  -- Last application resourceVersion seen on the watch stream.
  resource_version      text,
  last_stream_event_at  timestamptz,
  last_reconciled_at    timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);

-- One row per application (by metadata.uid) per connection.
CREATE TABLE argocd_application_states (
  tenant_id      text NOT NULL,
  connection_id  uuid NOT NULL,
  app_uid        text NOT NULL CHECK (length(app_uid) BETWEEN 1 AND 128),
  name           text NOT NULL,
  app_namespace  text,
  -- AppCaptureState (packages/connector-argocd/src/capture/state.ts).
  state          jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  deleted_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id, app_uid),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX argocd_application_states_live_idx
  ON argocd_application_states (tenant_id, connection_id)
  WHERE deleted_at IS NULL;
