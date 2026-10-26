# Afe

**Deployment audit and visibility across GitHub, ArgoCD and Vercel.**

Afe records every way a deployment can happen in your delivery tools, and who
caused it, into an append-only, tamper-evident audit log. It answers "who deployed
what, to where, and when?" with evidence you can export and verify.

- **Read-only** access to every connected tool.
- **Complete:** webhooks for speed, plus reconciliation polling so missed events
  are found and flagged; outages are recorded as observation gaps, not silence.
- **Verifiable:** hash-chained events and exports with an integrity proof.
- **Self-hostable:** one container plus PostgreSQL.

> Status: early development. See the [architecture decision](docs/decisions/0002-architecture-and-stack.md).

## Repository layout

| Path                   | Contents                                              |
| ---------------------- | ----------------------------------------------------- |
| `apps/server`          | API, webhook receivers, background workers, `afe` CLI |
| `apps/web`             | Web UI                                                |
| `packages/core`        | Canonical event model and extension-point interfaces  |
| `packages/db`          | PostgreSQL migrations and data access                 |
| `packages/connector-*` | GitHub, ArgoCD and Vercel connectors                  |
| `docs/`                | Decisions, security model, self-hosting guides        |

## Self-hosting

`docker compose up` with the published image: see the
[self-hosting quickstart](docs/self-hosting/quickstart.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Contributions are accepted under the [DCO](DCO).
