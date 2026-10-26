/**
 * Ed25519 signing of export manifests (RFC 8032). The signed bytes are
 * UTF-8(JCS(manifest without `signature`)). Keys:
 *
 * - private key (`AFE_EXPORT_SIGNING_KEY`): a PKCS#8 PEM, or the 32-byte seed
 *   as base64url/base64 (43/44 chars) or hex (64 chars);
 * - public key: the raw 32 bytes, base64url; `keyId` = first 16 hex chars of
 *   SHA-256(raw public key).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "../canonical-json.ts";
import type { ExportManifest, ExportSigner } from "./types.ts";

// DER prefixes for Ed25519 keys (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class ExportSigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportSigningKeyError";
  }
}

function decodeSeed(text: string): Buffer {
  const s = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9_-]{43}$/.test(s)) return Buffer.from(s, "base64url");
  if (/^[A-Za-z0-9+/]{43}=$/.test(s)) return Buffer.from(s, "base64");
  throw new ExportSigningKeyError(
    "export signing key must be a PKCS#8 PEM or a 32-byte Ed25519 seed (base64url, base64 or hex)",
  );
}

function privateKeyFrom(material: string): KeyObject {
  let key: KeyObject;
  try {
    key = material.includes("-----BEGIN")
      ? createPrivateKey(material)
      : createPrivateKey({
          key: Buffer.concat([PKCS8_PREFIX, decodeSeed(material)]),
          format: "der",
          type: "pkcs8",
        });
  } catch (err) {
    if (err instanceof ExportSigningKeyError) throw err;
    // Never echo the key material.
    throw new ExportSigningKeyError("export signing key could not be parsed");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new ExportSigningKeyError("export signing key must be an Ed25519 key");
  }
  return key;
}

export function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32);
}

export function exportKeyId(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("hex")
    .slice(0, 16);
}

/** Ed25519 manifest signer from key material (see module docs for accepted forms). */
export function createEd25519ExportSigner(material: string): ExportSigner {
  const key = privateKeyFrom(material);
  const publicKey = rawPublicKey(createPublicKey(key)).toString("base64url");
  return {
    algorithm: "ed25519",
    keyId: exportKeyId(publicKey),
    publicKey,
    sign: (data) => cryptoSign(null, data, key).toString("base64url"),
  };
}

/** Signer from `AFE_EXPORT_SIGNING_KEY`, or null when it is not set (exports are then unsigned). */
export function exportSignerFromEnv(env: NodeJS.ProcessEnv = process.env): ExportSigner | null {
  const material = env.AFE_EXPORT_SIGNING_KEY;
  return material && material.trim() ? createEd25519ExportSigner(material) : null;
}

/** Generates a new signing key: the seed for AFE_EXPORT_SIGNING_KEY and the public key to publish. */
export function generateExportSigningKey(): {
  privateKey: string;
  publicKey: string;
  keyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const pub = rawPublicKey(publicKey).toString("base64url");
  return {
    privateKey: der.subarray(der.length - 32).toString("base64url"),
    publicKey: pub,
    keyId: exportKeyId(pub),
  };
}

/** The exact bytes a manifest signature covers. */
export function manifestSigningInput(manifest: ExportManifest): Uint8Array {
  const { signature: _sig, ...unsigned } = manifest;
  return new TextEncoder().encode(canonicalJson(unsigned));
}

export async function signManifest(
  manifest: ExportManifest,
  signer: ExportSigner,
): Promise<ExportManifest> {
  const { signature: _sig, ...unsigned } = manifest;
  const value = await signer.sign(manifestSigningInput(unsigned));
  return {
    ...unsigned,
    signature: {
      algorithm: signer.algorithm,
      keyId: signer.keyId,
      publicKey: signer.publicKey,
      value,
    },
  };
}

/**
 * Normalises a public key given as raw base64url/base64 (32 bytes) or an
 * SPKI PEM to the raw base64url form used in manifests.
 */
export function normaliseExportPublicKey(text: string): string {
  const s = text.trim();
  try {
    if (s.includes("-----BEGIN")) {
      const key = createPublicKey(s);
      if (key.asymmetricKeyType === "ed25519") return rawPublicKey(key).toString("base64url");
    } else {
      const b64url = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const raw = Buffer.from(b64url, "base64url");
      if (raw.length === 32) return raw.toString("base64url");
    }
  } catch {
    // fall through
  }
  throw new ExportSigningKeyError(
    "public key must be a raw 32-byte Ed25519 key (base64url) or an SPKI PEM",
  );
}

/** Verifies an Ed25519 signature with a raw base64url public key. Never throws. */
export function verifyEd25519(publicKey: string, data: Uint8Array, signature: string): boolean {
  try {
    const raw = Buffer.from(publicKey, "base64url");
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, data, key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
