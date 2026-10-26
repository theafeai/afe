import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptionContext, KeyProvider } from "./keys.ts";
import { Secret, revealIfSecret } from "./secret.ts";

export const DATA_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

/**
 * An encrypted credential, envelope style:
 * - a fresh random 256-bit data key encrypts the value with AES-256-GCM;
 * - the data key is wrapped by the `KeyProvider` under `keyId` (a key-encryption
 *   key from env/file in self-host, a KMS key in the hosted service).
 * Both layers authenticate the same encryption context, which binds the
 * ciphertext to its tenant and credential id.
 */
export interface EncryptedSecret {
  keyId: string;
  /** Data key wrapped by the key provider. */
  wrappedKey: Buffer;
  /** 96-bit GCM nonce for the value encryption. */
  nonce: Buffer;
  /** AES-256-GCM ciphertext followed by the 16-byte auth tag. */
  ciphertext: Buffer;
}

/** Identifies what a ciphertext belongs to. Bound into the AAD. */
export interface SecretBinding {
  tenantId: string;
  credentialId: string;
}

/** Thrown for any decryption failure. Deliberately carries no detail. */
export class DecryptionError extends Error {
  constructor() {
    super("credential could not be decrypted");
    this.name = "DecryptionError";
  }
}

/** The ciphertext names a key id the provider does not hold. */
export class UnknownKeyError extends Error {
  constructor(keyId: string) {
    super(`unknown encryption key id: ${keyId}`);
    this.name = "UnknownKeyError";
  }
}

const CONTEXT_PURPOSE = "afe.credential.v1";

/** The encryption context (AAD) for a credential. */
export function encryptionContext(binding: SecretBinding): EncryptionContext {
  if (!binding.tenantId || !binding.credentialId) {
    throw new Error("tenantId and credentialId are required to encrypt or decrypt a secret");
  }
  return {
    purpose: CONTEXT_PURPOSE,
    tenantId: binding.tenantId,
    credentialId: binding.credentialId,
  };
}

/** Canonical, unambiguous byte encoding of an encryption context (sorted keys). */
export function serializeContext(context: EncryptionContext): Buffer {
  const entries = Object.keys(context)
    .sort()
    .map((k) => [k, context[k]]);
  return Buffer.from(JSON.stringify(entries), "utf8");
}

/**
 * Encrypts `value` for the given tenant/credential. Uses the provider's active
 * key unless `keyId` is given (used by key rotation).
 */
export async function encryptSecret(
  keys: KeyProvider,
  value: string | Secret<string>,
  binding: SecretBinding,
  keyId: string = keys.activeKeyId(),
): Promise<EncryptedSecret> {
  const context = encryptionContext(binding);
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(serializeContext(context));
    const ciphertext = Buffer.concat([
      cipher.update(revealIfSecret(value), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const wrappedKey = Buffer.from(await keys.wrapKey(keyId, dataKey, context));
    return { keyId, wrappedKey, nonce, ciphertext };
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Decrypts a credential. Fails with `DecryptionError` if anything was altered or
 * if the binding (tenant id, credential id) differs from the one used to encrypt,
 * and with `UnknownKeyError` if the provider does not hold `encrypted.keyId`.
 */
export async function decryptSecret(
  keys: KeyProvider,
  encrypted: EncryptedSecret,
  binding: SecretBinding,
): Promise<Secret<string>> {
  const context = encryptionContext(binding);
  let dataKey: Buffer | undefined;
  try {
    if (!keys.hasKey(encrypted.keyId)) throw new UnknownKeyError(encrypted.keyId);
    dataKey = Buffer.from(await keys.unwrapKey(encrypted.keyId, encrypted.wrappedKey, context));
    if (
      dataKey.length !== DATA_KEY_BYTES ||
      encrypted.nonce.length !== NONCE_BYTES ||
      encrypted.ciphertext.length < TAG_BYTES
    ) {
      throw new DecryptionError();
    }
    const split = encrypted.ciphertext.length - TAG_BYTES;
    const decipher = createDecipheriv("aes-256-gcm", dataKey, encrypted.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(serializeContext(context));
    decipher.setAuthTag(encrypted.ciphertext.subarray(split));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.ciphertext.subarray(0, split)),
      decipher.final(),
    ]);
    const secret = new Secret(plaintext.toString("utf8"));
    plaintext.fill(0);
    return secret;
  } catch (err) {
    if (err instanceof UnknownKeyError) throw err;
    throw new DecryptionError();
  } finally {
    dataKey?.fill(0);
  }
}
