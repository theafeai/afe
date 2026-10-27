# Secrets for self-hosters

Afe has three kinds of secret:

| Secret                                                                                | Where it lives                                      | How you provide it                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Encryption key (`AFE_ENCRYPTION_KEY`)                                                 | Outside Afe: a file mounted into the container      | `AFE_ENCRYPTION_KEY_FILE` (Docker secret)   |
| Database password                                                                     | Outside Afe: `.env` / your secret store             | `POSTGRES_PASSWORD`, or `DATABASE_URL_FILE` |
| Connector credentials (GitHub App private key, ArgoCD/Vercel tokens, webhook secrets) | Inside Afe's database, encrypted with the key above | Entered through Afe (pending AFE-6/9/11)    |

The design is in [key management](../security/key-management.md) (binding);
this page is the operator's view.

## The encryption key

Every stored credential is encrypted with its own data key (AES-256-GCM), which
is wrapped by the encryption key. The key never touches the database.

Generate it:

```sh
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/afe_encryption_key
chmod 644 secrets/afe_encryption_key
```

docker-compose.yml mounts `secrets/afe_encryption_key` at
`/run/secrets/afe_encryption_key` and sets `AFE_ENCRYPTION_KEY_FILE` to it.
The container runs as uid 1000, so the file must be readable by it; the
`700` directory keeps other host users out. On Kubernetes, mount a `Secret` as a
file and set `AFE_ENCRYPTION_KEY_FILE`.

Prefer the `_FILE` variant to `AFE_ENCRYPTION_KEY`: environment variables show
up in `docker inspect`, process listings and crash dumps.

**Back the key up separately from database backups.** If the key is lost, every
connector credential must be re-entered (stored events are not
encrypted and are unaffected). If a database backup and the key are stolen
together, every credential is exposed.

## Rotating the encryption key

Rotate on a schedule or whenever the key may have been exposed. With
docker compose:

1. Generate a new key and put **both** keys in the secret file, as `id:key`
   lines. A single bare key has the id `default`:

   ```sh
   old=$(cat secrets/afe_encryption_key)
   new=$(openssl rand -base64 32)
   printf 'default:%s\n2027-04:%s\n' "$old" "$new" > secrets/afe_encryption_key
   ```

2. Make the new key active: add `AFE_ENCRYPTION_ACTIVE_KEY_ID=2027-04` to
   `.env`, then `docker compose up -d`. New credentials use the new key;
   existing ones still decrypt with the old key.
3. Re-encrypt existing credentials (safe while Afe runs, safe to re-run):

   ```sh
   docker compose exec afe-server afe reencrypt-credentials
   ```

   If it stops with `DecryptionError`, that credential is corrupt or was
   tampered with: revoke and re-enter it, then run the command again.

4. Check nothing is left under the old key:

   ```sh
   docker compose exec postgres psql -U afe -d afe -c \
     "SELECT key_id, count(*) FROM credentials WHERE revoked_at IS NULL GROUP BY key_id"
   ```

5. Remove the old line from the secret file and `docker compose up -d` again.

If the old key was exposed **together with** a copy of the database, also
rotate the upstream credentials (new GitHub App private key and webhook secret,
new ArgoCD and Vercel tokens): re-wrapping does not help against someone who
already has both.

## Database password

The compose file builds `DATABASE_URL` from `POSTGRES_PASSWORD`. The database
is only reachable on the compose network. If you run your own PostgreSQL, put
the full URL in a file and set `DATABASE_URL_FILE` instead of `DATABASE_URL`.

To change the bundled database password:
`docker compose exec postgres psql -U afe -d afe -c "ALTER USER afe PASSWORD '<new>'"`,
update `POSTGRES_PASSWORD` in `.env`, then `docker compose up -d`.
(`POSTGRES_PASSWORD` only initialises a new data volume; changing it alone does
not change the password.)

## Connector credentials

Never put connector tokens in `.env`. They are stored only through Afe's
encrypted credentials store, are write-only (never shown again), and can be
rotated or revoked; see each [credentials guide](README.md). Webhook secrets
should be 32 random bytes: `openssl rand -hex 32`.
