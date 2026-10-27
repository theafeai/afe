/**
 * RFC 3161 Time-Stamp Protocol: request encoding and response/token parsing.
 * https://www.rfc-editor.org/rfc/rfc3161 (sections 2.4.1, 2.4.2), CMS
 * SignedData: https://www.rfc-editor.org/rfc/rfc5652.
 *
 * What is checked here: the response status, that the token is CMS
 * SignedData carrying a TSTInfo, and the TSTInfo message imprint (SHA-256)
 * and nonce. The TSA's CMS signature and certificate chain are NOT verified
 * by Afe; auditors verify them with `openssl ts -verify` against the TSA's CA
 * (docs/export-verification.md "Chain anchors").
 */
import {
  Asn1Error,
  children,
  decodeGeneralizedTime,
  decodeIntegerHex,
  decodeOid,
  decodeSmallInteger,
  der,
  expectTag,
  readRoot,
  TAG,
  type Asn1Node,
} from "./asn1.ts";

export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
export const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
export const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";

export interface TimeStampRequestOptions {
  /** SHA-256 digest of the data to timestamp (32 bytes). */
  digest: Uint8Array;
  /** Random nonce (unsigned big-endian bytes). */
  nonce?: Uint8Array;
  /** Ask the TSA to include its certificate (default true, so the token can be verified later). */
  certReq?: boolean;
  /** Requested TSA policy OID. */
  policy?: string;
}

/** DER TimeStampReq (RFC 3161 2.4.1), version 1, SHA-256 imprint. */
export function encodeTimeStampRequest(o: TimeStampRequestOptions): Buffer {
  if (o.digest.length !== 32) throw new Error("SHA-256 digest must be 32 bytes");
  const parts: Uint8Array[] = [
    der.integer(1),
    der.sequence(der.sequence(der.oid(OID_SHA256), der.null()), der.octetString(o.digest)),
  ];
  if (o.policy) parts.push(der.oid(o.policy));
  if (o.nonce) parts.push(der.integer(o.nonce));
  if (o.certReq ?? true) parts.push(der.boolean(true));
  return der.sequence(...parts);
}

export interface TstInfo {
  policy: string;
  hashAlgorithm: string;
  /** Hex of the hashed message in the token. */
  hashedMessage: string;
  serialNumber: string;
  genTime: string;
  /** Hex of the nonce, or null when absent. */
  nonce: string | null;
}

export interface TimeStampResponse {
  /** PKIStatus: 0 granted, 1 grantedWithMods, 2 rejection, 3 waiting, 4/5 revocation. */
  status: number;
  statusText: string | null;
  /** DER TimeStampToken (ContentInfo), when granted. */
  token: Buffer | null;
}

export class TimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimestampError";
  }
}

function wrap<T>(f: () => T, what: string): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof Asn1Error) throw new TimestampError(`${what}: ${err.message}`);
    throw err;
  }
}

/** Parses a DER TimeStampResp (RFC 3161 2.4.2). */
export function parseTimeStampResponse(der: Uint8Array): TimeStampResponse {
  return wrap(() => {
    const root = expectTag(readRoot(Buffer.from(der)), TAG.SEQUENCE, "TimeStampResp");
    const [statusInfo, token] = children(root);
    const si = children(expectTag(statusInfo, TAG.SEQUENCE, "PKIStatusInfo"));
    const status = decodeSmallInteger(si[0]!);
    let statusText: string | null = null;
    if (si[1]?.tag === TAG.SEQUENCE) {
      statusText = children(si[1])
        .filter((n) => n.tag === TAG.UTF8_STRING)
        .map((n) => n.content.toString("utf8"))
        .join("; ")
        .slice(0, 200);
    }
    const tokenBytes = token
      ? Buffer.from(root.content.subarray(token.offset, token.offset + token.length))
      : null;
    return { status, statusText, token: tokenBytes };
  }, "invalid TimeStampResp");
}

/** Extracts the TSTInfo from a DER TimeStampToken (CMS SignedData). */
export function parseTimeStampToken(token: Uint8Array): TstInfo {
  return wrap(() => {
    const ci = children(expectTag(readRoot(Buffer.from(token)), TAG.SEQUENCE, "ContentInfo"));
    if (decodeOid(ci[0]!) !== OID_SIGNED_DATA) throw new Asn1Error("token is not SignedData");
    const content = children(expectTag(ci[1], 0xa0, "[0] content"));
    const sd = children(expectTag(content[0], TAG.SEQUENCE, "SignedData"));
    const encap = children(expectTag(sd[2], TAG.SEQUENCE, "EncapsulatedContentInfo"));
    if (decodeOid(encap[0]!) !== OID_TST_INFO) throw new Asn1Error("content is not TSTInfo");
    const e = children(expectTag(encap[1], 0xa0, "[0] eContent"));
    const octets = expectTag(e[0], TAG.OCTET_STRING, "eContent OCTET STRING");
    return parseTstInfo(readRoot(Buffer.from(octets.content)));
  }, "invalid TimeStampToken");
}

