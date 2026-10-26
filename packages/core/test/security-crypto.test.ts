import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  DecryptionError,
  EnvKeyProvider,
  Secret,
  UnknownKeyError,
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  parseKeyList,
} from "../src/index.ts";

const binding = { tenantId: "tenant-a", credentialId: "cred-1" };

function provider(ids: string[] = ["k1"], active?: string): EnvKeyProvider {
  return new EnvKeyProvider({
    keys: new Map(ids.map((id) => [id, randomBytes(32)])),
    activeKeyId: active,
  });
}

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and returns a Secret", async () => {
    const keys = provider();
    const enc = await encryptSecret(keys, "ghp_example", binding);
    expect(enc.keyId).toBe("k1");
    expect(enc.nonce).toHaveLength(12);
    expect(enc.ciphertext.toString("utf8")).not.toContain("ghp_example");
    const dec = await decryptSecret(keys, enc, binding);
    expect(dec).toBeInstanceOf(Secret);
    expect(dec.reveal()).toBe("ghp_example");
  });

  it("accepts a Secret as input and uses fresh nonces and data keys", async () => {
    const keys = provider();
    const a = await encryptSecret(keys, new Secret("same"), binding);
    const b = await encryptSecret(keys, "same", binding);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedKey.equals(b.wrappedKey)).toBe(false);
  });

  it("detects tampering with ciphertext, tag, nonce or wrapped key", async () => {
    const keys = provider();
    const enc = await encryptSecret(keys, "value", binding);
    const flip = (buf: Buffer, i: number) => {
      const c = Buffer.from(buf);
      c[i] = c[i]! ^ 1;
      return c;
    };
    const variants = [
      { ...enc, ciphertext: flip(enc.ciphertext, 0) },
      { ...enc, ciphertext: flip(enc.ciphertext, enc.ciphertext.length - 1) },
      { ...enc, ciphertext: enc.ciphertext.subarray(0, 4) },
      { ...enc, nonce: flip(enc.nonce, 0) },
      { ...enc, nonce: enc.nonce.subarray(0, 8) },
      { ...enc, wrappedKey: flip(enc.wrappedKey, 20) },
      { ...enc, wrappedKey: enc.wrappedKey.subarray(0, 10) },
    ];
    for (const v of variants) {
      await expect(decryptSecret(keys, v, binding)).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it("binds ciphertext to the tenant and credential id (AAD)", async () => {
    const keys = provider();
    const enc = await encryptSecret(keys, "value", binding);
    await expect(
      decryptSecret(keys, enc, { tenantId: "tenant-b", credentialId: "cred-1" }),
    ).rejects.toBeInstanceOf(DecryptionError);
    await expect(
      decryptSecret(keys, enc, { tenantId: "tenant-a", credentialId: "cred-2" }),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects a data key swapped in from another credential", async () => {
    const keys = provider();
    const a = await encryptSecret(keys, "a", binding);
    const b = await encryptSecret(keys, "b", { tenantId: "tenant-b", credentialId: "cred-9" });
    await expect(
      decryptSecret(keys, { ...a, wrappedKey: b.wrappedKey }, binding),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects a ciphertext relabelled with another key id", async () => {
    const keys = provider(["k1", "k2"]);
    const enc = await encryptSecret(keys, "v", binding);
    await expect(decryptSecret(keys, { ...enc, keyId: "k2" }, binding)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("fails with UnknownKeyError for a key the provider does not hold", async () => {
    const enc = await encryptSecret(provider(["old"]), "v", binding);
    await expect(decryptSecret(provider(["new"]), enc, binding)).rejects.toBeInstanceOf(
      UnknownKeyError,
    );
  });

  it("does not leak plaintext in error messages", async () => {
    const keys = provider();
    const enc = await encryptSecret(keys, "super-secret-value", binding);
    const err = await decryptSecret(keys, enc, { ...binding, tenantId: "x" }).catch((e) => e);
    expect(String(err.message)).not.toContain("super-secret-value");
  });

  it("requires tenant and credential ids", async () => {
    await expect(
      encryptSecret(provider(), "v", { tenantId: "", credentialId: "c" }),
    ).rejects.toThrow(/tenantId/);
  });
});

describe("EnvKeyProvider and key rotation", () => {
  it("encrypts with the active key and decrypts with older keys", async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const before = new EnvKeyProvider({ keys: { k1 } });
    const enc = await encryptSecret(before, "v", binding);
    const after = new EnvKeyProvider({ keys: { k1, k2 }, activeKeyId: "k2" });
    expect(after.activeKeyId()).toBe("k2");
    expect((await decryptSecret(after, enc, binding)).reveal()).toBe("v");
    const reenc = await encryptSecret(after, "v", binding);
    expect(reenc.keyId).toBe("k2");
    const onlyNew = new EnvKeyProvider({ keys: { k2 } });
    expect((await decryptSecret(onlyNew, reenc, binding)).reveal()).toBe("v");
  });

  it("supports an explicit key id for encryption", async () => {
    const keys = provider(["k1", "k2"], "k1");
    expect((await encryptSecret(keys, "v", binding, "k2")).keyId).toBe("k2");
  });

  it("validates configuration", () => {
    expect(() => new EnvKeyProvider({ keys: {} })).toThrow();
    expect(() => new EnvKeyProvider({ keys: { k1: randomBytes(16) } })).toThrow(/32 bytes/);
    expect(() => new EnvKeyProvider({ keys: { "bad id": randomBytes(32) } })).toThrow(/key id/);
    expect(() => new EnvKeyProvider({ keys: { k1: randomBytes(32) }, activeKeyId: "k9" })).toThrow(
      /active/,
    );
  });

  it("reads a single bare key from AFE_ENCRYPTION_KEY", () => {
    const keys = EnvKeyProvider.fromEnv({ AFE_ENCRYPTION_KEY: generateEncryptionKey() });
    expect(keys.activeKeyId()).toBe("default");
  });

  it("reads an id:key list with an explicit active key, base64 or hex", () => {
    const list = `2025:${randomBytes(32).toString("hex")}, 2026:${generateEncryptionKey()}`;
    const keys = EnvKeyProvider.fromEnv({
      AFE_ENCRYPTION_KEY: list,
      AFE_ENCRYPTION_ACTIVE_KEY_ID: "2026",
    });
    expect(keys.keyIds()).toEqual(["2025", "2026"]);
    expect(keys.activeKeyId()).toBe("2026");
    expect(EnvKeyProvider.fromEnv({ AFE_ENCRYPTION_KEY: list }).activeKeyId()).toBe("2025");
  });

  it("reads keys from AFE_ENCRYPTION_KEY_FILE", () => {
    const content = `a:${generateEncryptionKey()}\nb:${generateEncryptionKey()}\n`;
    const keys = EnvKeyProvider.fromEnv({ AFE_ENCRYPTION_KEY_FILE: "/run/secrets/afe" }, (p) => {
      expect(p).toBe("/run/secrets/afe");
      return content;
    });
    expect(keys.keyIds()).toEqual(["a", "b"]);
  });

  it("rejects missing, ambiguous and malformed configuration without echoing key material", () => {
    expect(() => EnvKeyProvider.fromEnv({})).toThrow(/AFE_ENCRYPTION_KEY/);
    expect(() =>
      EnvKeyProvider.fromEnv({ AFE_ENCRYPTION_KEY: "x", AFE_ENCRYPTION_KEY_FILE: "/f" }),
    ).toThrow(/only one/);
    const short = "c2hvcnRrZXk=";
    try {
      parseKeyList(short);
      expect.fail("should throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
    }
    expect(() => parseKeyList(`a:${generateEncryptionKey()},a:${generateEncryptionKey()}`)).toThrow(
      /duplicate/,
    );
  });

  it("never reveals key material when logged or serialised", () => {
    const key = randomBytes(32);
    const keys = new EnvKeyProvider({ keys: { k1: key } });
    const rendered = [String(keys), JSON.stringify(keys), JSON.stringify({ keys })].join(" ");
    expect(rendered).not.toContain(key.toString("base64"));
    expect(rendered).not.toContain(key.toString("hex"));
    expect(JSON.stringify(keys)).toBe('{"activeKeyId":"k1","keyIds":["k1"]}');
  });
});
