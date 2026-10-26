# Self-hosting Afe

Afe runs as one container image plus PostgreSQL 16. No cloud account, no
external queue or cache, and no help from us is needed.

| Guide                                                     | What it covers                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| [Quickstart](quickstart.md)                               | Zero to a running Afe connected to a test GitHub org in ~15 minutes  |
| [Configuration reference](configuration.md)               | Every environment variable, default and whether it is a secret       |
| [Secrets](secrets.md)                                     | Providing the encryption key, `_FILE` variants, rotation             |
| [Operations](operations.md)                               | Health check, backup and restore, upgrades and migrations            |
| [Webhooks behind a firewall](webhooks-behind-firewall.md) | Exposing only `/webhooks/*` safely; reconciliation polling as backup |
| [GitHub App](credentials/github-app.md)                   | Creating a read-only GitHub App and installing it                    |
| [ArgoCD](credentials/argocd.md)                           | A read-only local account, RBAC role and API token                   |
| [Vercel](credentials/vercel.md)                           | A team-scoped, expiring token and webhook                            |

## What runs

| Component    | Image                  | Role                                                       |
| ------------ | ---------------------- | ---------------------------------------------------------- |
| `postgres`   | `postgres:16`          | Audit log, configuration, encrypted credentials, job queue |
| `afe-server` | `ghcr.io/theafeai/afe` | `afe server`: HTTP API, webhook receivers, web UI          |
| `afe-worker` | `ghcr.io/theafeai/afe` | `afe worker`: webhook processing, polling, reconciliation  |

The image's entrypoint is the `afe` CLI. Commands: `all` (default: server and
worker in one process), `server`, `worker`, `migrate`, `reencrypt-credentials`.

Images are published for `linux/amd64` and `linux/arm64` on every tagged
release, with SLSA build provenance and an SBOM attached. Verify an image with
`gh attestation verify oci://ghcr.io/theafeai/afe:<version> --owner theafeai`.