function parseTstInfo(node: Asn1Node): TstInfo {
  const f = children(expectTag(node, TAG.SEQUENCE, "TSTInfo"));
  const policy = decodeOid(f[1]!);
  const mi = children(expectTag(f[2], TAG.SEQUENCE, "MessageImprint"));
  const alg = children(expectTag(mi[0], TAG.SEQUENCE, "AlgorithmIdentifier"));
  const hashAlgorithm = decodeOid(alg[0]!);
  const hashedMessage = expectTag(mi[1], TAG.OCTET_STRING, "hashedMessage").content.toString("hex");
  const serialNumber = decodeIntegerHex(f[3]!);
  const genTime = decodeGeneralizedTime(f[4]!);
  let nonce: string | null = null;
  for (const n of f.slice(5)) {
    if (n.tag === TAG.INTEGER) {
      nonce = decodeIntegerHex(n);
      break;
    }
  }
  return { policy, hashAlgorithm, hashedMessage, serialNumber, genTime, nonce };
}

export type TimestampCheck =
  | { ok: true; tstInfo: TstInfo }
  | { ok: false; code: "timestamp_malformed" | "timestamp_imprint_mismatch"; message: string };

/** Checks that a token's message imprint is SHA-256 of the expected data (hex digest). */
export function checkTimeStampToken(
  token: Uint8Array,
  expectedDigestHex: string,
  expectedNonceHex?: string,
): TimestampCheck {
  let tst: TstInfo;
  try {
    tst = parseTimeStampToken(token);
  } catch (err) {
    return { ok: false, code: "timestamp_malformed", message: (err as Error).message };
  }
  if (tst.hashAlgorithm !== OID_SHA256) {
    return {
      ok: false,
      code: "timestamp_imprint_mismatch",
      message: `timestamp uses hash algorithm ${tst.hashAlgorithm}, expected SHA-256`,
    };
  }
  if (tst.hashedMessage !== expectedDigestHex) {
    return {
      ok: false,
      code: "timestamp_imprint_mismatch",
      message: "timestamp message imprint does not match the checkpoint",
    };
  }
  if (expectedNonceHex !== undefined && tst.nonce !== expectedNonceHex.replace(/^(00)+(?=.)/, "")) {
    return { ok: false, code: "timestamp_malformed", message: "timestamp nonce does not match" };
  }
  return { ok: true, tstInfo: tst };
}

/** Parses a DER TimeStampReq: the imprint digest and nonce (fakes and tests). */
export function parseTimeStampRequest(req: Uint8Array): { digest: Buffer; nonce: Buffer | null } {
  return wrap(() => {
    const f = children(expectTag(readRoot(Buffer.from(req)), TAG.SEQUENCE, "TimeStampReq"));
    const mi = children(expectTag(f[1], TAG.SEQUENCE, "MessageImprint"));
    const digest = Buffer.from(expectTag(mi[1], TAG.OCTET_STRING, "hashedMessage").content);
    const n = f.slice(2).find((x) => x.tag === TAG.INTEGER);
    return { digest, nonce: n ? Buffer.from(n.content) : null };
  }, "invalid TimeStampReq");
}

/**
 * Builds a structurally valid TimeStampResp for tests and fakes. The CMS
 * signature is a placeholder: it is not a real TSA token.
 */
export function buildFakeTimeStampResponse(o: {
  digest: Uint8Array;
  nonce?: Uint8Array | null;
  genTime?: Date;
  status?: number;
  policy?: string;
  serial?: number;
}): Buffer {
  const status = o.status ?? 0;
  const statusInfo = der.sequence(der.integer(status));
  if (status > 1) return der.sequence(statusInfo);
  const tst = der.sequence(
    der.integer(1),
    der.oid(o.policy ?? "1.3.6.1.4.1.4146.2.3"),
    der.sequence(der.sequence(der.oid(OID_SHA256), der.null()), der.octetString(o.digest)),
    der.integer(o.serial ?? 1),
    der.generalizedTime(o.genTime ?? new Date()),
    ...(o.nonce ? [der.integer(o.nonce)] : []),
  );
  const signedData = der.sequence(
    der.integer(3),
    der.set(der.sequence(der.oid(OID_SHA256), der.null())),
    der.sequence(der.oid(OID_TST_INFO), der.explicit(0, der.octetString(tst))),
    der.set(), // signerInfos: placeholder (not a real signature)
  );
  const token = der.sequence(der.oid(OID_SIGNED_DATA), der.explicit(0, signedData));
  return der.sequence(statusInfo, token);
}
