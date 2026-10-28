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

## Authentication

Every `/api/*` route requires a token or a UI session
([ADR 0006](../decisions/0006-api-authentication.md), [API](../api.md#authentication)).
Webhooks, `/healthz` and the static UI are public.

| Variable                      | Default         | Secret | Description                                                                                                                                                                                                                               |
| ----------------------------- | --------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFE_ADMIN_TOKEN`             | (see below)     | yes    | Full access to the API and UI (connections, install flows). At least 32 characters, e.g. `openssl rand -hex 32`. Prefer `AFE_ADMIN_TOKEN_FILE`; docker-compose.yml sets it to `/run/secrets/afe_admin_token`.                             |
| `AFE_VIEWER_TOKEN`            | unset           | yes    | Optional read-only access (events, deployments, connection status). At least 32 characters, different from the admin token. `_FILE` variant supported.                                                                                    |
| `AFE_SESSION_SECRET`          | from the tokens | yes    | HMAC key for UI session cookies (at least 32 characters). Unset: derived from the admin and viewer tokens, so rotating a token signs everyone out. Rotate it to end all sessions. `_FILE` supported.                                      |
| `AFE_SESSION_TTL`             | `12h`           | no     | Lifetime of a UI session (`1m` to `30d`).                                                                                                                                                                                                 |
| `AFE_GITHUB_VERIFY_INSTALLER` | `false`         | no     | Hosted/multi-tenant: verify via OAuth that the user completing a GitHub App install can access the installation. Needs `AFE_GITHUB_APP_CLIENT_ID` and `AFE_GITHUB_APP_CLIENT_SECRET` (or `_FILE`). See [GitHub](../connectors/github.md). |

**Startup safety.** Without `AFE_ADMIN_TOKEN`, `afe server` and `afe all`
refuse to start unless `AFE_HOST` is a loopback address (`127.0.0.1`, `::1`,
`localhost`). On loopback (e.g. `pnpm dev` with `AFE_HOST=127.0.0.1`) they
generate a one-time admin token and print it once to stderr; it changes on
every restart. The docker-compose setup listens on `0.0.0.0` inside the
container and therefore always needs the token. `afe worker` does not need it.

Set `AFE_PUBLIC_URL` to the https address users open, so session cookies are
`Secure` and the CSRF Origin check compares against it. API clients send
`Authorization: Bearer <token>`.

## Event retention

Afe keeps events for a limited window and then deletes them, together with
their raw payloads ([ADR 0008](../decisions/0008-open-source-scope-without-audit-log.md),
[data inventory](../security/data-inventory.md#retention-and-deletion)).

| Variable                   | Default | Secret | Description                                                                                                                                                                                                                                                                     |
| -------------------------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFE_EVENT_RETENTION_DAYS` | `30`    | no     | How long events are kept, in whole days, measured from when they happened in the source (`occurredAt`). `1` to `60`. **60 days is the maximum of the open-source build**; a value outside 1..60 is a startup error (Afe refuses to start rather than keep less than you asked). |

- The `retention.purge` job runs hourly (on workers) and deletes expired
  events in small batches; after lowering the value, the next runs catch up.
- Events that are already older than the window when Afe sees them (e.g.
  from a backfill) are not stored.
- Connector history windows are clamped to the retention window, with a log
  line when a configured value is longer: `AFE_GITHUB_BACKFILL_DAYS`,
  `AFE_GITHUB_RECONCILE_LOOKBACK` and the Vercel first-connect backfill
  (30 days).
- Afe is not an audit log: there is no export, and history older than the
  window is gone. Back up the database if you need older data
  ([operations](operations.md#backups)).

## docker-compose.yml settings (`.env`)

Read by `docker compose` itself; see [`.env.example`](../../.env.example).

| Variable            | Default                | Secret | Description                                                                      |
| ------------------- | ---------------------- | ------ | -------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | (required)             | yes    | Password of the `afe` database user; also used to build `DATABASE_URL`.          |
| `AFE_VERSION`       | `latest`               | no     | Image tag. Pin a release (e.g. `0.1.0`); see [upgrades](operations.md#upgrades). |
| `AFE_IMAGE`         | `ghcr.io/theafeai/afe` | no     | Image repository, e.g. for a mirror.                                             |
| `AFE_HTTP_PORT`     | `8080`                 | no     | Host port, always bound to `127.0.0.1`.                                          |

All other variables in `.env` are passed into the Afe containers. The compose
file sets `DATABASE_URL`, `AFE_ENCRYPTION_KEY_FILE` and `AFE_ADMIN_TOKEN_FILE`
itself; do not set `AFE_ENCRYPTION_KEY` or `AFE_ADMIN_TOKEN` in `.env` as well.

## Pending settings

These are being built concurrently and will be documented here when they land:

| Area                                 | Expected settings                                                                                         | Issue  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------ |
| Public URL                           | The externally reachable base URL (webhook URLs, GitHub App manifest redirect)                            | AFE-6  |
| GitHub App connector                 | App ID, private key, webhook secret (stored encrypted in the database, not in env), GitHub Enterprise URL | AFE-6  |
| ArgoCD connector                     | Server URL, token (stored encrypted), per-connection CA bundle                                            | AFE-9  |
| Vercel connector                     | Token and webhook secret (stored encrypted), team id                                                      | AFE-11 |
| Connection health and reconciliation | Probe and reconciliation polling intervals                                                                | AFE-13 |

Connector credentials are, by design, stored encrypted in the database
([rules R2](../security/rules.md#r2--credentials)), not in environment
variables; you enter them once through Afe and they can be rotated without a
restart.

## Personal tool account linking

See [user management](../user-management.md) for admin-created users, default-deny
permissions, and personal account linking. These settings are separate from the
tenant's collection integrations:

| Variable                                  | Purpose                                          |
| ----------------------------------------- | ------------------------------------------------ |
| `AFE_USER_GITHUB_CLIENT_ID`               | GitHub personal OAuth client ID.                 |
| `AFE_USER_GITHUB_CLIENT_SECRET` / `_FILE` | GitHub personal OAuth client secret.             |
| `AFE_USER_VERCEL_CLIENT_ID`               | Dedicated Vercel personal integration client ID. |
| `AFE_USER_VERCEL_CLIENT_SECRET` / `_FILE` | Vercel personal integration secret.              |
| `AFE_USER_VERCEL_INTEGRATION_SLUG`        | Slug of the personal Vercel integration.         |

Both providers require `AFE_PUBLIC_URL` and Afe's encryption key. Register the
provider callback at `/api/profile/tools/<provider>/callback`. An unconfigured
provider has no sign-in button; personal Vercel/ArgoCD tokens remain available.

## Transactional email

Optional SMTP supports user invitations and credential-reset links. See
[SMTP and account emails](email.md) for settings, secret files, TLS, sender
verification and delivery troubleshooting. Email remains disabled unless
`AFE_SMTP_HOST` is configured.
