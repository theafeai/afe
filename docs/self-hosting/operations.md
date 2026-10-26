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

Everything Afe stores is in PostgreSQL: the audit log, raw payloads,
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

### Why the audit log's hash chain survives a backup and restore

Each event's hash is SHA-256 over its canonical content (RFC 8785 JSON),
including its per-tenant sequence number and the previous event's hash
([ADR 0003](../decisions/0003-event-model-and-audit-log.md)). Nothing physical
(row ids, OIDs, page layout, insertion time of the restored row) is hashed, so
a logical dump and restore reproduces exactly the same chain.
`pg_dump` creates the append-only triggers after loading the data, so the
restore is not blocked by them, and the chain-link check is in place again
afterwards. Chain verification after a restore reports the same head hash
(sequence number and hash of the last event) as before; compare it with a head
you recorded or exported earlier to prove the restored log is complete.

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
  still report (marked as discovered by reconciliation); anything older than the
  sources' history is lost. Restoring is therefore not a way to hide events:
  the restored chain head differs from heads recorded or exported later.

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
