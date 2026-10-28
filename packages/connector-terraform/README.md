# Terraform CLI reporting

Maps signed, runner-reported metadata into Afe events. No provider credentials,
cloud permissions or Terraform installation are required on the Afe server.
Afe never runs Terraform, reads its working directory, downloads state/plans,
or calls HCP Terraform/Terraform Enterprise. The reporter only sends metadata
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
