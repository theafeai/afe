# Operations: health, backups, upgrades

Commands assume the [docker compose quickstart](quickstart.md) layout; adapt
service names for other setups.

## Health check

`GET /healthz` on the server (port 8080 in the container):

| Response                       | Meaning                                  |
| ------------------------------ | ---------------------------------------- |
| `200 {"status":"ok"}`          | The server is up and PostgreSQL answers. |
| `503 {"status":"unavailable"}` | The database is unreachable.             |

- The image declares a Docker `HEALTHCHECK` against it (every 30 s), so
  `docker compose ps` shows `healthy`. Use it for load balancer and Kubernetes
  liveness/readiness probes too.
- `/healthz` is unauthenticated and reveals nothing else; it does not need to
  be exposed outside your network.
- `afe-worker` serves no HTTP; its health check is disabled in compose. Watch
  `docker compose ps` (restarts) and its logs.
- Health of each connection to GitHub, ArgoCD and Vercel (reachability,
  credentials, observation gaps) is **to be finalised when AFE-13 (connection
  health) lands**.

## Backups

Everything Afe stores is in PostgreSQL: events, raw payloads,
configuration, encrypted credentials and the job queue. The encryption key is
**not** in the database; back it up separately (see [secrets](secrets.md)).

Daily logical backup (custom format, compressed):

```sh
docker compose exec -T postgres pg_dump -U afe -d afe -Fc > afe-$(date +%F).dump
```

- Run it from cron or a systemd timer and copy the file off the host.
- `pg_dump` takes a consistent snapshot; Afe can keep running.
- For point-in-time recovery or very large installs, use PostgreSQL WAL
  archiving (e.g. pgBackRest, WAL-G) or your managed database's backups instead.
- Test restores regularly (below).
- Events in the database cover only the retention window
  (`AFE_EVENT_RETENTION_DAYS`, default 30 days). A backup keeps the events as
  of the day it was taken, so backups are also how you keep older data if you
  need it; size backup retention with that (and your privacy obligations) in
  mind.

## Restore

```sh
docker compose stop afe-server afe-worker
docker compose exec -T postgres dropdb -U afe afe
docker compose exec -T postgres createdb -U afe afe
docker compose exec -T postgres pg_restore -U afe -d afe --no-owner --exit-on-error < afe-2026-10-26.dump
docker compose start afe-server afe-worker
curl -s http://127.0.0.1:8080/healthz
```

- Use the same encryption key file as when the backup was taken (or a key list
  that contains its key id); otherwise stored credentials cannot be decrypted.
- Restore with the same Afe version as the backup, or a newer one (migrations
  run forward on start). Never restore into an older version.
- After restoring an older backup, events between the backup and the restore are
  not in the database. Reconciliation polling re-discovers what the sources
  still report (marked as discovered by reconciliation) inside the retention
  window; anything older than the sources' history is lost.
- Events in the backup that are older than the retention window are deleted by
  the next `retention.purge` run after the restore.

## Upgrades

Afe follows semantic versioning. Database migrations are **forward-only** SQL
files and run automatically when `afe server`, `afe worker` or `afe all`
starts (serialised by a database lock, so several containers can start at
once).

1. Read the release notes for the target version.
2. **Take a backup** (above). There is no down-migration: the backup is the
   rollback path.
3. Set the new version in `.env`: `AFE_VERSION=0.2.0`.
4. `docker compose pull && docker compose up -d --wait`.
5. Check `curl -s http://127.0.0.1:8080/healthz` and `docker compose logs`.

To run migrations as a separate step (e.g. in a deployment pipeline):
`docker compose run --rm afe-server migrate`.

Upgrading to the release with migration `0021_remove_audit_chain.sql`
([ADR 0008](../decisions/0008-open-source-scope-without-audit-log.md)): the
hash-chain columns, chain heads and anchor tables are dropped, and within an
hour the first `retention.purge` run deletes every event older than
`AFE_EVENT_RETENTION_DAYS` (default 30). Take a backup first if you want to keep
the older history.

Rolling back: stop Afe, restore the pre-upgrade backup, set the previous
`AFE_VERSION`, start. Events recorded after the backup are re-discovered by
reconciliation where the sources still have them.

### Version pinning

- Pin an exact version (`0.2.0`) in production. `0.2` follows patch releases;
  `latest` follows every release and is only for trying Afe out.
- For a fully reproducible deployment, pin the digest:
  `AFE_VERSION=0.2.0@sha256:<digest>` (shown by `docker compose images` or the
  release page). Verify provenance with
  `gh attestation verify oci://ghcr.io/theafeai/afe:0.2.0 --owner theafeai`.
- PostgreSQL: the compose file uses `postgres:16`. Minor updates
  (`docker compose pull postgres`) are safe. A major upgrade (e.g. to 17) needs a
  dump and restore into a new volume; Afe supports PostgreSQL 16 and later.

## Logs

JSON on stdout (`docker compose logs`). Credentials, tokens, authorization
headers and webhook signatures are redacted. Set `AFE_LOG_LEVEL=debug` to
troubleshoot; the redaction applies at every level.
