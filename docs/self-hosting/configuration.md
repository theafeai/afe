# Configuration reference

Afe is configured with environment variables. Defaults are safe: nothing is
exposed beyond localhost, outbound calls to private networks are refused, and
no secret has a default.

Any variable marked **secret** should be provided through its `_FILE` variant
(a path to a file holding the value, e.g. a Docker or Kubernetes secret) where
one exists. Setting both `X` and `X_FILE` is an error. See [secrets](secrets.md).

## Core

| Variable                            | Default                   | Secret | Description                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                      | (required)                | yes    | PostgreSQL 16+ connection string, e.g. `postgres://afe:pw@db:5432/afe`. Add `?sslmode=verify-full` when the database is on another host. The role needs to create tables in its database (migrations); it should not be a superuser. |
| `DATABASE_URL_FILE`                 | unset                     | -      | Path to a file containing `DATABASE_URL`.                                                                                                                                                                                            |
| `AFE_ENCRYPTION_KEY`                | (required)                | yes    | Key-encryption key(s) for stored credentials: one base64/hex 32-byte key, or a comma/newline-separated list of `id:key` entries. Generate with `openssl rand -base64 32`. [Details](secrets.md).                                     |
| `AFE_ENCRYPTION_KEY_FILE`           | unset                     | -      | Path to a file with the same content. Preferred. docker-compose.yml sets it to `/run/secrets/afe_encryption_key`.                                                                                                                    |
| `AFE_ENCRYPTION_ACTIVE_KEY_ID`      | first key in the list     | no     | Key id used for new encryptions, during [rotation](secrets.md#rotating-the-encryption-key). A single bare key has the id `default`.                                                                                                  |
| `AFE_HOST`                          | `0.0.0.0`                 | no     | Address the HTTP server listens on inside the container. Exposure to the host is controlled by the compose port mapping (localhost only).                                                                                            |
| `AFE_PORT`                          | `8080`                    | no     | HTTP port inside the container (also used by the image health check).                                                                                                                                                                |
| `AFE_LOG_LEVEL`                     | `info`                    | no     | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. Logs are JSON on stdout; credentials, tokens and signatures are redacted at every level.                                                                             |
| `AFE_ALLOW_PRIVATE_NETWORK_TARGETS` | `false`                   | no     | Allow outbound calls to private, loopback, CGNAT and ULA addresses (e.g. an internal ArgoCD). Link-local and cloud metadata addresses stay blocked. [rules R6](../security/rules.md#r6--outbound-request-safety).                    |
| `AFE_ALLOW_INSECURE_HTTP_TARGETS`   | `false`                   | no     | Additionally allow plain `http:` to private targets. Lab setups only.                                                                                                                                                                |
| `AFE_WEB_DIR`                       | image: `/app/web`         | no     | Directory with the built web UI, served at `/`. Unset: no UI is served (API and webhooks only).                                                                                                                                      |
| `AFE_MIGRATIONS_DIR`                | bundled `dist/migrations` | no     | Override where SQL migrations are read from. Not normally needed.                                                                                                                                                                    |
| `NODE_EXTRA_CA_CERTS`               | unset                     | no     | Path to a PEM bundle of extra CA certificates trusted for all outbound TLS (e.g. a private CA for ArgoCD). Mount the file read-only. TLS verification is never disabled.                                                             |
| `NODE_OPTIONS`                      | `--enable-source-maps`    | no     | Node.js runtime options. Do not add `--inspect` in production.                                                                                                                                                                       |

## Chain anchoring

Signed checkpoints of each tenant's audit chain head, published outside the
database so that a consistent rewrite of the chain is detectable
([ADR 0007](../decisions/0007-chain-anchoring.md),
[verification](../export-verification.md#chain-anchors)). Off unless at
least one anchor is set; an anchor without a signing key is a startup error.

| Variable                         | Default                  | Secret | Description                                                                                                                                                                                     |
| -------------------------------- | ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFE_ANCHOR_DIR`                 | unset                    | no     | Directory for the append-only anchor files `<tenant>.anchors.jsonl`. Mount a **separate volume** that the database administrator cannot write, and sync it to retention-locked storage (below). |
| `AFE_ANCHOR_WEBHOOK_URL`         | unset                    | no     | Operator endpoint that receives each signed checkpoint as JSON (`{"type":"afe.chain_checkpoint","receipt":…}`). Outbound rules apply (https, no private targets unless allowed).                |
| `AFE_ANCHOR_TSA_URL`             | unset                    | no     | RFC 3161 timestamp authority, e.g. `https://freetsa.org/tsr`. Must be `https:` (rules R6). The token is stored with every receipt.                                                              |
| `AFE_ANCHOR_TSA_POLICY`          | unset                    | no     | Optional TSA policy OID to request.                                                                                                                                                             |
| `AFE_ANCHOR_INTERVAL`            | `1h`                     | no     | How often the `anchor.publish` job runs (`15m`, `1h`, `6h`, `1d`, or a 5-field cron expression). A tenant is anchored only when its head moved.                                                 |
| `AFE_ANCHOR_ON_EXPORT`           | `true`                   | no     | Also anchor the head at export time and embed the receipt in the export manifest.                                                                                                               |
| `AFE_ANCHOR_SIGNING_KEY`         | `AFE_EXPORT_SIGNING_KEY` | yes    | Ed25519 key for checkpoints (same formats as the export key; `afe export-keygen`). Defaults to the export signing key. `_FILE` variant supported.                                               |
| `AFE_ANCHOR_TRUSTED_PUBLIC_KEYS` | unset                    | no     | Comma-separated extra public keys accepted on older checkpoints (after a key rotation).                                                                                                         |

### Retention-locked storage without cloud SDKs

Afe writes plain files; copy them to object storage with your usual tools, on
a schedule shorter than or equal to `AFE_ANCHOR_INTERVAL`, from a host or
identity the database administrator does not control:

- **S3 Object Lock:** create the bucket with Object Lock enabled and a default
  retention in _compliance_ mode, then e.g.
  `aws s3 cp /anchors/default.anchors.jsonl s3://afe-anchors/default/$(date -u +%Y%m%dT%H%M%SZ).jsonl`.
  Upload a new object each time (versions are retained); do not rely on
  overwriting one key.
- **GCS:** set a bucket retention policy and lock it
  (`gcloud storage buckets update gs://afe-anchors --retention-period=7y` then
  `--lock-retention-period`), and upload timestamped copies with
  `gcloud storage cp`.
- Or point `AFE_ANCHOR_WEBHOOK_URL` at a small service you run that writes to
  such storage (it can authenticate requests by verifying the Ed25519
  signature with your public key).

An anchor file on the same disk or volume as the database adds nothing against
a database administrator who also controls that disk.

## docker-compose.yml settings (`.env`)

Read by `docker compose` itself; see [`.env.example`](../../.env.example).

| Variable            | Default                | Secret | Description                                                                      |
| ------------------- | ---------------------- | ------ | -------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | (required)             | yes    | Password of the `afe` database user; also used to build `DATABASE_URL`.          |
| `AFE_VERSION`       | `latest`               | no     | Image tag. Pin a release (e.g. `0.1.0`); see [upgrades](operations.md#upgrades). |
| `AFE_IMAGE`         | `ghcr.io/theafeai/afe` | no     | Image repository, e.g. for a mirror.                                             |
| `AFE_HTTP_PORT`     | `8080`                 | no     | Host port, always bound to `127.0.0.1`.                                          |

All other variables in `.env` are passed into the Afe containers. The compose
file sets `DATABASE_URL` and `AFE_ENCRYPTION_KEY_FILE` itself; do not set
`AFE_ENCRYPTION_KEY` in `.env` as well.

## Pending settings

These are being built concurrently and will be documented here when they land:

| Area                                 | Expected settings                                                                                         | Issue  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------ |
| Public URL                           | The externally reachable base URL (webhook URLs, GitHub App manifest redirect)                            | AFE-6  |
| GitHub App connector                 | App ID, private key, webhook secret (stored encrypted in the database, not in env), GitHub Enterprise URL | AFE-6  |
| ArgoCD connector                     | Server URL, token (stored encrypted), per-connection CA bundle                                            | AFE-9  |
| Vercel connector                     | Token and webhook secret (stored encrypted), team id                                                      | AFE-11 |
| Connection health and reconciliation | Probe and reconciliation polling intervals                                                                | AFE-13 |
| Query API / UI authentication        | Admin token for the single built-in tenant                                                                | AFE-14 |

Connector credentials are, by design, stored encrypted in the database
([rules R2](../security/rules.md#r2--credentials)), not in environment
variables; you enter them once through Afe and they can be rotated without a
restart.
