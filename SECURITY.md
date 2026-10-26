# Security policy

Afe is an audit tool: people rely on it to tell them the truth about who deployed
what. We treat vulnerabilities, and anything that could let the audit record be
silently altered, as high priority.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub's
[private vulnerability reporting](https://github.com/theafeai/afe/security/advisories/new)
for this repository.

Please include the affected version, a description, and steps to reproduce. We aim
to acknowledge reports within 3 working days and to agree a disclosure date with
you once a fix is available.

## Supported versions

Until 1.0, only the latest release receives security fixes.

## Scope

In scope: this repository, the published container image, and the documented
self-hosting setup.

## Security model

- [Threat model](docs/security/threat-model.md): assets, actors, trust
  boundaries, STRIDE threats and mitigations, tamper evidence of the audit log.
- [Security rules for integrations](docs/security/rules.md): binding rules for
  every connector (read-only scopes, credential handling, webhook verification
  and replay rejection, log redaction, tenant isolation, outbound request
  safety, TLS).
- [Data inventory](docs/security/data-inventory.md): what Afe stores and what it
  deliberately does not (no source code, no secret or environment variable
  values).
- [Key management](docs/security/key-management.md): credential encryption,
  `AFE_ENCRYPTION_KEY`, key rotation, KMS envelope encryption for the hosted
  service.
