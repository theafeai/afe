# Terraform CLI reporting

Maps signed, runner-reported metadata into Afe events. No provider credentials,
cloud permissions or Terraform installation are required on the Afe server.
Afe never runs Terraform, reads its working directory, downloads state/plans,
or calls HCP Terraform/Terraform Enterprise from the reporter. The reporter only sends metadata
to the user's Afe endpoint; it has no API client for a delivery tool.

The scoped signing secret authorizes reports to one connection only. It is
generated once at registration, stored encrypted through Afe's credentials
repository, and may be rotated/revoked. Reporter secrets are not Afe admin tokens.
The Python client accepts only HTTPS, with HTTP allowed on loopback for local
testing; it refuses redirects and uses bounded timeouts/retries.

`reportSchema` rejects unknown fields. Permitted data: run UUID, operation,
phase, timestamps, numeric exit code, optional actor handle, repository, full
commit SHA, GitHub run ID and trigger. Workspace/environment/repository are
configured on the connection. GitHub run attribution requires a matching
reported repository. No logs, state, plan values, resource addresses, outputs,
diagnostics, arbitrary objects, environment variable values or raw payloads.

Protocol and setup: [docs/connectors/terraform.md](../../docs/connectors/terraform.md).

## Remote operations

The separate `TerraformClient` implements the opt-in HCP Terraform/TFE operation
path described in [Terraform delivery operations](../../docs/terraform-actions.md).
Only personal user tokens are accepted, with current per-workspace/run source
permissions. Explicit `actionsEnabled` is required independently of read access.
Queue/plan needs `can-queue-run`; apply, discard, cancel and force-cancel need the
matching run permission and availability flag. Sentinel override needs both run
and policy-check override permissions. Workspace lock/unlock needs the matching
workspace permission. Source access is checked on every call; configure minimal
workspace/team membership upstream. No observer token is upgraded or reused.

The client supports only fixed, validated relative API paths, HTTPS (operator-only
HTTP lab exception), safe DNS lookup, bounded responses/timeouts and no redirects
or automatic retries. It never exposes raw provider errors. Plan metadata is
transient; full plan/state/output values and log URLs are never persisted.
