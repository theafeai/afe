/**
 * Canonical JSON serialisation following RFC 8785 (JSON Canonicalization
 * Scheme, "JCS"): https://www.rfc-editor.org/rfc/rfc8785
 *
 * Used for stable keys and fingerprints (query cursor fingerprints,
 * correlation containment values, ArgoCD state digests).
 *
 * - Object members are sorted by their names compared as UTF-16 code units.
 * - Numbers use the ECMAScript `Number.prototype.toString` form (what
 *   `JSON.stringify` emits for finite numbers), which is what JCS mandates.
 * - Strings use `JSON.stringify` escaping, which matches JCS.
 * - No insignificant whitespace.
 *
 * Deviations / restrictions (all reject rather than silently change data):
 * - `undefined` object members are omitted (as `JSON.stringify` does) so that
 *   optional TypeScript fields serialise the same whether absent or `undefined`.
 * - `undefined` in arrays, non-finite numbers, bigint, functions, symbols,
 *   lone UTF-16 surrogates and non-plain objects (Date, Map, class
 *   instances...) throw a `CanonicalJsonError`.
 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalJson(value: unknown): string {
  return serialise(value, "$");
}

function serialise(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "string":
      if (hasLoneSurrogate(value)) {
        throw new CanonicalJsonError(`lone surrogate in string at ${path}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    const parts = value.map((item, i) => {
      if (item === undefined) throw new CanonicalJsonError(`undefined at ${path}[${i}]`);
      return serialise(item, `${path}[${i}]`);
    });
    return `[${parts.join(",")}]`;
  }

  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError(`non-plain object at ${path}`);
  }
  const obj = value as Record<string, unknown>;
  // Default sort compares UTF-16 code units, exactly as RFC 8785 §3.2.3 requires.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => {
    if (hasLoneSurrogate(k)) throw new CanonicalJsonError(`lone surrogate in key at ${path}`);
    return `${JSON.stringify(k)}:${serialise(obj[k], `${path}.${k}`)}`;
  });
  return `{${parts.join(",")}}`;
}

// With the `u` flag, a surrogate range only matches unpaired surrogates.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** True if `s` contains an unpaired UTF-16 surrogate (not valid Unicode). */
export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}
