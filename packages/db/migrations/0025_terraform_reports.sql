-- Short-lived, strictly validated metadata only. No Terraform state or plans.
-- Replay record and staged report commit together; a scheduled sweep recovers
-- reports if the server dies before it enqueues processing.
CREATE TABLE terraform_reports (
  tenant_id text NOT NULL,
  connection_id uuid NOT NULL,
  report_key text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  PRIMARY KEY (tenant_id, connection_id, report_key),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES connections (tenant_id, id) ON DELETE CASCADE
);
