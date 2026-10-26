import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DecryptionError, UnknownKeyError, serializeContext } from "./crypto.ts";

/**
 * Non-secret key/value pairs bound to a wrapped key as additional authenticated
 * data. Maps directly onto a cloud KMS "encryption context".
 */
export type EncryptionContext = Readonly<Record<string, string>>;

/**
 * Extension point (ADR 0002): who holds the key-encryption keys (KEKs).
 *
 * - OSS default: `EnvKeyProvider` (keys from `AFE_ENCRYPTION_KEY` or
 *   `AFE_ENCRYPTION_KEY_FILE`), wrapping data keys locally with AES-256-GCM.
 * - Hosted: a KMS-backed provider whose `wrapKey`/`unwrapKey` call the KMS
 *   Encrypt/Decrypt APIs with `context` as the encryption context, so key
 *   material never leaves the KMS.
 *
 * Implementations must fail `unwrapKey` when `context` differs from the one
 * used at wrap time, and must never log key material or data keys.
 */
export interface KeyProvider {
  /** Key id used for new encryptions. */
  activeKeyId(): string;
  /** Whether this provider can unwrap data keys wrapped under `keyId`. */
  hasKey(keyId: string): boolean;
  wrapKey(keyId: string, dataKey: Uint8Array, context: EncryptionContext): Promise<Uint8Array>;
  unwrapKey(keyId: string, wrapped: Uint8Array, context: EncryptionContext): Promise<Uint8Array>;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Key id used when AFE_ENCRYPTION_KEY holds a single bare key. */
export const DEFAULT_KEY_ID = "default";

export interface EnvKeyProviderOptions {
  /** Key id -> 32-byte key. Insertion order matters only for the default active key. */
  keys: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>;
  /** Key used for new encryptions. Defaults to the first key. */
  activeKeyId?: string;
}

/**
 * Self-host key provider. Holds one or more 256-bit key-encryption keys, each
 * with an id; exactly one is active for new encryptions. Older keys stay
 * available for decryption until every credential has been re-encrypted
 * (see docs/security/key-management.md).
 */
export class EnvKeyProvider implements KeyProvider {
  readonly #keys = new Map<string, Buffer>();
  readonly #active: string;

  constructor(options: EnvKeyProviderOptions) {
    const entries: [string, Uint8Array][] =
      options.keys instanceof Map
        ? [...(options.keys as ReadonlyMap<string, Uint8Array>).entries()]
        : Object.entries(options.keys as Record<string, Uint8Array>);
    if (entries.length === 0) throw new Error("at least one encryption key is required");
    for (const [id, key] of entries) {
      if (!KEY_ID_PATTERN.test(id)) throw new Error(`invalid encryption key id: ${id}`);
      if (key.length !== KEY_BYTES) {
        throw new Error(`encryption key ${id} must be ${KEY_BYTES} bytes`);
      }
      this.#keys.set(id, Buffer.from(key));
    }
    const active = options.activeKeyId ?? entries[0]![0];
    if (!this.#keys.has(active)) throw new Error(`active encryption key id not found: ${active}`);
    this.#active = active;
  }

  /**
   * Reads keys from the environment:
   * - `AFE_ENCRYPTION_KEY`, or `AFE_ENCRYPTION_KEY_FILE` (path to a file with the
   *   same content, e.g. a Docker/Kubernetes secret). The content is either one
   *   bare key (id `default`), or a comma/newline-separated list of `id:key`.
   *   Keys are 32 bytes, base64 or hex encoded.
   * - `AFE_ENCRYPTION_ACTIVE_KEY_ID` (optional): active key; defaults to the first.
   */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
  ): EnvKeyProvider {
    const inline = env.AFE_ENCRYPTION_KEY;
    const file = env.AFE_ENCRYPTION_KEY_FILE;
    if (inline && file) {
      throw new Error("set only one of AFE_ENCRYPTION_KEY and AFE_ENCRYPTION_KEY_FILE");
    }
    const raw = inline || (file ? readFile(file) : undefined);
    if (!raw || !raw.trim()) {
      throw new Error(
        "AFE_ENCRYPTION_KEY or AFE_ENCRYPTION_KEY_FILE is required; generate a key with `openssl rand -base64 32`",
      );
    }
    return new EnvKeyProvider({
      keys: parseKeyList(raw),
      activeKeyId: env.AFE_ENCRYPTION_ACTIVE_KEY_ID || undefined,
    });
  }

  activeKeyId(): string {
    return this.#active;
  }

  hasKey(keyId: string): boolean {
    return this.#keys.has(keyId);
  }

  keyIds(): string[] {
    return [...this.#keys.keys()];
  }

  async wrapKey(
    keyId: string,
    dataKey: Uint8Array,
    context: EncryptionContext,
  ): Promise<Uint8Array> {
    const kek = this.#key(keyId);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", kek, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(wrapAad(keyId, context));
    return Buffer.concat([nonce, cipher.update(dataKey), cipher.final(), cipher.getAuthTag()]);
  }

  async unwrapKey(
    keyId: string,
    wrapped: Uint8Array,
    context: EncryptionContext,
  ): Promise<Uint8Array> {
    const kek = this.#key(keyId);
    const buf = Buffer.from(wrapped);
    if (buf.length < NONCE_BYTES + TAG_BYTES) throw new DecryptionError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", kek, buf.subarray(0, NONCE_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(wrapAad(keyId, context));
      decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new DecryptionError();
    }
  }

  #key(keyId: string): Buffer {
    const key = this.#keys.get(keyId);
    if (!key) throw new UnknownKeyError(keyId);
    return key;
  }

  // Key material lives in private fields; these keep accidental logging safe.
  toString(): string {
    return `EnvKeyProvider(active=${this.#active}, keys=${this.keyIds().join(",")})`;
  }

  toJSON(): { activeKeyId: string; keyIds: string[] } {
    return { activeKeyId: this.#active, keyIds: this.keyIds() };
  }
}

function wrapAad(keyId: string, context: EncryptionContext): Buffer {
  return serializeContext({ ...context, "afe.kek": keyId });
}

/** Parses `AFE_ENCRYPTION_KEY` content into key id -> key. */
export function parseKeyList(raw: string): Map<string, Buffer> {
  const items = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const keys = new Map<string, Buffer>();
  if (items.length === 1 && !items[0]!.includes(":")) {
    keys.set(DEFAULT_KEY_ID, decodeKey(items[0]!, DEFAULT_KEY_ID));
    return keys;
  }
  for (const item of items) {
    const sep = item.indexOf(":");
    if (sep <= 0) throw new Error("encryption key list entries must look like `id:key`");
    const id = item.slice(0, sep).trim();
    if (!KEY_ID_PATTERN.test(id)) throw new Error(`invalid encryption key id: ${id}`);
    if (keys.has(id)) throw new Error(`duplicate encryption key id: ${id}`);
    keys.set(id, decodeKey(item.slice(sep + 1).trim(), id));
  }
  return keys;
}

function decodeKey(encoded: string, id: string): Buffer {
  let key = Buffer.alloc(0);
  if (/^[0-9a-fA-F]{64}$/.test(encoded)) key = Buffer.from(encoded, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    // Never include the key material in the message.
    throw new Error(`encryption key ${id} must be 32 bytes, base64 or hex encoded`);
  }
  return key;
}

/** Generates a new random 256-bit key, base64 encoded, for `AFE_ENCRYPTION_KEY`. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
