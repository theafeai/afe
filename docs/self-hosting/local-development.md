# Run Afe locally from a checkout

Install Git, Python 3 and Docker with Compose v2 (`--wait` support, v2.20+).
Start Docker Desktop/Engine. Use macOS, Linux or WSL2 on Windows.
Node, pnpm, OpenSSL and a separate PostgreSQL installation are not needed for
this workflow. OpenSSL is needed only by the optional GitHub App helper.

From your Afe checkout:

```sh
sh examples/start-local-afe.sh
sh examples/start-local-afe.sh password
```

Open <http://localhost:8080> and paste the password into the login screen. The
first build can take several minutes. Later builds use Docker's dependency cache.
The helper waits for PostgreSQL and the server healthcheck before reporting ready;
the background worker runs alongside them.

## Daily commands

Run these from the checkout; the script also works by absolute path from another
directory. All commands use the same Compose project, `afe-demo-local`.

| Command                                         | Result                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `sh examples/start-local-afe.sh`                | Build current source and start/recreate services; wait for readiness               |
| `sh examples/start-local-afe.sh setup`          | Create missing first-run settings without starting Docker; reuse an existing setup |
| `sh examples/start-local-afe.sh password`       | Show the saved login password in your terminal                                     |
| `sh examples/start-local-afe.sh password --set` | Privately prompt for your own stable password; run the startup command afterward   |
| `sh examples/start-local-afe.sh status`         | Show service status and the published port                                         |
| `sh examples/start-local-afe.sh logs`           | Follow the last 100 server/worker log lines; Ctrl+C exits the log viewer           |
| `sh examples/start-local-afe.sh stop`           | Stop services and keep containers and data                                         |
| `sh examples/start-local-afe.sh down`           | Remove containers/network and keep the database and secret files                   |

The password is generated **once per checkout**, saved in
`secrets/afe_admin_token`, and reused on every restart and image rebuild. You can
choose your own with `password --set`. Afe's existing token policy requires
32–1024 characters with no whitespace; use a long phrase with hyphens. Password
entry and confirmation are hidden. Changing it ends existing sessions after the
services restart. Keep it private; do not commit it or paste it into chat.

## Settings and connections survive rebuilds

The helper creates `.env` from `.env.example`, a random database password, an
encryption key and a login token on first run. It never replaces existing setup
files during startup. Edit `.env` for settings such as `AFE_HTTP_PORT=8081`, then
run the startup command again. The local Compose override always builds
`afe-demo-local:demo` from this checkout; `AFE_IMAGE` and `AFE_VERSION` apply to
the published-image workflow, not this helper.

Docker's `.dockerignore` excludes `.env` and `secrets/` from the build context.
**Leave them in place when building.** Runtime Compose mounts the secrets
separately. PostgreSQL stores connections, users and events in the named volume
`afe-demo-local_afe-pgdata`. Preserve both that volume and its encryption key:
a database alone cannot recover encrypted connector credentials. Back up `.env`
and `secrets/` privately along with the database; see [operations](operations.md).

Existing users of `examples/start-local-afe.sh` can rerun it directly. It uses
the original project, image name and volume, preserving their password and
connections. If you previously used plain `docker compose` (project `afe`), keep
using that project: stop the old services, then run
`docker compose -p afe -f docker-compose.yml -f docker-compose.local.yml up -d --build --wait`.
Include your existing connector overrides too. Switching project names creates
a separate database and can cause a port conflict; it does not migrate data.

The [GitHub helper](../../examples/local-github.md) is optional. After it adds
GitHub secret file references to `.env`, the startup helper automatically includes
`examples/local-github-compose.yml` for rebuilds, logs, stop and down.

## Troubleshooting and cleanup

- **Docker unavailable:** start Docker Desktop/Engine and retry. Setup files are
  retained if a build or startup fails; fix the error and rerun the same command.
- **Port 8080 in use:** set `AFE_HTTP_PORT` in `.env`, rerun, then use that port in
  your browser. Update `AFE_PUBLIC_URL` and provider callbacks if configured.
- **Missing/empty `.env` or secret in an existing setup:** restore it from backup.
  The helper refuses to invent replacement credentials for an existing database.
  Losing the encryption key makes stored connector credentials unrecoverable.
- **Login after a rebuild:** use `password` to retrieve the same saved value.
  Normal session expiry still applies. Do not regenerate the encryption key to
  fix login.
- **Database authentication failure:** keep the original `POSTGRES_PASSWORD`.
  Editing `.env` does not change a password in an existing PostgreSQL volume;
  use the [password rotation procedure](secrets.md#database-password).

For a deliberate fresh database, stop this stack, then remove only its volume:

```sh
sh examples/start-local-afe.sh down
docker volume rm afe-demo-local_afe-pgdata
sh examples/start-local-afe.sh
```

This deletes local users, connections and events. The helper keeps `.env` and
secrets, so your login password remains the same. For ordinary testing use
`stop` or `down` without deleting the volume. Images and build cache can be
removed independently of settings and database state.
