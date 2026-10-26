import { describe, expect, it } from "vitest";
import { canonicalJson, CanonicalJsonError } from "../src/index.ts";

describe("canonicalJson (RFC 8785)", () => {
  it("matches the RFC 8785 §3.2.2 example", () => {
    // Input from RFC 8785 §3.2.2 (parsed by JSON.parse, as JCS assumes).
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        ' "literals": [null, true, false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    // JSON.parse would re-order integer-like keys, so read the serialised order.
    const order = [...canonicalJson(input).matchAll(/"([^"]+)"(?=,|\})/g)].map((m) => m[1]);
    expect(order).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
  });

  it("is independent of key insertion order and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, 2] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: { d: [1, 2] } })).toBe('{"a":{"d":[1,2]},"b":1}');
  });

  it("serialises -0 as 0", () => {
    expect(canonicalJson(-0)).toBe("0");
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["bigint", 1n],
    ["Date", new Date(0)],
    ["undefined in array", [undefined]],
    ["lone surrogate", "\ud800"],
    ["function", () => 1],
  ])("rejects %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });
});
