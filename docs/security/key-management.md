# Key management

- Status: Accepted (AFE-5)
- Code: `packages/core/src/security/{keys,crypto}.ts`,
  `packages/db/src/credentials.ts`, migration `0003`.

## Design: envelope encryption

Every credential is encrypted with its own random 256-bit **data key** using
AES-256-GCM. The data key is then **wrapped** (encrypted) by a
**key-encryption key (KEK)** held by a `KeyProvider`. A row in `credentials`
stores:

| Column        | Content                                           |
| ------------- | ------------------------------------------------- |
| `key_id`      | id of the KEK that wrapped the data key           |
| `wrapped_key` | the wrapped data key                              |
| `nonce`       | 96-bit random GCM nonce for the value             |
| `ciphertext`  | AES-256-GCM ciphertext of the value + 16-byte tag |

Both layers authenticate the same **encryption context** as associated data:
`{ purpose: "afe.credential.v1", tenantId, credentialId }`. Consequences:

- modifying any byte of any column makes decryption fail (`DecryptionError`);
- copying a ciphertext (or just its wrapped key) to another tenant or another
  credential id makes decryption fail, so tenants cannot be cross-wired even by
  a bug or a malicious SQL edit;
- the KEK never touches credential plaintext, which is what lets the hosted
  version keep KEKs inside a KMS.

There is no plaintext column. Revocation sets the key material columns to
`NULL` (enforced by a check constraint), which destroys the credential.

## The `KeyProvider` extension point

```ts
interface KeyProvider {
  activeKeyId(): string;
  hasKey(keyId: string): boolean;
  wrapKey(keyId, dataKey, context): Promise<Uint8Array>;
  unwrapKey(keyId, wrapped, context): Promise<Uint8Array>;
}
```

`context` is a string map, so it maps directly onto a cloud KMS "encryption
context" / "additional authenticated data". Implementations must fail
`unwrapKey` if the context differs from the one used to wrap, and must never log
key material.

## Self-host: `EnvKeyProvider`

Configured from the environment:

| Variable                       | Meaning                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `AFE_ENCRYPTION_KEY`           | One bare key, or a comma/newline-separated list of `id:key` entries.                          |
| `AFE_ENCRYPTION_KEY_FILE`      | Path to a file with the same content (Docker/Kubernetes secret). Use instead of the variable. |
| `AFE_ENCRYPTION_ACTIVE_KEY_ID` | Optional. Key used for new encryptions; defaults to the first key in the list.                |

Keys are 32 random bytes, base64 or hex encoded. A bare key gets the id
`default`. Key ids are `[A-Za-z0-9._-]{1,64}`, for example the date you created
the key (`2026-10`).

```sh
# generate a key
openssl rand -base64 32
# single key
AFE_ENCRYPTION_KEY=q0f...=
# or, prepared for rotation
AFE_ENCRYPTION_KEY="2026-10:q0f...=,2027-04:Zx1...="
AFE_ENCRYPTION_ACTIVE_KEY_ID=2027-04
```

Guidance:

- Prefer `AFE_ENCRYPTION_KEY_FILE` with a mounted secret over an inline
  variable (env vars leak into process listings, crash dumps and `docker inspect`).
- **Back the key up separately from database backups.** Losing it means every
  stored credential must be re-entered; storing it with the DB backup means a
  stolen backup reveals every credential.
- Setting both `AFE_ENCRYPTION_KEY` and `AFE_ENCRYPTION_KEY_FILE` is an error;
  so is a missing key. Error messages never contain key material.
- Wrapping is AES-256-GCM under the KEK, with the KEK id added to the
  authenticated context.

### Rotation procedure (self-host)

Rotating the KEK (scheduled, or when the key may have been exposed):

1. Generate a new key: `openssl rand -base64 32`.
2. Add it to the list **and make it active**, keeping the old key:
   `AFE_ENCRYPTION_KEY="old:…,new:…"`, `AFE_ENCRYPTION_ACTIVE_KEY_ID=new`.
   Restart Afe. New and rotated credentials now use `new`; existing ones still
   decrypt with `old`.
3. Re-encrypt existing credentials under the new key, with the same
   environment as the server:
   `afe reencrypt-credentials`. This runs `reencryptAllTenants` (i.e.
   `reencryptAll(pool, keys, tenantId, activeKeyId)` for every tenant returned
   by `tenantsWithCredentialsNotUnderKey`). It processes one credential per
   short transaction, so it is safe while Afe is running and safe to re-run.
   If a credential fails to decrypt (tampered or corrupt), the command stops
   with `DecryptionError` rather than skipping it; revoke and re-enter that
   credential, then run the command again.
4. Confirm `tenantsWithCredentialsNotUnderKey(db, "new")` is empty.
5. Remove the old key from the list and restart. Any credential still under the
   old key would now fail with `UnknownKeyError`, so step 4 matters.

If a KEK was exposed together with a database copy, also rotate the upstream
credentials themselves (new GitHub App private key, new ArgoCD token, new
Vercel token, new webhook secrets) and store them with `rotateCredential`;
re-wrapping alone does not help against an attacker who already has both.

Rotating an individual credential (e.g. a Vercel token) is independent of KEK
rotation: `rotateCredential` replaces the value, keeps the id, and sets
`rotated_at`.

## Hosted: KMS envelope encryption

The hosted service supplies its own `KeyProvider` through `createAfe(...)`:

- `activeKeyId()` returns the KMS key ARN/resource name (or an alias resolved
  to a versioned key id), so `key_id` records exactly which KMS key wrapped
  each data key.
- `wrapKey` calls KMS `Encrypt` on the 32-byte data key with `context` as the
  encryption context; `unwrapKey` calls `Decrypt` with the same context. KEK
  material never leaves the KMS, every unwrap is in the KMS audit log, and the
  context (tenant id, credential id) appears there too.
- Optionally one KMS key per tenant (or per tenant tier) so a tenant's
  credentials can be crypto-shredded by disabling its key on account deletion.
- KMS automatic key rotation keeps old versions available for decrypt; a
  migration to a different KMS key uses the same `reencryptAll` procedure.
- IAM: the application role may `Encrypt`/`Decrypt` only with this context
  shape; nobody has `Decrypt` outside the service role except break-glass.
- Caching unwrapped data keys in memory is allowed for a short time (minutes)
  and per credential, to bound KMS calls.

## What is not covered here

- Webhook secrets and API tokens are both "credentials" and use this scheme.
- The Afe admin token and database password are deployment configuration, not
  stored in Afe's database; manage them with the platform's secret store.
- Events are not encrypted or hash-chained; they are kept only for the
  retention window (see the threat model and the data inventory).
