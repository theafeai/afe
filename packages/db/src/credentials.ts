import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  type EncryptedSecret,
  type KeyProvider,
  type Secret,
  decryptSecret,
  encryptSecret,
} from "@afe/core/security";

type Db = pg.Pool | pg.PoolClient;

/** Credential metadata. Never contains the secret or its ciphertext. */
export interface CredentialMetadata {
  tenantId: string;
  id: string;
  kind: string;
  keyId: string | null;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface StoredCredential extends CredentialMetadata {
  secret: Secret<string>;
}

interface CredentialRow {
  tenant_id: string;
  id: string;
  kind: string;
  key_id: string | null;
  wrapped_key: Buffer | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  created_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

const METADATA_COLUMNS = "tenant_id, id, kind, key_id, created_at, rotated_at, revoked_at";

function toMetadata(row: CredentialRow): CredentialMetadata {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    kind: row.kind,
    keyId: row.key_id,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

function toEncrypted(row: CredentialRow): EncryptedSecret {
  if (!row.key_id || !row.wrapped_key || !row.nonce || !row.ciphertext) {
    throw new Error("credential has no key material");
  }
  return {
    keyId: row.key_id,
    wrappedKey: row.wrapped_key,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
  };
}

export interface StoreCredentialInput {
  kind: string;
  secret: string | Secret<string>;
  /** Optional caller-chosen id (uuid); generated if omitted. */
  id?: string;
}

/** Encrypts and stores a new credential for `tenantId`. */
export async function storeCredential(
  db: Db,
  keys: KeyProvider,
  tenantId: string,
  input: StoreCredentialInput,
): Promise<CredentialMetadata> {
  const id = input.id ?? randomUUID();
  const enc = await encryptSecret(keys, input.secret, { tenantId, credentialId: id });
  const { rows } = await db.query<CredentialRow>(
    `INSERT INTO credentials (tenant_id, id, kind, key_id, wrapped_key, nonce, ciphertext)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${METADATA_COLUMNS}`,
    [tenantId, id, input.kind, enc.keyId, enc.wrappedKey, enc.nonce, enc.ciphertext],
  );
  return toMetadata(rows[0]!);
}

/** Returns credential metadata (including revoked ones), or null. Never decrypts. */
export async function getCredentialMetadata(
  db: Db,
  tenantId: string,
  id: string,
): Promise<CredentialMetadata | null> {
  const { rows } = await db.query<CredentialRow>(
    `SELECT ${METADATA_COLUMNS} FROM credentials WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] ? toMetadata(rows[0]) : null;
}

/**
 * Loads and decrypts a credential. Returns null if it does not exist in this
 * tenant or has been revoked. Throws `DecryptionError` if the stored value was
 * tampered with, and `UnknownKeyError` if its key is no longer configured.
 */
export async function getCredential(
  db: Db,
  keys: KeyProvider,
  tenantId: string,
  id: string,
): Promise<StoredCredential | null> {
  const { rows } = await db.query<CredentialRow>(
    `SELECT * FROM credentials WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [tenantId, id],
  );
  const row = rows[0];
  if (!row) return null;
  const secret = await decryptSecret(keys, toEncrypted(row), { tenantId, credentialId: id });
  return { ...toMetadata(row), secret };
}

/**
 * Replaces the secret value of an active credential (e.g. a rotated API token),
 * keeping its id so connections referencing it keep working. Returns null if the
 * credential does not exist in this tenant or is revoked.
 */
export async function rotateCredential(
  db: Db,
  keys: KeyProvider,
  tenantId: string,
  id: string,
  secret: string | Secret<string>,
): Promise<CredentialMetadata | null> {
  const enc = await encryptSecret(keys, secret, { tenantId, credentialId: id });
  const { rows } = await db.query<CredentialRow>(
    `UPDATE credentials
        SET key_id = $3, wrapped_key = $4, nonce = $5, ciphertext = $6, rotated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
      RETURNING ${METADATA_COLUMNS}`,
    [tenantId, id, enc.keyId, enc.wrappedKey, enc.nonce, enc.ciphertext],
  );
  return rows[0] ? toMetadata(rows[0]) : null;
}

/**
 * Revokes a credential: marks it revoked and destroys its key material, so it
 * can never be decrypted again. The metadata row is kept for the audit trail.
 * Returns false if there was no active credential with this id in this tenant.
 */
export async function revokeCredential(db: Db, tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE credentials
        SET revoked_at = now(), key_id = NULL, wrapped_key = NULL, nonce = NULL, ciphertext = NULL
      WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [tenantId, id],
  );
  return rowCount === 1;
}

/** Lists credential metadata for a tenant (never secrets). */
export async function listCredentials(
  db: Db,
  tenantId: string,
  options: { includeRevoked?: boolean } = {},
): Promise<CredentialMetadata[]> {
  const { rows } = await db.query<CredentialRow>(
    `SELECT ${METADATA_COLUMNS} FROM credentials
      WHERE tenant_id = $1 ${options.includeRevoked ? "" : "AND revoked_at IS NULL"}
      ORDER BY created_at, id`,
    [tenantId],
  );
  return rows.map(toMetadata);
}

/**
 * Key rotation: re-encrypts every active credential of `tenantId` that is not
 * yet under `newKeyId` (which `keys` must hold, alongside the old keys). Each
 * credential is re-encrypted in its own short transaction with a row lock, so
 * the operation is safe to run while Afe is serving and safe to re-run after an
 * interruption. Returns the number of credentials re-encrypted.
 * `rotated_at` is not changed: the secret value itself did not change.
 */
export async function reencryptAll(
  pool: pg.Pool,
  keys: KeyProvider,
  tenantId: string,
  newKeyId: string = keys.activeKeyId(),
): Promise<number> {
  if (!keys.hasKey(newKeyId)) throw new Error(`key provider does not hold key ${newKeyId}`);
  const { rows: pending } = await pool.query<{ id: string }>(
    `SELECT id FROM credentials
      WHERE tenant_id = $1 AND revoked_at IS NULL AND key_id <> $2
      ORDER BY id`,
    [tenantId, newKeyId],
  );
  let count = 0;
  for (const { id } of pending) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<CredentialRow>(
        `SELECT * FROM credentials
          WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL AND key_id <> $3
          FOR UPDATE`,
        [tenantId, id, newKeyId],
      );
      const row = rows[0];
      if (row) {
        const binding = { tenantId, credentialId: id };
        const secret = await decryptSecret(keys, toEncrypted(row), binding);
        const enc = await encryptSecret(keys, secret, binding, newKeyId);
        await client.query(
          `UPDATE credentials SET key_id = $3, wrapped_key = $4, nonce = $5, ciphertext = $6
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id, enc.keyId, enc.wrappedKey, enc.nonce, enc.ciphertext],
        );
        count++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return count;
}

/**
 * Lists tenants that still have active credentials under a key other than
 * `keyId`. Used by the key-rotation procedure to drive `reencryptAll` across
 * all tenants and to confirm an old key can be removed.
 */
export async function tenantsWithCredentialsNotUnderKey(db: Db, keyId: string): Promise<string[]> {
  const { rows } = await db.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM credentials
      WHERE revoked_at IS NULL AND key_id <> $1 ORDER BY tenant_id`,
    [keyId],
  );
  return rows.map((r) => r.tenant_id);
}

/**
 * Operator maintenance for key rotation: runs `reencryptAll` for every tenant
 * that still has credentials under another key. Returns the number of
 * credentials re-encrypted per tenant.
 */
export async function reencryptAllTenants(
  pool: pg.Pool,
  keys: KeyProvider,
  newKeyId: string = keys.activeKeyId(),
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const tenantId of await tenantsWithCredentialsNotUnderKey(pool, newKeyId)) {
    result[tenantId] = await reencryptAll(pool, keys, tenantId, newKeyId);
  }
  return result;
}
