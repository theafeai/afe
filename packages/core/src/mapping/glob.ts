/**
 * Glob patterns for mapping rules: `*` matches any run of characters
 * (including none, and including `/`), `?` exactly one character; everything
 * else is literal. The whole value must match. Matching is iterative
 * (single backtrack point at the last `*`), so it runs in O(value × pattern)
 * time whatever the pattern; it never compiles to a backtracking RegExp.
 */
import { MAX_INPUT_LENGTH, MAX_PATTERN_LENGTH } from "./safe-regex.ts";

export class GlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobError";
  }
}

export interface Glob {
  readonly source: string;
  test(value: string): boolean;
}

function fold(s: string, ignoreCase: boolean): string[] {
  return [...(ignoreCase ? s.toLowerCase() : s)];
}

export function compileGlob(pattern: string, options: { ignoreCase?: boolean } = {}): Glob {
  if (pattern.length === 0) throw new GlobError("pattern is empty");
  if ([...pattern].length > MAX_PATTERN_LENGTH) {
    throw new GlobError(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  const ignoreCase = options.ignoreCase ?? false;
  // Collapse runs of `*` (equivalent, and keeps the scan simple).
  const p = fold(pattern, ignoreCase).filter((c, i, a) => !(c === "*" && a[i - 1] === "*"));
  return {
    source: pattern,
    test(value) {
      const v = fold(value, ignoreCase).slice(0, MAX_INPUT_LENGTH);
      let i = 0;
      let j = 0;
      let star = -1;
      let mark = 0;
      while (i < v.length) {
        if (j < p.length && (p[j] === "?" || (p[j] !== "*" && p[j] === v[i]))) {
          i++;
          j++;
        } else if (j < p.length && p[j] === "*") {
          star = j++;
          mark = i;
        } else if (star >= 0) {
          j = star + 1;
          i = ++mark;
        } else return false;
      }
      while (j < p.length && p[j] === "*") j++;
      return j === p.length;
    },
  };
}
