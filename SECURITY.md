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
self-hosting setup. The security model is described in
[`docs/security`](docs/security) (threat model, credential handling, webhook
verification).
