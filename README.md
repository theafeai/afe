# Afe

**Live deployment visibility across GitHub, ArgoCD and Vercel.**

Afe watches every way a deployment can happen in your delivery tools, and who
caused it, and shows it in one timeline. It answers "who deployed what, to where,
and when?" for the recent past, and tells you when it could not see a source.

- **Read-only observation** of connected tools, with [opt-in GitHub delivery operations](docs/github-actions.md).
- **Complete:** webhooks for speed, plus reconciliation polling so missed events
  are found and flagged; outages are recorded as observation gaps, not silence.
- **Recent, not forever:** events are kept for a retention window
  (`AFE_EVENT_RETENTION_DAYS`, default 30 days, at most 60) and then deleted.
  Afe is not an audit log or a compliance record
  ([ADR 0008](docs/decisions/0008-open-source-scope-without-audit-log.md)).
- **Self-hostable:** one container plus PostgreSQL.

> Status: early development. See the [architecture decision](docs/decisions/0002-architecture-and-stack.md).

## Repository layout

| Path                   | Contents                                              |
| ---------------------- | ----------------------------------------------------- |
| `apps/server`          | API, webhook receivers, background workers, `afe` CLI |
| `apps/web`             | Web UI                                                |
| `packages/core`        | Canonical event model and extension-point interfaces  |
| `packages/db`          | PostgreSQL migrations and data access                 |
| `packages/connector-*` | GitHub, ArgoCD, Vercel and Terraform connectors       |
| `docs/`                | Decisions, security model, self-hosting guides        |

## Self-hosting

`docker compose up` with the published image: see the
[self-hosting quickstart](docs/self-hosting/quickstart.md).

For admin-created users, per-tool permissions and personal tool account linking,
see [user management](docs/user-management.md).

## Development

Try the [minimal integration examples](examples/README.md) for GitHub Actions,
ArgoCD, Vercel and Terraform. They share a tiny app and include local setup,
expected Afe observations, and cleanup.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Contributions are accepted under the [DCO](DCO).
