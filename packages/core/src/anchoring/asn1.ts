/**
 * Minimal ASN.1 DER encoder and reader: just enough for RFC 3161 time-stamp
 * requests and responses (no dependency). Definite lengths only (DER); BER
 * indefinite lengths are rejected.
 */

export class Asn1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Asn1Error";
  }
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

// --- Encoder -------------------------------------------------------------------

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const der = {
  sequence: (...items: Uint8Array[]) => tlv(TAG.SEQUENCE, Buffer.concat(items)),
  set: (...items: Uint8Array[]) => tlv(TAG.SET, Buffer.concat(items)),
  null: () => Buffer.from([TAG.NULL, 0]),
  boolean: (v: boolean) => Buffer.from([TAG.BOOLEAN, 1, v ? 0xff : 0]),
  octetString: (b: Uint8Array) => tlv(TAG.OCTET_STRING, b),
  utf8String: (s: string) => tlv(TAG.UTF8_STRING, Buffer.from(s, "utf8")),
  generalizedTime: (d: Date) =>
    tlv(
      TAG.GENERALIZED_TIME,
      Buffer.from(
        d
          .toISOString()
          .replace(/[-:T]/g, "")
          .replace(/\.000Z$/, "Z"),
      ),
    ),
  /** Explicitly tagged context-specific [n] (constructed). */
  explicit: (n: number, ...items: Uint8Array[]) => tlv(0xa0 | n, Buffer.concat(items)),
  /** A non-negative INTEGER from big-endian unsigned bytes or a small number. */
  integer: (v: number | Uint8Array) => {
    let b: Buffer;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || v < 0) throw new Asn1Error("integer must be >= 0");
      const bytes: number[] = [];
      for (let x = v; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff);
      b = Buffer.from(bytes.length ? bytes : [0]);
    } else {
      b = Buffer.from(v);
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i++;
      b = b.subarray(i);
      if (b.length === 0) b = Buffer.from([0]);
    }
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return tlv(TAG.INTEGER, b);
  },
  oid: (dotted: string) => {
    const parts = dotted.split(".").map(Number);
    if (parts.length < 2 || parts.some((p) => !Number.isSafeInteger(p) || p < 0))
      throw new Asn1Error(`invalid OID ${dotted}`);
    const out: number[] = [parts[0]! * 40 + parts[1]!];
    for (const p of parts.slice(2)) {
      const chunk: number[] = [p & 0x7f];
      for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128))
        chunk.unshift(0x80 | (v & 0x7f));
      out.push(...chunk);
    }
    return tlv(TAG.OID, Buffer.from(out));
  },
};

// --- Reader ----------------------------------------------------------------------

export interface Asn1Node {
  tag: number;
  /** Offset of the tag byte in the buffer. */
  offset: number;
  /** Content bytes. */
  content: Buffer;
  /** Total encoded length (header + content). */
  length: number;
}

/** Reads one TLV at `offset`. */
export function readNode(buf: Buffer, offset = 0): Asn1Node {
  if (offset + 2 > buf.length) throw new Asn1Error("truncated DER");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new Asn1Error("high tag numbers are not supported");
  let len = buf[offset + 1]!;
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new Asn1Error("indefinite length is not DER");
    if (n > 4 || offset + 2 + n > buf.length) throw new Asn1Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i]!;
    header += n;
  }
  const start = offset + header;
  if (start + len > buf.length) throw new Asn1Error("truncated DER");
  return { tag, offset, content: buf.subarray(start, start + len), length: header + len };
}

/** Parses a whole buffer as exactly one TLV. */
export function readRoot(buf: Buffer): Asn1Node {
  const node = readNode(buf, 0);
  if (node.length !== buf.length) throw new Asn1Error("trailing bytes after DER value");
  return node;
}

/** The child TLVs of a constructed node. */
export function children(node: Asn1Node): Asn1Node[] {
  const out: Asn1Node[] = [];
  let pos = 0;
  while (pos < node.content.length) {
    const child = readNode(node.content, pos);
    out.push(child);
    pos += child.length;
  }
  return out;
}

export function expectTag(node: Asn1Node | undefined, tag: number, what: string): Asn1Node {
  if (!node || node.tag !== tag) throw new Asn1Error(`expected ${what}`);
  return node;
}

export function decodeOid(node: Asn1Node): string {
  expectTag(node, TAG.OID, "OBJECT IDENTIFIER");
  const b = node.content;
  if (b.length === 0) throw new Asn1Error("empty OID");
  const parts: number[] = [];
  const first = b[0]!;
  parts.push(first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80);
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

/** INTEGER as a non-negative safe number (throws if too large or negative). */
export function decodeSmallInteger(node: Asn1Node): number {
  expectTag(node, TAG.INTEGER, "INTEGER");
  if (node.content.length === 0 || node.content[0]! & 0x80) throw new Asn1Error("negative INTEGER");
  if (node.content.length > 6) throw new Asn1Error("INTEGER too large");
  let v = 0;
  for (const byte of node.content) v = v * 256 + byte;
  return v;
}

/** INTEGER as unsigned big-endian hex (leading zero bytes removed). */
export function decodeIntegerHex(node: Asn1Node): string {
  expectTag(node, TAG.INTEGER, "INTEGER");
  let b = node.content;
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  return b.toString("hex");
}

/** GeneralizedTime (YYYYMMDDHHMMSS[.f*]Z) as an ISO 8601 string. */
export function decodeGeneralizedTime(node: Asn1Node): string {
  expectTag(node, TAG.GENERALIZED_TIME, "GeneralizedTime");
  const s = node.content.toString("latin1");
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new Asn1Error("unsupported GeneralizedTime");
  const ms = (m[7] ?? "").padEnd(3, "0").slice(0, 3);
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
  if (Number.isNaN(Date.parse(iso))) throw new Asn1Error("invalid GeneralizedTime");
  return new Date(iso).toISOString();
}
